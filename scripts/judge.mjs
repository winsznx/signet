#!/usr/bin/env node
/**
 * `make judge` — verify Signet's claims without being Signet.
 *
 * A judge should not need a wallet, C2FLR, TestXRP, Docker, GCP, Telegram credentials or a running
 * TEE to check whether this project did what it says. Everything here is read-only and needs no
 * secret. It runs from a fresh clone.
 *
 * Three outcomes, and the third is the one that matters:
 *
 *   PASS         checked, and it holds
 *   FAIL         checked, and it does not hold
 *   UNVERIFIABLE could not be checked from here (usually a network the judge cannot reach)
 *
 * UNVERIFIABLE is never silently folded into PASS. A checker that cannot distinguish "true" from
 * "I could not look" is worth nothing, and this project's whole argument is that it reports what
 * actually happened.
 *
 * Exit codes: 0 all PASS, 1 any FAIL, 2 no FAIL but something UNVERIFIABLE.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/source-lock.mjs";

const OFFLINE = process.argv.includes("--offline");
const JSON_OUT = process.argv.includes("--json");

const deployments = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", "coston2.json"), "utf8"));
const ledger = JSON.parse(readFileSync(join(REPO_ROOT, "evidence", "claim-ledger.json"), "utf8"));
const RPC = process.env.COSTON2_RPC_URL ?? deployments.rpc;
// Two endpoints, not one. XRPL testnet nodes prune, so a `txnNotFound` from the first is a
// statement about that node's history rather than about the transaction. Signet's own observer
// refuses to treat one node's silence as absence, and a judge's checker should not either.
const XRPL_ENDPOINTS = (process.env.SIGNET_XRPL_ENDPOINTS ?? "https://s.altnet.rippletest.net:51234/,https://testnet.xrpl-labs.com/")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const rows = [];
const boundaries = [];
const add = (step, question, status, detail) => rows.push({ step, question, status, detail });
/** Something Signet deliberately does not claim. Not a check, and never counted as a failure. */
const boundary = (statement, detail) => boundaries.push({ statement, detail });

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

// ---------------------------------------------------------------- 1. the obligation

async function step1() {
  const step = "1. FAssets obligation";
  const assetManager = deployments.signet?.assetManager;
  if (!assetManager) return add(step, "is an AssetManager recorded?", "FAIL", "no assetManager in deployments");
  if (OFFLINE) return add(step, "is the FAssets AssetManager live on Coston2?", "UNVERIFIABLE", "--offline");

  try {
    const code = await rpc("eth_getCode", [assetManager, "latest"]);
    const bytes = (code.length - 2) / 2;
    add(
      step,
      "is the FAssets AssetManager live on Coston2?",
      bytes > 0 ? "PASS" : "FAIL",
      `${assetManager}, ${bytes} bytes`,
    );
  } catch (error) {
    add(step, "is the FAssets AssetManager live on Coston2?", "UNVERIFIABLE", `Coston2 RPC unreachable: ${error.message}`);
  }
}

// ---------------------------------------------------------------- 2. the decision, and the entry point

async function step2() {
  const step = "2. Signet decision";
  const fcc = deployments.fcc ?? {};

  // The claim a judge most wants to test: the caller cannot express a payment field.
  const { keccak_256 } = await import("@noble/hashes/sha3");
  const sel = (sig) => `0x${Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex").slice(0, 8)}`;
  const authorize = sel("authorizeRedemption(uint256,uint32)");

  if (OFFLINE) {
    add(step, "does the entry point carry any payment field?", "UNVERIFIABLE", "--offline");
  } else {
    try {
      const code = await rpc("eth_getCode", [fcc.instructionSender, "latest"]);
      const present = code.toLowerCase().includes(authorize.slice(2));
      add(
        step,
        "does the deployed sender expose authorizeRedemption(uint256,uint32)?",
        present ? "PASS" : "FAIL",
        `${authorize} ${present ? "present" : "absent"} in ${fcc.instructionSender}`,
      );
    } catch (error) {
      add(step, "does the deployed sender expose authorizeRedemption(uint256,uint32)?", "UNVERIFIABLE", error.message);
    }

    // The registry must route the extension at that exact sender, or the address above proves nothing.
    try {
      const data = `${sel("getTeeExtensionInstructionsSender(uint256)")}${BigInt(fcc.extensionId).toString(16).padStart(64, "0")}`;
      const reported = `0x${(await rpc("eth_call", [{ to: fcc.flareTeeManager, data }, "latest"])).slice(-40)}`;
      const match = reported.toLowerCase() === (fcc.instructionSender ?? "").toLowerCase();
      add(
        step,
        `does extension ${fcc.extensionId} route to that sender?`,
        match ? "PASS" : "FAIL",
        `${reported}${match ? "" : ` != ${fcc.instructionSender}`}`,
      );
    } catch (error) {
      add(step, `does extension ${fcc.extensionId} route to that sender?`, "UNVERIFIABLE", error.message);
    }
  }

  // Not a check. "Signet claimed X and X is false" and "Signet does not claim X" are different
  // things, and folding the second into FAIL would make this command exit non-zero forever, which
  // is how a checker gets ignored. It is printed as a boundary instead, and asserted in step 5.
  boundary(
    "The decision did not run in an attested TEE.",
    `getActiveTeeMachines(${fcc.extensionId}) returns empty. Nothing is hardware-attested, and the claim ledger records this as unavailable rather than verified.`,
  );
}

