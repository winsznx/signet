#!/usr/bin/env node
/**
 * Fails the build if anything that looks like key material reaches tracked files.
 *
 * Signet treats a leaked seed or private key as total loss, so this runs on every phase gate.
 *
 * The hard problem is that an EVM private key and a sha256 digest are the same shape: 64 hex
 * characters. Shape alone cannot separate them. So instead of guessing, this builds an allowlist
 * of the exact digests that are legitimately committed - every 64-hex string that appears as a
 * value inside the machine-readable artefacts that are supposed to contain hashes - and fails on
 * any other 64-hex token anywhere in tracked files. A private key is never a value in the source
 * lock, so it cannot inherit the allowlist.
 *
 * XRPL family seeds are checked by decoding base58check and verifying the checksum and type
 * prefix, not by a regex, which removes both the false positives and the false negatives of
 * pattern matching.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { REPO_ROOT } from "./lib/source-lock.mjs";

/** Files this scanner must not scan: it necessarily contains the patterns it hunts for. */
const SELF_PATHS = new Set(["scripts/secret-scan.mjs", "scripts/secret-scan.sh", "scripts/secret-scan.test.sh"]);

/**
 * Machine-generated artefacts whose 64-hex values are protocol data: content hashes, runtime code
 * hashes, checksums, chain identifiers. The invariant this encodes is that nobody hand-writes a
 * 64-hex blob into this repository that is not already recorded here by a script. A private key
 * cannot inherit that cover, because no Signet script ever writes private material to any of them.
 */
const HASH_SOURCES = [
  "docs/source-lock.json",
  "toolchain.lock",
  "deployments/coston2.json",
  "evidence/claim-ledger.json",
  "docs/protocol-seams/fassets-access-probe.json",
  "docs/protocol-seams/fassets-seam-evidence.json",
  // The decision fixtures hold commitment hashes, payment references and code hashes. Including
  // them here would normally weaken the rule, because a secret written into an allowlisted file
  // self-allows. It does not here: this file is regenerated from decide() and byte-compared against
  // a fresh build on every gate run, so a hand-inserted value fails `make fixtures-check` before it
  // can reach this scanner. Reproducibility is what makes it safe to trust.
  "reference/test-vectors/decision-fixtures.json",
];

/**
 * Published protocol constants that are 64-hex by construction and carry no secrecy.
 * Each one must be justified, not merely convenient.
 */
const PROTOCOL_CONSTANTS = new Map([
  ["360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "EIP-1967 implementation storage slot"],
]);

const BINARY_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|avif|ico|pdf|woff2?|ttf|otf|zip|gz|tgz|wasm|so|dylib|node)$/i;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

const findings = [];

