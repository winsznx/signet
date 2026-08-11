#!/usr/bin/env node
/**
 * Activates the Signet RegularKey on the agent's XRPL account.
 *
 * This is the one and only operation in the whole system that uses the master key. PRD FR-070 keeps
 * the master offline and outside every application, TEE and CI environment; here it is used once,
 * locally, to delegate ordinary signing authority to a rotatable RegularKey, and then it is not
 * touched again. Every payment afterwards is signed by the RegularKey.
 *
 * The master key is deliberately NOT disabled: it is the recovery path if the RegularKey is lost
 * or compromised (FR-070, G4).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "xrpl";
import { REPO_ROOT } from "../lib/source-lock.mjs";
import { accountInfo, currentFeeDrops, validatedLedger } from "./client.mjs";
import { persistBeforeSubmit, reconcile, submitPersisted } from "./submit.mjs";

const LEDGER_HEADROOM = 20;

function loadSecret(role) {
  return JSON.parse(readFileSync(join(REPO_ROOT, ".runtime", "secrets", `xrpl-${role}.json`), "utf8"));
}

const account = loadSecret("agent-source");
const regularKey = loadSecret("signet-regular-key");

const info = await accountInfo(account.classicAddress);
const already = info.account_data.RegularKey;
if (already === regularKey.classicAddress) {
  console.log(`RegularKey already active: ${already}`);
  process.exit(0);
}

const ledger = await validatedLedger();
const fees = await currentFeeDrops();
const sequence = info.account_data.Sequence;

const tx = {
  TransactionType: "SetRegularKey",
  Account: account.classicAddress,
  RegularKey: regularKey.classicAddress,
  Fee: (fees.openLedgerFeeDrops > fees.baseFeeDrops ? fees.openLedgerFeeDrops : fees.baseFeeDrops).toString(),
  Sequence: sequence,
  LastLedgerSequence: ledger.index + LEDGER_HEADROOM,
};

// Signed by the master key, the only time it is ever used.
const wallet = Wallet.fromSeed(account.seed, { algorithm: "ed25519" });
const signed = wallet.sign(tx);

const { path } = persistBeforeSubmit({
  purpose: "SetRegularKey",
  network: "xrpl-testnet",
  account: account.classicAddress,
  regularKey: regularKey.classicAddress,
  txHash: signed.hash,
  txBlob: signed.tx_blob,
  sequence,
  lastLedgerSequence: tx.LastLedgerSequence,
  feeDrops: tx.Fee,
  builtAt: new Date().toISOString(),
});
console.log(`persisted before submit: ${path.replace(REPO_ROOT, ".")}`);
console.log(`  txHash ${signed.hash}`);

const provisional = await submitPersisted(signed.hash);
console.log(`  provisional engine result ${provisional.engineResult} (not a result)`);

const final = await reconcile(signed.hash);
console.log(`  final state ${final.state} at validated ledger ${final.validatedLedger ?? "n/a"}`);

if (final.state !== "VALIDATED_SUCCESS") {
  console.error("SetRegularKey did not reach validated success");
  process.exit(1);
}

// Read the configuration back from a validated ledger. Rotation is not complete until the new
// configuration is independently observed (PRD section 12.3).
const after = await accountInfo(account.classicAddress);
console.log(`  account RegularKey now ${after.account_data.RegularKey}`);
if (after.account_data.RegularKey !== regularKey.classicAddress) {
  console.error("account does not report the expected RegularKey");
  process.exit(1);
}
console.log(`  master key retained for recovery (lsfDisableMaster not set)`);
