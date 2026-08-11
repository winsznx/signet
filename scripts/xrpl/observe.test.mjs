#!/usr/bin/env node
/**
 * The observer's failure modes, against stubbed transports.
 *
 * This is the sensor for the check that incident 44928272 was missing, so what matters is not that
 * it finds payments when everything works. It is that it never reports "I looked and saw nothing"
 * when it did not look, could not look, or was told two different things.
 */
import { observeUnderlying } from "./observe.mjs";

let failures = 0;
function check(name, ok, note = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${note ? `  ${note}` : ""}`);
}

const DESTINATION = "rpa8bBa8GS1Zit6y9PcpQbahkqFahpWMyb";
const REFERENCE = "0x4642505266410002000000000000000000000000000000000000000002ad8d10";
const AGENT_PAYMENT_HASH = "8F304FB4F20D22D6E5B987D36A989A05E03C4900923B1D0FA01244CDD49E85E6";

const payment = (overrides = {}) => ({
  hash: AGENT_PAYMENT_HASH,
  validated: true,
  ledger_index: 19825006,
  meta: { delivered_amount: "9950000" },
  tx_json: {
    TransactionType: "Payment",
    Account: "rDYeqGVc8M3Se9wowvRDbURGYGZ5i5VF6r",
    Destination: DESTINATION,
    Amount: "9950000",
    Memos: [{ Memo: { MemoData: REFERENCE.slice(2).toUpperCase() } }],
  },
  ...overrides,
});

/** A transport that answers each endpoint from a script keyed by URL. */
function transport(byEndpoint) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const plan = byEndpoint[url];
    if (!plan) return new Response("nope", { status: 500 });
    if (body.method === "server_info") {
      if (plan.serverInfoFails) return new Response("boom", { status: 503 });
      return new Response(
        JSON.stringify({ result: { info: { complete_ledgers: plan.completeLedgers ?? "1-99999999" } } }),
        { status: 200 },
      );
    }
    if (body.method === "account_tx") {
      if (plan.accountTxFails) return new Response("boom", { status: 503 });
      // Pages are served from `plan.pages` when present, so a test can make the endpoint truncate.
      if (plan.pages) {
        const index = body.params[0].marker ?? 0;
        const page = plan.pages[index] ?? { transactions: [] };
        return new Response(
          JSON.stringify({
            result: {
              transactions: page.transactions ?? [],
              ledger_index_max: plan.ledgerIndex ?? 19825100,
              ...(page.next === undefined ? {} : { marker: page.next }),
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ result: { transactions: plan.transactions ?? [], ledger_index_max: plan.ledgerIndex ?? 19825100 } }),
        { status: 200 },
      );
    }
    return new Response("unexpected", { status: 500 });
  };
}

const A = "https://a.invalid";
const B = "https://b.invalid";
const base = { destination: DESTINATION, reference: REFERENCE, currentValidatedLedger: 19825100, endpoints: [A, B] };

// ---------------------------------------------------------------- the incident

{
  const observation = await observeUnderlying({
    ...base,
    fetchImpl: transport({ [A]: { transactions: [payment()] }, [B]: { transactions: [payment()] } }),
  });
  check("finds the agent's payment from incident 44928272", observation.payments.length === 1, observation.payments[0]?.transactionHash);
  check("reports it as available and agreed", observation.available && observation.agreed, `${observation.sourceCount} sources`);
  check("marks it validated", observation.payments[0]?.validated === true);
}

// ---------------------------------------------------------------- never a false empty

{
  const observation = await observeUnderlying({
    ...base,
    fetchImpl: transport({ [A]: { serverInfoFails: true }, [B]: { serverInfoFails: true } }),
  });
  check("no endpoint answering is unavailable, not empty", observation.available === false, `sourceCount=${observation.sourceCount}`);
}

{
  const observation = await observeUnderlying({
    ...base,
    fetchImpl: transport({ [A]: { accountTxFails: true }, [B]: { accountTxFails: true } }),
  });
  check("every endpoint failing mid-query is unavailable, not empty", observation.available === false);
}

{
  // Both endpoints answer, but neither holds the history that would let it see the span.
  const observation = await observeUnderlying({
    ...base,
    fetchImpl: transport({
      [A]: { completeLedgers: "19825090-19825100", transactions: [] },
      [B]: { completeLedgers: "19825095-19825100", transactions: [] },
    }),
  });
  check(
    "an endpoint that could not have seen the span may not testify to absence",
    observation.available === false,
    "history does not cover the window",
  );
}

// ---------------------------------------------------------------- disagreement

{
  const observation = await observeUnderlying({
    ...base,
    fetchImpl: transport({ [A]: { transactions: [payment()] }, [B]: { transactions: [] } }),
  });
  check("endpoints disagreeing is reported as disagreement", observation.agreed === false);
  check("disagreement still reports what was claimed", observation.payments.length === 1, "union, not one side's view");
}

{
  const observation = await observeUnderlying({
    ...base,
    fetchImpl: transport({
      [A]: { transactions: [payment()] },
      [B]: { transactions: [payment({ meta: { delivered_amount: "1" } })] },
    }),
  });
  check("a differing amount for the same hash is a disagreement", observation.agreed === false);
}

// ---------------------------------------------------------------- filtering

{
  const other = payment({ tx_json: { ...payment().tx_json, Memos: [{ Memo: { MemoData: "11".repeat(32) } }] } });
  const observation = await observeUnderlying({
    ...base,
    fetchImpl: transport({ [A]: { transactions: [other] }, [B]: { transactions: [other] } }),
  });
  check("a different obligation's reference is not this obligation", observation.payments.length === 0);
}

{
  const elsewhere = payment({ tx_json: { ...payment().tx_json, Destination: "r9oQTGAD1Wnuy5t8sPHA9LWTSdsho4AQ72" } });
  const observation = await observeUnderlying({
    ...base,
    fetchImpl: transport({ [A]: { transactions: [elsewhere] }, [B]: { transactions: [elsewhere] } }),
  });
  check("a payment to another destination is not this obligation", observation.payments.length === 0);
}

{
  const provisional = payment({ validated: false });
  const observation = await observeUnderlying({
    ...base,
    fetchImpl: transport({ [A]: { transactions: [provisional] }, [B]: { transactions: [provisional] } }),
  });
  check("a provisional payment is reported but not validated", observation.payments[0]?.validated === false);
}

// ---------------------------------------------------------------- pagination

{
  // The match is on the second page. Asking once and stopping would miss it entirely and still
  // report a clean look, which is the false empty this observer exists to never produce.
  const paged = { pages: { 0: { transactions: [], next: 1 }, 1: { transactions: [payment()] } } };
  const observation = await observeUnderlying({
    ...base,
    fetchImpl: transport({ [A]: paged, [B]: paged }),
  });
  check("a marker is followed rather than treated as the end", observation.payments.length === 1, "found on page two");
  check("the paged result is still reported as available and agreed", observation.available && observation.agreed);
}

{
  // An endpoint that never stops paging must not yield a partial answer.
  const endless = { pages: new Proxy({}, { get: () => ({ transactions: [], next: 1 }) }) };
  const observation = await observeUnderlying({
    ...base,
    fetchImpl: transport({ [A]: endless, [B]: endless }),
  });
  check(
    "an observation that ran out of pages is unavailable, not partial",
    observation.available === false,
    "a bounded loop reports failure rather than a subset",
  );
}

// ---------------------------------------------------------------- the observed ledger is a floor

{
  const observation = await observeUnderlying({
    ...base,
    fetchImpl: transport({
      [A]: { transactions: [], ledgerIndex: 19825100 },
      [B]: { transactions: [], ledgerIndex: 19825050 },
    }),
  });
  check(
    "observedAtLedger is the weakest witness, not the strongest",
    observation.observedAtLedger === 19825050,
    String(observation.observedAtLedger),
  );
}

console.log(`\n${failures === 0 ? "observer tests pass" : `${failures} observer tests failed`}`);
process.exit(failures === 0 ? 0 : 1);