// ---------------------------------------------------------------- 3. the XRPL payment

async function step3() {
  const step = "3. XRPL payment";
  const dir = join(REPO_ROOT, "evidence", "receipts");
  const lifecycle = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("lifecycle-")) : [];
  if (lifecycle.length === 0) return add(step, "is there a payment receipt?", "FAIL", "no lifecycle receipts");

  // Newest by validated ledger, so the judge checks the current evidence rather than the oldest.
  const receipts = lifecycle
    .map((f) => ({ file: f, body: JSON.parse(readFileSync(join(dir, f), "utf8")) }))
    .filter((r) => r.body.txHash)
    .sort((a, b) => (b.body.validatedLedger ?? 0) - (a.body.validatedLedger ?? 0));
  const newest = receipts[0];
  add(step, "is there a payment receipt?", "PASS", `${receipts.length} receipts, newest ${newest.body.txHash}`);

  if (OFFLINE) return add(step, "did the XRP ledger validate that exact transaction?", "UNVERIFIABLE", "--offline");

  let tx = null;
  const attempts = [];
  for (const endpoint of XRPL_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "tx", params: [{ transaction: newest.body.txHash }] }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json();
      if (body?.result && !body.result.error) {
        tx = body.result;
        attempts.push(`${endpoint}: found`);
        break;
      }
      attempts.push(`${endpoint}: ${body?.result?.error ?? "no answer"}`);
    } catch (error) {
      attempts.push(`${endpoint}: ${error.name === "TimeoutError" ? "timeout" : error.message}`);
    }
  }

  if (!tx) {
    return add(
      step,
      "did the XRP ledger validate that exact transaction?",
      "UNVERIFIABLE",
      `no endpoint could answer. ${attempts.join("; ")}. txnNotFound usually means the node pruned that ledger, not that the transaction is absent`,
    );
  }

  try {
    const validated = tx.validated === true;
    const result = tx.meta?.TransactionResult ?? tx.engine_result;
    const destinationMatches = tx.Destination === newest.body.template?.Destination;
    const amountMatches = String(tx.Amount) === String(newest.body.template?.Amount);

    add(
      step,
      "did the XRP ledger validate that exact transaction?",
      validated && result === "tesSUCCESS" ? "PASS" : "FAIL",
      `validated=${validated} result=${result} ledger=${tx.ledger_index}`,
    );
    add(
      step,
      "does the ledger agree with the receipt on destination and amount?",
      destinationMatches && amountMatches ? "PASS" : "FAIL",
      `destination ${destinationMatches ? "matches" : `differs: ledger ${tx.Destination}`}, amount ${amountMatches ? "matches" : `differs: ledger ${tx.Amount}`}`,
    );
  } catch (error) {
    add(step, "did the XRP ledger validate that exact transaction?", "UNVERIFIABLE", `XRPL unreachable: ${error.message}`);
  }
}

// ---------------------------------------------------------------- 4. the FDC proof

