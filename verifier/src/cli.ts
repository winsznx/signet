#!/usr/bin/env node
/**
 * `pnpm verify:receipt <receipt.json | action-id>`
 *
 * Runs from a fresh clone with no credentials. Endpoints come from the pinned source lock rather
 * than from the receipt, because a receipt that chose its own verifier would be checking itself.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { coston2Obligations } from "./fassets.ts";
import { commitmentFromReceipt } from "./commitment.ts";
import { verifyReceipt, type Receipt } from "./verify.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const lock = JSON.parse(readFileSync(join(REPO_ROOT, "docs", "source-lock.json"), "utf8"));

const XRPL_ENDPOINTS: string[] = lock.networks.xrplTestnet.rpc;
const COSTON2_ENDPOINTS: string[] = lock.networks.coston2.rpc;
/** Resolved from the pinned lock by id, so a renamed or moved entry fails here rather than silently
 *  verifying against the wrong contract. */
const assetManagerEntry = lock.contracts.find((c: { id: string }) => c.id === "asset-manager-fxrp");
if (!assetManagerEntry) throw new Error("source-lock.json has no asset-manager-fxrp entry");
const ASSET_MANAGER: string = assetManagerEntry.address;

/** Accepts a path, a bare filename, or the transaction hash a receipt is named after. */
function locate(argument: string): { name: string; receipt: Receipt } {
  const receiptsDir = join(REPO_ROOT, "evidence", "receipts");
  const candidates = [
    argument,
    join(REPO_ROOT, argument),
    join(receiptsDir, argument),
    ...readdirSync(receiptsDir)
      .filter((f) => f.toLowerCase().includes(argument.toLowerCase().replace(/^0x/, "")))
      .map((f) => join(receiptsDir, f)),
  ];
  // Several receipts can mention one transaction hash: the payment, and the FDC request built from
  // it. Prefer one that actually records a payment, so verifying "that transaction" verifies the
  // payment rather than the request that refers to it.
  const parsed: { name: string; receipt: Receipt }[] = [];
  for (const candidate of candidates) {
    try {
      parsed.push({ name: candidate.replace(REPO_ROOT, ""), receipt: JSON.parse(readFileSync(candidate, "utf8")) });
    } catch {
      // try the next candidate
    }
  }
  const withPayment = parsed.find((p) => p.receipt.txHash && p.receipt.requestId);
  if (withPayment) return withPayment;
  if (parsed[0]) return parsed[0];
  throw new Error(`no receipt found for ${argument}`);
}

const argument = process.argv[2];
if (!argument) {
  console.error("usage: verify:receipt <receipt path | filename | transaction hash>");
  process.exit(1);
}

const { name, receipt } = locate(argument);
const result = await verifyReceipt(name, receipt, {
  xrplEndpoints: XRPL_ENDPOINTS,
  obligations: coston2Obligations(COSTON2_ENDPOINTS, ASSET_MANAGER),
  recomputeCommitment: commitmentFromReceipt,
});

const MARK: Record<string, string> = { PASS: "ok  ", FAIL: "FAIL", UNVERIFIABLE: "??  ", NOT_CLAIMED: "--  " };
console.log(`${name}\n`);
for (const finding of result.findings) {
  console.log(`${MARK[finding.outcome]} ${finding.name}`);
  if (finding.outcome === "FAIL") console.log(`       expected ${finding.expected}\n       observed ${finding.observed}`);
  if (finding.outcome === "UNVERIFIABLE") console.log(`       ${finding.why}`);
  if (finding.outcome === "NOT_CLAIMED") {
    console.log(finding.why ? `       ${finding.why}` : `       fassets says ${finding.expected}, the ledger holds ${finding.observed}`);
  }
}

const counts = {
  PASS: result.findings.filter((f) => f.outcome === "PASS").length,
  FAIL: result.findings.filter((f) => f.outcome === "FAIL").length,
  UNVERIFIABLE: result.findings.filter((f) => f.outcome === "UNVERIFIABLE").length,
  NOT_CLAIMED: result.findings.filter((f) => f.outcome === "NOT_CLAIMED").length,
};
console.log(
  `\n${result.verdict}: ${counts.PASS} passed, ${counts.FAIL} failed, ${counts.UNVERIFIABLE} unverifiable, ${counts.NOT_CLAIMED} not claimed`,
);

// UNVERIFIABLE exits 3, distinct from both success and failure. A caller that treats "I could not
// check this" as success is the exact mistake this verifier exists to prevent, so it must not be
// possible to make it by reading the exit code carelessly.
process.exit(result.verdict === "PASS" ? 0 : result.verdict === "FAIL" ? 1 : 3);