function record(rule, path, line, detail) {
  findings.push({ rule, path, line, detail });
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const trackedPaths = git(["ls-files", "-z"]).split("\0").filter(Boolean);

// ---------------------------------------------------------------- allowlisted digests

function collectHexValues(node, out) {
  if (typeof node === "string") {
    // Must match the same shape the scanner looks for, including the 0x prefix: \b does not
    // split "0x" from the digits that follow it, so a \b-anchored pattern silently misses them.
    for (const match of node.matchAll(/(?:0x)?([0-9a-fA-F]{64})/g)) out.add(match[1].toLowerCase());
  } else if (Array.isArray(node)) {
    for (const item of node) collectHexValues(item, out);
  } else if (node && typeof node === "object") {
    for (const value of Object.values(node)) collectHexValues(value, out);
  }
}

const allowedDigests = new Set();
for (const relative of HASH_SOURCES) {
  try {
    collectHexValues(JSON.parse(readFileSync(join(REPO_ROOT, relative), "utf8")), allowedDigests);
  } catch {
    // A missing artefact is not an error here; the source-lock gate owns that check.
  }
}

// ---------------------------------------------------------------- base58check for XRPL seeds

const BASE58_XRPL = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

function base58XrplDecode(text) {
  let value = 0n;
  for (const char of text) {
    const index = BASE58_XRPL.indexOf(char);
    if (index < 0) return null;
    value = value * 58n + BigInt(index);
  }
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = Buffer.from(hex, "hex");
  for (const char of text) {
    if (char !== BASE58_XRPL[0]) break;
    bytes = Buffer.concat([Buffer.from([0]), bytes]);
  }
  return bytes;
}

/**
 * True when `text` decodes as a valid XRPL base58check payload with a seed type prefix.
 * Type 33 is a family seed, type 1 is an account private key, type 32 is a node private key.
 */
function isXrplSecret(text) {
  const raw = base58XrplDecode(text);
  if (!raw || raw.length < 5) return false;
  const body = raw.subarray(0, raw.length - 4);
  const checksum = raw.subarray(raw.length - 4);
  const expected = createHash("sha256").update(createHash("sha256").update(body).digest()).digest().subarray(0, 4);
  if (!checksum.equals(expected)) return false;
  return body[0] === 33 || body[0] === 1 || body[0] === 32;
}

// ---------------------------------------------------------------- content rules

const KEYWORD_ASSIGNMENT =
  /(private[_-]?key|privatekey|secret[_-]?key|secretkey|signing[_-]?key|deployer[_-]?key|master[_-]?seed|seed[_-]?phrase|mnemonic|passphrase|api[_-]?key)[^\S\n]*[:=][^\S\n]*["']?([^\s"',;]{16,})/i;

const PLACEHOLDER =
  /^(<|\$\{|process\.env|env\.|0x?\.{2,}|x{8,}|redacted|placeholder|example|changeme|your[_-]|\.{3}|123\.{2,}|"?\+)/i;

const CREDENTIAL_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, "aws access key id"],
  [/\bghp_[A-Za-z0-9]{36}\b/, "github personal access token"],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, "github fine-grained token"],
  [/\bsk-[A-Za-z0-9]{32,}\b/, "provider api key"],
  [/-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, "pem private key block"],
  [/\bxprv[0-9A-HJ-NP-Za-km-z]{50,}\b/, "bip32 extended private key"],
];

const HEX64 = /\b(?:0x)?([0-9a-fA-F]{64})\b/g;
const BASE58_CANDIDATE = /\b[rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz]{25,40}\b/g;

for (const relative of trackedPaths) {
  if (SELF_PATHS.has(relative)) continue;
  if (BINARY_EXTENSIONS.test(relative)) continue;

  const absolute = join(REPO_ROOT, relative);
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) continue;

  const buffer = readFileSync(absolute);
  if (buffer.includes(0)) continue;
  const lines = buffer.toString("utf8").split("\n");

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    const keyword = KEYWORD_ASSIGNMENT.exec(line);
    if (keyword && !PLACEHOLDER.test(keyword[2])) {
      record("keyword-assignment", relative, lineNumber, `${keyword[1]} assigned a concrete value`);
    }

    for (const [pattern, label] of CREDENTIAL_PATTERNS) {
      if (pattern.test(line)) record("credential-pattern", relative, lineNumber, label);
    }

    for (const match of line.matchAll(HEX64)) {
      const digest = match[1].toLowerCase();
      // A word of a single repeated nibble (zero words, padding) carries no entropy and no secret.
      const isDegenerate = /^(.)\1{63}$/.test(digest);
      if (!isDegenerate && !PROTOCOL_CONSTANTS.has(digest) && !allowedDigests.has(digest)) {
        record(
          "unallowlisted-64-hex",
          relative,
          lineNumber,
          `64-hex token ${digest.slice(0, 8)}… is not a digest recorded in ${HASH_SOURCES.join(", ")}`,
        );
      }
    }

    for (const match of line.matchAll(BASE58_CANDIDATE)) {
      if (isXrplSecret(match[0])) {
        record("xrpl-secret", relative, lineNumber, "base58check payload with an XRPL secret type prefix");
      }
    }
  });
}

// ---------------------------------------------------------------- path rules

const FORBIDDEN_PATH = /(^|\/)(\.env$|\.env\.(?!example)|secrets\/|wallets\/|\.runtime\/)/;
for (const relative of trackedPaths) {
  if (relative === ".runtime/.gitkeep") continue;
  if (FORBIDDEN_PATH.test(relative)) {
    record("forbidden-tracked-path", relative, 0, "secret-bearing path is tracked by git");
  }
}

// ---------------------------------------------------------------- ignore rules

for (const path of [".runtime/secrets/", ".env", "wallets/", "secrets/"]) {
  try {
    execFileSync("git", ["check-ignore", "-q", path], { cwd: REPO_ROOT, stdio: "ignore" });
  } catch {
    record("not-gitignored", path, 0, "path is not gitignored");
  }
}

// ---------------------------------------------------------------- report

if (findings.length > 0) {
  console.error("SECRET SCAN FAILED\n");
  for (const finding of findings) {
    console.error(`  [${finding.rule}] ${finding.path}${finding.line ? `:${finding.line}` : ""} — ${finding.detail}`);
  }
  console.error(`\n${findings.length} finding(s).`);
  process.exit(1);
}

console.log(
  `secret scan OK: ${trackedPaths.length} tracked files, ${allowedDigests.size} allowlisted digests, no key material`,
);
