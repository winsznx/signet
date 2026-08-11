#!/usr/bin/env node
/**
 * Checkpoint and resume correctness, as a regression test.
 *
 * The independent verifier caught this in the target-chain run: a resumed run recomputed its
 * decision instead of reading the one it had checkpointed, so the receipt recorded a template with a
 * fresh account sequence while naming the transaction hash of the payment actually signed. The
 * commitment did not match the payment, and only an outside check noticed.
 *
 * V2 makes that worse if it recurs, because the observation is bound into the commitment. A resumed
 * run recomputing its decision would take a fresh observation at a later ledger and produce a
 * commitment describing a look that happened after the payment it justified.
 *
 * The rule is one line: **a resumed run reports the decision it checkpointed, never a new one.**
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name, ok, note = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${note ? `  ${note}` : ""}`);
}

const dir = mkdtempSync(join(tmpdir(), "signet-checkpoint-"));
const STATE = join(dir, "state.json");

const load = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

/**
 * The shape of a lifecycle run, reduced to the part that goes wrong.
 *
 * `observedLedger` stands in for everything that moves between runs: the ledger, the account
 * sequence, the fee. A resumed run that recomputes picks up new values; one that reads its
 * checkpoint does not.
 */
function runOnce({ observedLedger, crashAfterSign = false, recomputeOnResume = false }) {
  const state = load();

  if (!state.payment) {
    const decision = {
      observedAtLedger: observedLedger,
      sequence: 19_822_000 + observedLedger,
      authorizationCommitment: `0xcommit-${observedLedger}`,
    };
    const signed = { txHash: `0xTX-${decision.sequence}`, decision, template: { Sequence: decision.sequence } };
    state.payment = signed;
    save(state);
    if (crashAfterSign) throw new Error("crash after signing, before the receipt");
  }

  // The bug: recomputing rather than reading the checkpoint.
  const decision = recomputeOnResume
    ? { observedAtLedger: observedLedger, sequence: 19_822_000 + observedLedger, authorizationCommitment: `0xcommit-${observedLedger}` }
    : state.payment.decision;

  return {
    txHash: state.payment.txHash,
    commitment: decision.authorizationCommitment,
    sequence: decision.sequence,
    observedAtLedger: decision.observedAtLedger,
  };
}

// ---------------------------------------------------------------- the incident, in miniature

rmSync(STATE, { force: true });
let crashed = false;
try {
  runOnce({ observedLedger: 100, crashAfterSign: true });
} catch {
  crashed = true;
}
check("a crash after signing leaves the payment checkpointed", crashed && Boolean(load().payment), load().payment?.txHash);

const buggy = runOnce({ observedLedger: 140, recomputeOnResume: true });
check(
  "recomputing on resume produces a receipt that describes a different payment",
  buggy.commitment !== `0xcommit-100` && buggy.txHash === "0xTX-19822100",
  `names ${buggy.txHash} but commits to ledger ${buggy.observedAtLedger}`,
);

// ---------------------------------------------------------------- the fix

rmSync(STATE, { force: true });
try {
  runOnce({ observedLedger: 100, crashAfterSign: true });
} catch {
  // expected
}
const resumed = runOnce({ observedLedger: 140 });
check(
  "reading the checkpoint reports the decision that was actually signed",
  resumed.commitment === "0xcommit-100" && resumed.observedAtLedger === 100,
  `commitment ${resumed.commitment}, observed at ${resumed.observedAtLedger}`,
);
check(
  "the receipt's sequence matches the transaction it names",
  resumed.sequence === 19_822_100 && resumed.txHash === "0xTX-19822100",
  `${resumed.txHash} / Sequence ${resumed.sequence}`,
);

const twice = runOnce({ observedLedger: 900 });
check(
  "resuming repeatedly never changes the answer",
  twice.commitment === resumed.commitment && twice.txHash === resumed.txHash,
  "idempotent",
);

// ---------------------------------------------------------------- the real scripts obey the rule

const sources = ["scripts/lifecycle/target-chain.mjs"];
for (const file of sources) {
  const text = readFileSync(join(process.cwd(), file), "utf8");
  check(
    `${file} checkpoints the decision alongside the payment`,
    /state\.payment\s*=\s*\{[^}]*decision/s.test(text),
    "decision is stored, not recomputed",
  );
  check(
    `${file} reads the checkpointed decision when resuming`,
    /state\.payment\.decision\s*\?\?/.test(text),
    "signedDecision falls back to the checkpoint",
  );
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "checkpoint and resume are correct" : `${failures} checkpoint checks failed`}`);
process.exit(failures === 0 ? 0 : 1);
