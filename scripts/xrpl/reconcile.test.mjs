#!/usr/bin/env node
/**
 * Regression tests for the reconciliation state machine, with a stubbed transport.
 *
 * These exist because a security review reproduced a path where `reconcile` reported
 * `EXPIRED_NOT_FOUND` on the word of an endpoint that was never asked whether it had the
 * transaction. `EXPIRED_NOT_FOUND` is what a later phase will consume to authorize a replacement,
 * so that bug could have produced a second validated payment for one obligation.
 *
 * The live adversarial suite cannot cover this: it needs two endpoints to disagree on demand.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/source-lock.mjs";
import { XRPL_ENDPOINTS } from "./client.mjs";
import { reconcile, rangeCoversSpan } from "./submit.mjs";

const STORE = join(REPO_ROOT, ".runtime", "xrpl", "submissions");
const [ENDPOINT_A, ENDPOINT_B] = XRPL_ENDPOINTS;

const results = [];
function check(name, expected, observed, pass) {
  results.push({ name, pass });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}\n       expected ${expected}\n       observed ${observed}`);
}

const realFetch = globalThis.fetch;

/**
 * Stubs the transport per endpoint. `plan[endpoint]` supplies the `tx` and `server_info` answers,
 * and every call is counted so a test can assert who was actually asked.
 */
function stubTransport(plan) {
  const calls = Object.fromEntries(XRPL_ENDPOINTS.map((e) => [e, { tx: 0, server_info: 0 }]));
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url);
    const { method } = JSON.parse(init.body);
    calls[endpoint][method] = (calls[endpoint][method] ?? 0) + 1;
    const answer = plan[endpoint]?.[method];
    if (answer === undefined) throw new Error(`no stub for ${method} at ${endpoint}`);
    return { ok: true, status: 200, json: async () => ({ result: answer }) };
  };
  return calls;
}

function persistFixture(hash, record) {
  mkdirSync(STORE, { recursive: true });
  writeFileSync(join(STORE, `${hash}.json`), `${JSON.stringify({ txHash: hash, ...record }, null, 2)}\n`);
}

function cleanup(hash) {
  rmSync(join(STORE, `${hash}.json`), { force: true });
}

const txNotFound = { status: "error", error: "txnNotFound", error_message: "Transaction not found." };
const serverAt = (index, completeLedgers) => ({
  info: { validated_ledger: { seq: index, base_fee_xrp: 0.00001, reserve_base_xrp: 1 }, complete_ledgers: completeLedgers, time: "now" },
});

// ------------------------------------------------------------------ the reproduced exploit

{
  const hash = "TESTGAPA";
  persistFixture(hash, { state: "SUBMITTED_PROVISIONAL", lastLedgerSequence: 500, submittedAtLedger: 400, txBlob: "00" });

  // Endpoint A is asked and says "not found", but it cannot see the window.
  // Endpoint B could see the window, but is also asked and also says not found... except here it
  // is the ONLY one with coverage while A is the one that answered. The old code accepted B's
  // coverage as proof for A's answer.
  const calls = stubTransport({
    [ENDPOINT_A]: { tx: txNotFound, server_info: serverAt(600, "550-700") },
    [ENDPOINT_B]: { tx: txNotFound, server_info: serverAt(600, "1-1000") },
  });

  const final = await reconcile(hash, { pollMs: 1, timeoutMs: 5_000 });
  const bothAsked = calls[ENDPOINT_A].tx > 0 && calls[ENDPOINT_B].tx > 0;
  check(
    "an endpoint that cannot see the window cannot testify to absence alone",
    "every endpoint asked for the transaction; absence accepted only from a covering witness",
    `state=${final.state} askedA=${calls[ENDPOINT_A].tx} askedB=${calls[ENDPOINT_B].tx}`,
    final.state === "EXPIRED_NOT_FOUND" && bothAsked,
  );
  cleanup(hash);
}

