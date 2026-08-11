#!/usr/bin/env node
/**
 * Sends one exact XRPL Testnet payment whose every field was produced by the reference model.
 *
 * This is the point of the phase. The transaction is not hand-built here and then compared against
 * the model: the model's `txTemplate` IS the transaction. The only things added are the signature
 * and the network's own view of sequence, fee and ledger height, all of which are fed back into the
 * model as inputs before it decides. If the model ever produced a template the ledger rejects, this
 * script fails rather than quietly correcting it.
 *
 * Signed by the RegularKey. The master key is not used and is not present in this path.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "xrpl";
import { REPO_ROOT } from "../lib/source-lock.mjs";
import { accountInfo, currentFeeDrops, validatedLedger, XRPL_NETWORK_ID } from "./client.mjs";
import { persistBeforeSubmit, reconcile, submitPersisted } from "./submit.mjs";
import { decide } from "../../reference/src/decide.ts";
import { redemptionPaymentReference } from "../../reference/src/payment-reference.ts";
import { toHex } from "../../reference/src/bytes.ts";

const REQUEST_ID = 44851498n; // the real Coston2 obligation decoded in phase 02
const AMOUNT_UBA = 2_000_000n; // 2 XRP, small enough to repeat
const FEE_UBA = 10_000n;

function loadSecret(role) {
  return JSON.parse(readFileSync(join(REPO_ROOT, ".runtime", "secrets", `xrpl-${role}.json`), "utf8"));
}

const source = loadSecret("agent-source");
const destination = loadSecret("redeemer-destination");
const regularKey = loadSecret("signet-regular-key");

const [info, ledger, fees] = await Promise.all([
  accountInfo(source.classicAddress),
  validatedLedger(),
  currentFeeDrops(),
]);

const sequence = info.account_data.Sequence;
const feeDrops = fees.openLedgerFeeDrops > fees.baseFeeDrops ? fees.openLedgerFeeDrops : fees.baseFeeDrops;
const lastLedgerSequence = ledger.index + 40;

// The obligation is shaped exactly as the reference model expects. The underlying-window fields are
// set from the live ledger so the model's own deadline and margin checks do real work here rather
// than being satisfied by convenient constants.
const input = {
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
    requestId: REQUEST_ID,
    requestGeneration: 0,
    status: "ACTIVE",
    agentVault: "0x55c815260cBE6c45Fe5bFe5FF32E3C7D746f14dC",
    paymentAddress: destination.classicAddress,
    paymentReference: toHex(redemptionPaymentReference(REQUEST_ID)),
    valueUBA: AMOUNT_UBA,
    feeUBA: FEE_UBA,
    firstUnderlyingBlock: BigInt(ledger.index - 10),
    lastUnderlyingBlock: BigInt(ledger.index + 400),
    lastUnderlyingTimestamp: BigInt(Math.floor(Date.now() / 1000) + 3_600),
    requiresDestinationTag: false,
    destinationTag: 0n,
    assetMintingDecimals: 6,
  },
  xrpl: {
    sequenceMode: "SEQUENCE",
    sequenceOrTicket: sequence,
    currentValidatedLedger: ledger.index,
    currentLedgerCloseTime: BigInt(Math.floor(Date.now() / 1000)),
    lastLedgerSequence,
    feeDrops,
    maxFeeDrops: 50_000n,
    baseFeeDrops: fees.baseFeeDrops,
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
  },
  prior: [],
};

const decision = decide(input);
if (decision.kind !== "authorize") {
  console.error(`reference model refused: ${decision.reason}`);
  process.exit(1);
}

console.log("reference model authorized");
console.log(`  commitment ${decision.authorizationCommitment}`);
console.log(`  template   ${JSON.stringify(decision.txTemplate)}`);

// Submitted verbatim. Nothing is added, removed or corrected.
const tx = { ...decision.txTemplate };

const wallet = Wallet.fromSeed(regularKey.seed, { algorithm: "ed25519" });
const signed = wallet.sign(tx);

const { path } = persistBeforeSubmit({
  purpose: "RedemptionPayment",
  network: "xrpl-testnet",
  requestId: REQUEST_ID.toString(),
  authorizationCommitment: decision.authorizationCommitment,
  obligationHash: decision.obligationHash,
  txTemplate: tx,
  txHash: signed.hash,
  txBlob: signed.tx_blob,
  signedBy: "regular-key",
  signerPublicKey: regularKey.publicKey,
  sequence,
  lastLedgerSequence,
  feeDrops: feeDrops.toString(),
  builtAt: new Date().toISOString(),
});

console.log(`persisted before submit: ${path.replace(REPO_ROOT, ".")}`);
console.log(`  txHash ${signed.hash}`);

const provisional = await submitPersisted(signed.hash);
console.log(`  provisional ${provisional.engineResult} (not a result)`);

const final = await reconcile(signed.hash);
console.log(`  final state ${final.state} at validated ledger ${final.validatedLedger ?? "n/a"}`);

if (final.state !== "VALIDATED_SUCCESS") {
  console.error(`payment did not reach validated success: ${final.state}`);
  process.exit(1);
}

mkdirSync(join(REPO_ROOT, "evidence", "receipts"), { recursive: true });
writeFileSync(
  join(REPO_ROOT, "evidence", "receipts", `xrpl-payment-${signed.hash}.json`),
  `${JSON.stringify(
    {
      seam: "xrpl",
      network: "xrpl-testnet",
      requestId: REQUEST_ID.toString(),
      authorizationCommitment: decision.authorizationCommitment,
      obligationHash: decision.obligationHash,
      txHash: signed.hash,
      validatedLedger: final.validatedLedger,
      engineResult: final.engineResult,
      closeTime: final.closeTime,
      template: tx,
      signedBy: "regular-key",
      explorer: `https://testnet.xrpl.org/transactions/${signed.hash}`,
    },
    null,
    2,
  )}\n`,
);
console.log(`  receipt evidence/receipts/xrpl-payment-${signed.hash}.json`);
console.log(`  explorer https://testnet.xrpl.org/transactions/${signed.hash}`);
