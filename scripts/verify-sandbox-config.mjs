#!/usr/bin/env node
/**
 * Asserts that the Claude Code sandbox actually denies reads of the paths that hold key material.
 *
 * PRD section 22.2 names prompt injection as an adversary and FR-074 forbids key material from
 * reaching the Claude Code context. Relying on the agent choosing not to read `.runtime/secrets/`
 * is not a control. This makes the deny rules a build-time invariant, so removing one fails a gate
 * rather than silently widening the blast radius.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/source-lock.mjs";

const REQUIRED_DENY_READ = ["./.runtime/secrets", "./.env", "./secrets", "./wallets", "~/.ssh"];
const REQUIRED_DENY_PERMISSION = ["Read(./.runtime/secrets/**)"];

// settings.local.json is gitignored and machine-local, so it is checked only when present.
const FILES = [
  { path: ".claude/settings.json", required: true },
  { path: ".claude/settings.example.json", required: true },
  { path: ".claude/settings.local.json", required: false },
];

const problems = [];

const covers = (patterns, target) =>
  patterns.some((pattern) => pattern === target || pattern === `${target}/**` || pattern.startsWith(`${target}/`));

for (const file of FILES) {
  const absolute = join(REPO_ROOT, file.path);
  if (!existsSync(absolute)) {
    if (file.required) problems.push(`${file.path} is missing`);
    continue;
  }

  let settings;
  try {
    settings = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    problems.push(`${file.path} is not valid JSON: ${error.message}`);
    continue;
  }

  const denyRead = settings.sandbox?.filesystem?.denyRead ?? [];
  const denyPermissions = settings.permissions?.deny ?? [];

  // settings.local.json intentionally carries a narrower list; only the secrets rule is universal.
  const requiredReads = file.path.endsWith("settings.local.json") ? ["./.runtime/secrets"] : REQUIRED_DENY_READ;

  for (const target of requiredReads) {
    if (!covers(denyRead, target)) {
      problems.push(`${file.path}: sandbox.filesystem.denyRead does not cover ${target}`);
    }
  }
  for (const rule of REQUIRED_DENY_PERMISSION) {
    if (!denyPermissions.includes(rule)) {
      problems.push(`${file.path}: permissions.deny is missing ${rule}`);
    }
  }

  if (settings.sandbox?.enabled !== true) {
    problems.push(`${file.path}: sandbox.enabled must be true`);
  }
}

if (problems.length > 0) {
  console.error("sandbox config check FAILED\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("sandbox config OK: secret paths are deny-read in every settings file");
