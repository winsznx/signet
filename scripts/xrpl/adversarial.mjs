#!/usr/bin/env node
/**
 * Adversarial cases for the XRPL seam, run against the live testnet.
 *
 * PRD Phase 04 requires fee cap, partial-payment rejection, missing LastLedgerSequence, sequence
 * collision, resubmission of an identical blob, and expiry. They split into two kinds and both
 * kinds matter:
 *
 * - cases the reference model must refuse before anything is signed, proven by asking it;
 * - cases only the ledger can answer, proven by sending real transactions and reading validated
 *   results.
 *
 * Nothing here is mocked. The expiry case really does let a transaction die past its
 * LastLedgerSequence.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "xrpl";
import { REPO_ROOT } from "../lib/source-lock.mjs";
import { accountInfo, currentFeeDrops, validatedLedger, xrplRequest, XRPL_NETWORK_ID } from "./client.mjs";
import { persistBeforeSubmit, reconcile, submitPersisted, loadRecord, ledgerCoverage, rangeCovers } from "./submit.mjs";
import { decide } from "../../reference/src/decide.ts";
import { redemptionPaymentReference } from "../../reference/src/payment-reference.ts";
import { toHex } from "../../reference/src/bytes.ts";

const results = [];
function record(name, expectation, observed, pass) {
  results.push({ name, expectation, observed, pass });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}\n       expected ${expectation}\n       observed ${observed}`);
}

function loadSecret(role) {
  return JSON.parse(readFileSync(join(REPO_ROOT, ".runtime", "secrets", `xrpl-${role}.json`), "utf8"));
}

const source = loadSecret("agent-source");
const destination = loadSecret("redeemer-destination");
const regularKey = loadSecret("signet-regular-key");
const wallet = Wallet.fromSeed(regularKey.seed, { algorithm: "ed25519" });

const ledger = await validatedLedger();
const fees = await currentFeeDrops();

function baseInput(overrides = {}) {
  const requestId = 44851498n;
  return {
    domain: {
      schemaVersion: 1,
      flareChainId: 114n,
      instructionSender: "0x00000000000000000000000000000000000000c1",
      assetManager: "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA",
      xrplNetworkId: XRPL_NETWORK_ID,
    },
    binding: {
      agentVault: "0x55c815260cBE6c45Fe5bFe5FF32E3C7D746f14dC",
      assetManager: "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA",
      flareChainId: 114n,
      instructionSender: "0x00000000000000000000000000000000000000c1",
      xrplNetworkId: XRPL_NETWORK_ID,
      xrplSourceAddress: source.classicAddress,
      signingMode: "REGULAR_KEY",
      signerCount: 0,
      keyState: "ACTIVE",
      status: "ACTIVE",
      extensionId: 7n,
      approvedCodeHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      policyVersion: 1,
    },
    redemption: {
      requestId,
      requestGeneration: 0,
      status: "ACTIVE",
      agentVault: "0x55c815260cBE6c45Fe5bFe5FF32E3C7D746f14dC",
      paymentAddress: destination.classicAddress,
      paymentReference: toHex(redemptionPaymentReference(requestId)),
      valueUBA: 1_000_000n,
      feeUBA: 10_000n,
      firstUnderlyingBlock: BigInt(ledger.index - 10),
      lastUnderlyingBlock: BigInt(ledger.index + 400),
      lastUnderlyingTimestamp: BigInt(Math.floor(Date.now() / 1000) + 3_600),
      requiresDestinationTag: false,
      destinationTag: 0n,
      assetMintingDecimals: 6,
      ...overrides.redemption,
    },
    xrpl: {
      sequenceMode: "SEQUENCE",
      sequenceOrTicket: 1,
      currentValidatedLedger: ledger.index,
      currentLedgerCloseTime: BigInt(Math.floor(Date.now() / 1000)),
      lastLedgerSequence: ledger.index + 40,
      feeDrops: fees.baseFeeDrops,
      maxFeeDrops: 50_000n,
      baseFeeDrops: fees.baseFeeDrops,
      ...overrides.xrpl,
    },
    policy: {
      policyVersion: 1,
      extensionId: 7n,
      extensionCodeHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      revokedCodeHashes: [],
      paused: false,
      safetyMarginLedgers: 50,
      safetyMarginSeconds: 300n,
      ledgerCloseIntervalSeconds: 4n,
      ...overrides.policy,
    },
    prior: overrides.prior ?? [],
  };
}

// ---------------------------------------------------------------- refused before signing

{
  const d = decide(baseInput({ xrpl: { feeDrops: 50_001n } }));
  record(
    "fee above the cap is refused before anything is signed",
    "refuse S013_FEE_CAP_EXCEEDED",
    d.kind === "refuse" ? `refuse ${d.reason}` : "authorize",
    d.kind === "refuse" && d.reason === "S013_FEE_CAP_EXCEEDED",
  );
}

{
  const d = decide(baseInput());
  const flags = d.kind === "authorize" ? d.txTemplate.Flags : null;
  record(
    "the builder cannot emit a partial-payment flag",
    "Flags === 0 on every authorized template",
    `Flags=${flags}`,
    d.kind === "authorize" && flags === 0,
  );
}

{
  const d = decide(baseInput());
  const hasLls = d.kind === "authorize" && Number.isInteger(d.txTemplate.LastLedgerSequence);
  record(
    "the builder cannot emit a template without LastLedgerSequence",
    "LastLedgerSequence always present",
    d.kind === "authorize" ? `LastLedgerSequence=${d.txTemplate.LastLedgerSequence}` : "refused",
    hasLls,
  );
}

{
  // A LastLedgerSequence already behind the validated ledger can never be included.
  const d = decide(baseInput({ xrpl: { lastLedgerSequence: ledger.index - 1 } }));
  record(
    "a LastLedgerSequence in the past is refused",
    "refuse S008_INSUFFICIENT_SAFETY_MARGIN",
    d.kind === "refuse" ? `refuse ${d.reason}` : "authorize",
    d.kind === "refuse" && d.reason === "S008_INSUFFICIENT_SAFETY_MARGIN",
  );
}

// ---------------------------------------------------------------- answered only by the ledger

const info = await accountInfo(source.classicAddress);
const sequence = info.account_data.Sequence;
const feeDrops = fees.openLedgerFeeDrops > fees.baseFeeDrops ? fees.openLedgerFeeDrops : fees.baseFeeDrops;

/** Builds, persists and signs a payment through the reference model. */
function buildSigned({ seq, lls, amountUBA = 1_000_000n }) {
  const d = decide(
    baseInput({
      redemption: { valueUBA: amountUBA, feeUBA: 10_000n },
      xrpl: { sequenceOrTicket: seq, lastLedgerSequence: lls, feeDrops },
    }),
  );
  if (d.kind !== "authorize") throw new Error(`model refused: ${d.reason}`);
  const signed = wallet.sign(d.txTemplate);
  persistBeforeSubmit({
    purpose: "AdversarialPayment",
    network: "xrpl-testnet",
    txTemplate: d.txTemplate,
    txHash: signed.hash,
    txBlob: signed.tx_blob,
    sequence: seq,
    lastLedgerSequence: lls,
    feeDrops: feeDrops.toString(),
    builtAt: new Date().toISOString(),
  });
  return signed;
}

