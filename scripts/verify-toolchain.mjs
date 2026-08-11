#!/usr/bin/env node
/**
 * Checks the live toolchain against toolchain.lock.
 *
 * Contract bytecode identity and the reproducible extension image both depend on exact tool
 * versions, so drift has to surface at the phase gate rather than in a mismatched code hash later.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/source-lock.mjs";

const lock = JSON.parse(readFileSync(join(REPO_ROOT, "toolchain.lock"), "utf8"));
const problems = [];
const warnings = [];

function run(command) {
  try {
    return execFileSync("bash", ["-lc", command], { encoding: "utf8", cwd: REPO_ROOT }).trim();
  } catch (error) {
    return null;
  }
}

function versionOf(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return match ? { major: +match[1], minor: +match[2], patch: +match[3], raw: match[0] } : null;
}

const goBin = join(REPO_ROOT, ".runtime", "toolchain", "go", "bin");
const pathPrefix = existsSync(goBin) ? `export PATH="${goBin}:$PATH"; ` : "";

for (const [name, spec] of Object.entries(lock.tools)) {
  const output = run(pathPrefix + spec.check);
  if (output === null) {
    problems.push(`${name}: '${spec.check}' failed; tool is not installed`);
    continue;
  }
  const observed = versionOf(output);
  const required = versionOf(spec.required);
  if (!observed || !required) {
    problems.push(`${name}: could not parse a version from '${output}'`);
    continue;
  }
  const sameMajor = observed.major === required.major;
  const sameMinor = sameMajor && observed.minor === required.minor;
  const samePatch = sameMinor && observed.patch === required.patch;

  const ok =
    spec.match === "exact" ? samePatch : spec.match === "exact-minor" ? sameMinor : sameMajor;

  if (!ok) {
    const message = `${name}: locked ${spec.required}, observed ${observed.raw} (match=${spec.match})`;
    if (spec.match === "exact") problems.push(message);
    else problems.push(message);
  } else if (!samePatch && spec.match !== "major") {
    warnings.push(`${name}: patch drift, locked ${spec.required} observed ${observed.raw}`);
  }
}

for (const warning of warnings) console.warn(`warn  ${warning}`);

if (problems.length > 0) {
  console.error("toolchain check FAILED\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nInstall the locked versions, or run scripts/install-go.sh for a repo-local Go.");
  process.exit(1);
}

console.log(`toolchain OK: ${Object.keys(lock.tools).length} tools match toolchain.lock`);
