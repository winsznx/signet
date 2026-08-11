#!/usr/bin/env node
/**
 * Phase gate check for docs/source-lock.json.
 *
 * 1. schema: every PRD section 2 record field is present and well formed
 * 2. content: every pinned upstream checkout on disk matches its recorded contentSha256
 * 3. reachability: every recorded contract selector was proven reachable when resolved
 * 4. references: every contract points at an upstream entry that exists
 *
 * This runs offline. Live re-resolution is scripts/resolve-coston2.mjs.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { UPSTREAM_DIR, hashUpstream, readSourceLock, validateSourceLock } from "./lib/source-lock.mjs";

const lock = readSourceLock();
const problems = validateSourceLock(lock);

const upstreamIds = new Set(lock.upstream.map((e) => e.id));

for (const entry of lock.upstream) {
  const dir = join(UPSTREAM_DIR, entry.id);
  if (!existsSync(dir)) {
    problems.push(`upstream[${entry.id}] is not checked out; run make bootstrap`);
    continue;
  }
  if (entry.contentSha256 === null) {
    problems.push(`upstream[${entry.id}] has no recorded contentSha256`);
    continue;
  }
  const { contentSha256 } = hashUpstream(entry.id);
  if (contentSha256 !== entry.contentSha256) {
    problems.push(`upstream[${entry.id}] content hash drift: expected ${entry.contentSha256} observed ${contentSha256}`);
  }
}

if (lock.contracts.length === 0) {
  problems.push("contracts[] is empty; run make resolve-coston2");
}

const facetExceptions = lock.facetExceptions ?? [];

for (const contract of lock.contracts) {
  if (!upstreamIds.has(contract.sourceLockRef)) {
    problems.push(`contracts[${contract.id}].sourceLockRef ${contract.sourceLockRef} is not a pinned upstream id`);
  }
  if (!Array.isArray(contract.crossCheckedWith) || contract.crossCheckedWith.length === 0) {
    problems.push(`contracts[${contract.id}] was not cross-checked against a second independent RPC endpoint`);
  }
  for (const selector of contract.selectors ?? []) {
    if (selector.reachable !== true) {
      problems.push(`contracts[${contract.id}] selector ${selector.signature} was not proven reachable`);
    }

    // Only FCC addresses come from a pinned manifest; FAssets facets are resolved live from the
    // registry and have no pinned facet list yet (owned by phase 02). Where a manifest does
    // exist, a facet it does not name is address substitution in everything but intent, and
    // passes only against a dated, owned exception naming the exact facet - so a further change
    // re-breaks the gate.
    const manifestBacked = contract.sourceLockRef === "fce-extension-scaffold";
    if (manifestBacked && selector.diamondFacet && selector.facetInScaffoldManifest === null) {
      const exception = facetExceptions.find(
        (e) =>
          e.contractId === contract.id &&
          e.signature === selector.signature &&
          e.observedFacet?.toLowerCase() === selector.diamondFacet.toLowerCase(),
      );
      if (!exception) {
        problems.push(
          `contracts[${contract.id}] selector ${selector.signature} is served by facet ${selector.diamondFacet}, which the pinned manifest does not name and no facetExceptions entry covers`,
        );
      } else if (!exception.reason || !exception.recordedAt || !exception.owner) {
        problems.push(
          `facetExceptions entry for ${contract.id} ${selector.signature} must carry reason, recordedAt and owner`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error("source-lock check FAILED\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const selectorCount = lock.contracts.reduce((n, c) => n + c.selectors.length, 0);
console.log(
  `source-lock OK: ${lock.upstream.length} pinned upstream sources, ${lock.contracts.length} verified contracts, ${selectorCount} proven selectors`,
);
