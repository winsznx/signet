#!/usr/bin/env node
/**
 * Schema and honesty gate for evidence/claim-ledger.json.
 *
 * PRD section 28 makes this file authoritative for every public claim, so the checks here are
 * about proof discipline rather than JSON shape alone:
 *
 * - a verified claim must cite evidence that exists on disk and carry a verification timestamp;
 * - a claim's verifiedAt may not precede the artefacts it cites, which is how a ledger ends up
 *   asserting it was verified before its own evidence was generated;
 * - a claim above proof level 1 must name the networks it was proven on;
 * - anything mentioning attestation, hardware or production must state its limitations.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/source-lock.mjs";

const LEDGER_PATH = join(REPO_ROOT, "evidence", "claim-ledger.json");
const ALLOWED_STATUS = new Set(["verified", "failed", "unavailable", "reported_not_independently_verified"]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const REQUIRED_FIELDS = ["id", "wording", "status", "proofLevel", "network", "evidence", "verifiedAt", "limitations"];

/** Timestamp fields the evidence artefacts use to record when they were generated. */
const ARTEFACT_TIME_KEYS = ["resolvedAt", "probedAt", "generatedAt", "verifiedAt", "recordedAt"];

const ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
const problems = [];

if (ledger.schemaVersion !== 1) problems.push(`schemaVersion must be 1, got ${JSON.stringify(ledger.schemaVersion)}`);
if (!ISO.test(ledger.generatedAt ?? "")) problems.push("generatedAt must be an ISO-8601 Z timestamp");
if (!Array.isArray(ledger.claims) || ledger.claims.length === 0) problems.push("claims must be a non-empty array");

function artefactTimestamp(relativePath) {
  const clean = relativePath.split("#")[0];
  const absolute = join(REPO_ROOT, clean);
  if (!existsSync(absolute) || !clean.endsWith(".json")) return null;
  try {
    const data = JSON.parse(readFileSync(absolute, "utf8"));
    for (const key of ARTEFACT_TIME_KEYS) {
      if (ISO.test(data[key] ?? "")) return data[key];
    }
  } catch {
    return null;
  }
  return null;
}

const ids = new Set();
for (const claim of ledger.claims ?? []) {
  const label = claim.id ?? "<missing id>";

  for (const field of REQUIRED_FIELDS) {
    if (claim[field] === undefined) problems.push(`claims[${label}].${field} is required`);
  }
  if (ids.has(claim.id)) problems.push(`claims[${label}] duplicate id`);
  ids.add(claim.id);

  if (!ALLOWED_STATUS.has(claim.status)) {
    problems.push(`claims[${label}].status ${JSON.stringify(claim.status)} is not an allowed status`);
  }
  if (!Number.isInteger(claim.proofLevel) || claim.proofLevel < 0 || claim.proofLevel > 4) {
    problems.push(`claims[${label}].proofLevel must be an integer 0-4`);
  }
  if (!Array.isArray(claim.limitations) || claim.limitations.length === 0) {
    problems.push(`claims[${label}].limitations must state at least one limitation`);
  }

  if (claim.status === "verified") {
    if (!ISO.test(claim.verifiedAt ?? "")) {
      problems.push(`claims[${label}] is verified but has no ISO-8601 verifiedAt`);
    }
    if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
      problems.push(`claims[${label}] is verified but cites no evidence`);
    }
    if (claim.proofLevel === 0) {
      problems.push(`claims[${label}] is verified at proof level 0, which is a contradiction`);
    }
    if (claim.proofLevel >= 2 && (!Array.isArray(claim.network) || claim.network.length === 0)) {
      problems.push(`claims[${label}] claims target-network proof but names no network`);
    }

    for (const reference of claim.evidence ?? []) {
      const path = reference.split("#")[0];
      if (!existsSync(join(REPO_ROOT, path))) {
        problems.push(`claims[${label}] cites missing evidence ${reference}`);
        continue;
      }
      const generated = artefactTimestamp(reference);
      if (generated && ISO.test(claim.verifiedAt ?? "") && Date.parse(claim.verifiedAt) < Date.parse(generated)) {
        problems.push(
          `claims[${label}].verifiedAt ${claim.verifiedAt} precedes its evidence ${reference} generated at ${generated}`,
        );
      }
    }
  } else if (claim.status === "unavailable" && claim.proofLevel !== 0) {
    problems.push(`claims[${label}] is unavailable but claims proof level ${claim.proofLevel}`);
  }

  const wording = `${claim.wording ?? ""}`.toLowerCase();
  if (/attest|hardware|enclave|production/.test(wording) && claim.status === "verified") {
    const limitations = (claim.limitations ?? []).join(" ").toLowerCase();
    if (!/simulat|not hardware|not attested|labelled/.test(limitations)) {
      problems.push(
        `claims[${label}] makes an attestation or production claim without a limitation distinguishing it from simulated execution`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("claim-ledger check FAILED\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const verified = ledger.claims.filter((c) => c.status === "verified").length;
console.log(`claim-ledger OK: ${ledger.claims.length} claims, ${verified} verified, all evidence present and consistent`);