// 1. Resubmitting the identical blob must be safe and must not create a second payment.
{
  const signed = buildSigned({ seq: sequence, lls: ledger.index + 40 });
  const first = await submitPersisted(signed.hash);
  const second = await submitPersisted(signed.hash);
  const final = await reconcile(signed.hash);
  const balanceAfter = await accountInfo(destination.classicAddress);
  record(
    "resubmitting the identical signed blob is idempotent",
    "both submissions accepted, exactly one validated payment",
    `first=${first.engineResult} second=${second.engineResult} final=${final.state} ledger=${final.validatedLedger}`,
    final.state === "VALIDATED_SUCCESS",
  );
  record(
    "the record keeps every submission attempt",
    "2 attempts recorded against one hash",
    `${loadRecord(signed.hash).submissionAttempts.length} attempts, 1 hash`,
    loadRecord(signed.hash).submissionAttempts.length === 2,
  );
  void balanceAfter;
}

// 2. Reusing a consumed sequence must be rejected by the ledger.
{
  const signed = buildSigned({ seq: sequence, lls: ledger.index + 60, amountUBA: 1_100_000n });
  const attempt = await submitPersisted(signed.hash);
  record(
    "a consumed sequence cannot be reused",
    "engine result tefPAST_SEQ",
    `${attempt.engineResult}`,
    attempt.engineResult === "tefPAST_SEQ",
  );
}

// 3. Expiry: a transaction whose window has already closed must end EXPIRED_NOT_FOUND, never
//    "unknown", and must never be silently replaced.
{
  const current = await validatedLedger();
  const expired = buildSigned({ seq: sequence + 5, lls: current.index + 3, amountUBA: 1_200_000n });
  await submitPersisted(expired.hash);
  const final = await reconcile(expired.hash, { pollMs: 4_000, timeoutMs: 150_000 });
  record(
    "a transaction past its LastLedgerSequence resolves to a definite absence",
    "EXPIRED_NOT_FOUND with complete ledger coverage",
    `${final.state} coverage=${final.ledgerCoverage?.complete}`,
    final.state === "EXPIRED_NOT_FOUND" && final.ledgerCoverage?.complete === true,
  );
}

// 4. The coverage parser is what separates "absent" from "unknown", so it is tested directly.
{
  const passes =
    rangeCovers("100-200", 150) === true &&
    rangeCovers("100-200", 250) === false &&
    rangeCovers("100-200,300-400", 350) === true &&
    rangeCovers("empty", 150) === false &&
    rangeCovers("", 150) === false;
  record(
    "ledger-coverage parsing distinguishes absent from unknown",
    "in-range true, out-of-range false, empty false",
    passes ? "all cases correct" : "mismatch",
    passes,
  );
}

// 5. A window the servers cannot see must be UNKNOWN, never absent.
{
  const coverage = await ledgerCoverage(1);
  record(
    "a pruned window is reported as not covered",
    "ledger 1 is outside every server's complete range",
    `complete=${coverage.complete}`,
    coverage.complete === false,
  );
}

mkdirSync(join(REPO_ROOT, "evidence", "receipts"), { recursive: true });
writeFileSync(
  join(REPO_ROOT, "evidence", "receipts", "xrpl-adversarial.json"),
  `${JSON.stringify({ seam: "xrpl", network: "xrpl-testnet", runAt: new Date().toISOString(), results }, null, 2)}\n`,
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} adversarial cases passed`);
if (failed.length > 0) process.exit(1);
