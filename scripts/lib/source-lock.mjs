import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, lstatSync, readlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const REPO_ROOT = resolve(new URL("../..", import.meta.url).pathname);
export const SOURCE_LOCK_PATH = join(REPO_ROOT, "docs", "source-lock.json");
export const UPSTREAM_DIR = join(REPO_ROOT, "upstream");

export function readSourceLock() {
  return JSON.parse(readFileSync(SOURCE_LOCK_PATH, "utf8"));
}

export function writeSourceLock(lock) {
  writeFileSync(SOURCE_LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
}

const COMMIT_RE = /^[0-9a-f]{40}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const REQUIRED_UPSTREAM_FIELDS = [
  "id",
  "owner",
  "repository",
  "documentation",
  "commit",
  "commitDate",
  "license",
  "verifiedAt",
  "reVerificationOwner",
  "usedFor",
  "knownLimitation",
];

const REQUIRED_CONTRACT_FIELDS = [
  "id",
  "network",
  "name",
  "address",
  "resolvedFrom",
  "runtimeCodeHash",
  "runtimeCodeSize",
  "selectors",
  "verifiedAt",
  "sourceLockRef",
  "knownLimitation",
];

/**
 * Schema check for docs/source-lock.json. Returns a list of human-readable problems.
 * An empty list means the lock satisfies the PRD section 2 record requirements.
 */
export function validateSourceLock(lock) {
  const problems = [];
  const fail = (msg) => problems.push(msg);

  if (lock.schemaVersion !== 1) fail(`schemaVersion must be 1, got ${JSON.stringify(lock.schemaVersion)}`);
  if (!ISO_RE.test(lock.verifiedAt ?? "")) fail(`verifiedAt must be an ISO-8601 Z timestamp, got ${JSON.stringify(lock.verifiedAt)}`);
  if (typeof lock.owner !== "string" || !lock.owner) fail("owner must be a non-empty string");

  const coston2 = lock.networks?.coston2;
  if (!coston2) fail("networks.coston2 is required");
  else {
    if (coston2.chainId !== 114) fail(`networks.coston2.chainId must be 114, got ${coston2.chainId}`);
    if (!ADDRESS_RE.test(coston2.contractRegistry ?? "")) fail("networks.coston2.contractRegistry must be a 0x address");
    if (!Array.isArray(coston2.rpc) || coston2.rpc.length < 2) {
      fail("networks.coston2.rpc must list at least two independent endpoints so runtime code hashes can be cross-checked");
    }
  }
  const xrpl = lock.networks?.xrplTestnet;
  if (!xrpl) fail("networks.xrplTestnet is required");
  else if (!Array.isArray(xrpl.rpc) || xrpl.rpc.length < 2) fail("networks.xrplTestnet.rpc must list at least two independent endpoints");

  if (!Array.isArray(lock.upstream) || lock.upstream.length === 0) {
    fail("upstream must be a non-empty array");
  } else {
    const ids = new Set();
    for (const entry of lock.upstream) {
      const label = entry.id ?? "<missing id>";
      for (const field of REQUIRED_UPSTREAM_FIELDS) {
        if (entry[field] === undefined || entry[field] === null || entry[field] === "") {
          fail(`upstream[${label}].${field} is required`);
        }
      }
      if (ids.has(entry.id)) fail(`upstream[${label}] duplicate id`);
      ids.add(entry.id);
      if (!COMMIT_RE.test(entry.commit ?? "")) fail(`upstream[${label}].commit must be a full 40-hex commit sha`);
      if (!ISO_RE.test(entry.verifiedAt ?? "")) fail(`upstream[${label}].verifiedAt must be an ISO-8601 Z timestamp`);
      if (!Array.isArray(entry.usedFor) || entry.usedFor.length === 0) fail(`upstream[${label}].usedFor must be a non-empty array`);
      if (entry.contentSha256 !== null && !SHA256_RE.test(entry.contentSha256 ?? "")) {
        fail(`upstream[${label}].contentSha256 must be null or 64-hex`);
      }
      if (!/^https:\/\/github\.com\//.test(entry.repository ?? "")) fail(`upstream[${label}].repository must be an https github url`);
    }
  }

  if (!Array.isArray(lock.contracts)) {
    fail("contracts must be an array");
  } else {
    const ids = new Set();
    for (const entry of lock.contracts) {
      const label = entry.id ?? "<missing id>";
      for (const field of REQUIRED_CONTRACT_FIELDS) {
        if (entry[field] === undefined || entry[field] === null || entry[field] === "") {
          fail(`contracts[${label}].${field} is required`);
        }
      }
      if (ids.has(entry.id)) fail(`contracts[${label}] duplicate id`);
      ids.add(entry.id);
      if (!ADDRESS_RE.test(entry.address ?? "")) fail(`contracts[${label}].address must be a 0x address`);
      if (!SHA256_RE.test((entry.runtimeCodeHash ?? "").replace(/^0x/, ""))) {
        fail(`contracts[${label}].runtimeCodeHash must be a 32-byte hash`);
      }
      if (!Number.isInteger(entry.runtimeCodeSize) || entry.runtimeCodeSize <= 0) {
        fail(`contracts[${label}].runtimeCodeSize must be a positive integer (no code at address)`);
      }
      if (!Array.isArray(entry.selectors) || entry.selectors.length === 0) {
        fail(`contracts[${label}].selectors must be a non-empty array`);
      } else {
        for (const sel of entry.selectors) {
          if (!/^0x[0-9a-f]{8}$/.test(sel.selector ?? "")) fail(`contracts[${label}] selector ${sel.signature} malformed`);
          if (typeof sel.presentInRuntimeCode !== "boolean") fail(`contracts[${label}] selector ${sel.signature} missing presentInRuntimeCode`);
        }
      }
    }
  }

  return problems;
}

/** Written by scripts/fetch-upstream.mjs, so it must never contribute to the content hash. */
export const PIN_STAMP = ".signet-pin";

function hashFileTree(dir) {
  const rolling = createHash("sha256");
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      if (current === dir && name === PIN_STAMP) continue;
      const full = join(current, name);
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dir);
  files.sort();
  for (const file of files) {
    const rel = relative(dir, file).split("\\").join("/");
    const stat = lstatSync(file);
    const digest = stat.isSymbolicLink()
      ? createHash("sha256").update(`symlink:${readlinkSync(file)}`).digest("hex")
      : createHash("sha256").update(readFileSync(file)).digest("hex");
    rolling.update(`${rel}\u0000${digest}\n`);
  }
  return { contentSha256: rolling.digest("hex"), fileCount: files.length };
}

/**
 * Deterministic content hash over an extracted upstream checkout.
 * Independent of tar/gzip framing, so it survives GitHub archive re-encoding.
 */
export function hashUpstream(id) {
  return hashFileTree(join(UPSTREAM_DIR, id));
}

export function tarballUrl(entry) {
  const repo = entry.repository.replace("https://github.com/", "");
  return `https://codeload.github.com/${repo}/tar.gz/${entry.commit}`;
}

export function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}