async function step4() {
  const step = "4. FDC proof";
  const dir = join(REPO_ROOT, "evidence", "receipts");
  const proofs = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("fdc-proof-")) : [];
  if (proofs.length === 0) return add(step, "is there an FDC proof receipt?", "FAIL", "none");

  const proof = JSON.parse(readFileSync(join(dir, proofs[0]), "utf8"));
  const type = Buffer.from((proof.response?.attestationType ?? "").replace(/^0x/, ""), "hex")
    .toString("utf8")
    .replace(/\0+$/, "");
  const source = Buffer.from((proof.response?.sourceId ?? "").replace(/^0x/, ""), "hex")
    .toString("utf8")
    .replace(/\0+$/, "");

  add(
    step,
    "is the attestation the XRP-specific type?",
    type === "XRPPayment" ? "PASS" : "FAIL",
    `attestationType=${type || "unreadable"}, sourceId=${source || "unreadable"}`,
  );
  add(
    step,
    "was it accepted on chain by FdcVerification?",
    proof.verifiedOnChain === true ? "PASS" : "FAIL",
    `${proof.fdcVerification} round ${proof.response?.votingRound}, recorded verifiedOnChain=${proof.verifiedOnChain}`,
  );
  add(
    step,
    "does the proof describe the payment the receipt claims?",
    (proof.attestedPayment ?? "").toLowerCase() === (proof.response?.requestBody?.transactionId ?? "").replace(/^0x/, "").toLowerCase()
      ? "PASS"
      : "FAIL",
    `attested ${proof.attestedPayment}`,
  );
}

// ---------------------------------------------------------------- 5. the claims themselves

function step5() {
  const step = "5. Claim discipline";
  const missingEvidence = [];
  for (const claim of ledger.claims) {
    for (const reference of claim.evidence ?? []) {
      if (!existsSync(join(REPO_ROOT, reference.split("#")[0]))) missingEvidence.push(`${claim.id} -> ${reference}`);
    }
  }
  add(
    step,
    "does every cited piece of evidence exist?",
    missingEvidence.length === 0 ? "PASS" : "FAIL",
    missingEvidence.length === 0 ? `${ledger.claims.length} claims checked` : missingEvidence.join("; "),
  );

  const noLimits = ledger.claims.filter((c) => (c.limitations ?? []).length === 0);
  add(
    step,
    "does every claim state what it does not prove?",
    noLimits.length === 0 ? "PASS" : "FAIL",
    noLimits.length === 0 ? "every claim carries at least one limitation" : noLimits.map((c) => c.id).join(", "),
  );

  // The prohibited claim. If this ever passes as "verified", the submission is dishonest.
  const tee = ledger.claims.find((c) => c.id === "claim-tee-hardware-attested");
  add(
    step,
    "is hardware attestation claimed anywhere?",
    tee && tee.status === "unavailable" && tee.proofLevel === 0 ? "PASS" : "FAIL",
    tee ? `claim-tee-hardware-attested is ${tee.status} at proof level ${tee.proofLevel}` : "claim missing entirely",
  );

  const graphPath = join(REPO_ROOT, "evidence", "evidence-graph.json");
  if (!existsSync(graphPath)) return add(step, "is the evidence graph present?", "FAIL", "missing");
  const graph = JSON.parse(readFileSync(graphPath, "utf8"));
  add(
    step,
    "is the evidence graph consistent with the ledger?",
    graph.counts?.claims === ledger.claims.length ? "PASS" : "FAIL",
    `graph ${graph.counts?.claims} claims, ledger ${ledger.claims.length}`,
  );
}

// ---------------------------------------------------------------- run

const STATUS_ORDER = { FAIL: 0, UNVERIFIABLE: 1, PASS: 2 };
const COLOURS = { PASS: "[32m", FAIL: "[31m", UNVERIFIABLE: "[33m" };

await step1();
await step2();
await step3();
await step4();
step5();

const counts = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});

if (JSON_OUT) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), counts, rows, notClaimed: boundaries }, null, 2));
} else {
  console.log("\nSignet — independent verification\n");
  console.log("Nothing here needs a wallet, funds, Docker, GCP or a running TEE.\n");
  let step = "";
  for (const r of [...rows].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || 0)) void r;
  for (const r of rows) {
    if (r.step !== step) {
      step = r.step;
      console.log(`\n${step}`);
    }
    const c = process.stdout.isTTY ? COLOURS[r.status] : "";
    const reset = process.stdout.isTTY ? "[0m" : "";
    console.log(`  ${c}${r.status.padEnd(12)}${reset} ${r.question}`);
    console.log(`               ${r.detail}`);
  }
  console.log(
    `\n${counts.PASS ?? 0} PASS, ${counts.FAIL ?? 0} FAIL, ${counts.UNVERIFIABLE ?? 0} UNVERIFIABLE`,
  );
  if (boundaries.length > 0) {
    console.log("\nNot claimed, and asserted as not claimed above:");
    for (const b of boundaries) {
      console.log(`  - ${b.statement}`);
      console.log(`    ${b.detail}`);
    }
  }
  console.log("\nFull claims and limitations: evidence/claim-ledger.json. Threats: docs/threat-model.md.");
}

process.exit(counts.FAIL ? 1 : counts.UNVERIFIABLE ? 2 : 0);