{
  const hash = "TESTGAPB";
  persistFixture(hash, { state: "SUBMITTED_PROVISIONAL", lastLedgerSequence: 500, submittedAtLedger: 400, txBlob: "00" });

  // Now NO endpoint that answered can see the whole window. The answer must be unknown.
  stubTransport({
    [ENDPOINT_A]: { tx: txNotFound, server_info: serverAt(600, "550-700") },
    [ENDPOINT_B]: { tx: txNotFound, server_info: serverAt(600, "450-700") },
  });

  const final = await reconcile(hash, { pollMs: 1, timeoutMs: 5_000 });
  check(
    "a window no answering endpoint can see is unknown, never absent",
    "UNKNOWN_LEDGER_GAP",
    `${final.state}`,
    final.state === "UNKNOWN_LEDGER_GAP",
  );
  cleanup(hash);
}

{
  const hash = "TESTGAPC";
  persistFixture(hash, { state: "SUBMITTED_PROVISIONAL", lastLedgerSequence: 500, submittedAtLedger: 400, txBlob: "00" });

  // One endpoint has it validated. A single validated sighting settles it, even while the other
  // endpoint reports nothing: a validated ledger cannot be invented.
  stubTransport({
    [ENDPOINT_A]: { tx: txNotFound, server_info: serverAt(600, "1-1000") },
    [ENDPOINT_B]: {
      tx: { validated: true, meta: { TransactionResult: "tesSUCCESS" }, ledger_index: 480, close_time_iso: "now" },
      server_info: serverAt(600, "1-1000"),
    },
  });

  const final = await reconcile(hash, { pollMs: 1, timeoutMs: 5_000 });
  check(
    "one endpoint reporting a validated transaction settles it",
    "VALIDATED_SUCCESS even though another endpoint said not found",
    `${final.state} at ${final.validatedLedger}`,
    final.state === "VALIDATED_SUCCESS" && final.validatedLedger === 480,
  );
  cleanup(hash);
}

{
  const hash = "TESTGAPD";
  persistFixture(hash, { state: "SUBMITTED_PROVISIONAL", lastLedgerSequence: 500, submittedAtLedger: 400, txBlob: "00" });

  // Coverage that includes the last ledger but not the start of the window. The transaction could
  // have validated in the pruned head, so this must not be reported as absent.
  stubTransport({
    [ENDPOINT_A]: { tx: txNotFound, server_info: serverAt(600, "480-700") },
    [ENDPOINT_B]: { tx: txNotFound, server_info: serverAt(600, "490-700") },
  });

  const final = await reconcile(hash, { pollMs: 1, timeoutMs: 5_000 });
  check(
    "coverage of the window's end is not coverage of the window",
    "UNKNOWN_LEDGER_GAP",
    `${final.state}`,
    final.state === "UNKNOWN_LEDGER_GAP",
  );
  cleanup(hash);
}

globalThis.fetch = realFetch;

// ------------------------------------------------------------------ span parsing

{
  const cases = [
    [rangeCoversSpan("400-600", 400, 500), true, "exact containment"],
    [rangeCoversSpan("401-600", 400, 500), false, "start one short"],
    [rangeCoversSpan("400-499", 400, 500), false, "end one short"],
    [rangeCoversSpan("1-399,401-600", 400, 500), false, "split ranges do not compose"],
    [rangeCoversSpan("empty", 400, 500), false, "empty"],
    [rangeCoversSpan("", 400, 500), false, "blank"],
    [rangeCoversSpan(" 400 - 600 ", 400, 500), true, "whitespace tolerated"],
    [rangeCoversSpan("500", 500, 500), true, "single ledger"],
  ];
  const failed = cases.filter(([actual, expected]) => actual !== expected);
  check(
    "span coverage requires one contiguous range to contain the whole window",
    "8/8 parse cases correct",
    failed.length === 0 ? "8/8" : `failed: ${failed.map((c) => c[2]).join(", ")}`,
    failed.length === 0,
  );
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} reconciliation regression tests passed`);
if (failed.length > 0) process.exit(1);
