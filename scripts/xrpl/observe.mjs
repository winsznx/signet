/**
 * Observes the XRP ledger for payments already carrying an obligation's payment reference.
 *
 * This is the sensor for the check that incident 44928272 was missing. Its output goes into the
 * decision as `underlying`, and its correctness is the whole value of that check: a sensor that
 * returns an empty list when it cannot see is worse than no sensor, because the decision would then
 * authorize while believing it had looked.
 *
 * Three rules follow from that.
 *
 * **Every endpoint is asked, and they must agree.** One endpoint is one party. Two independently
 * operated endpoints that return different answers about whether money has already moved is a
 * safety signal, not a reason to pick one.
 *
 * **Absence is only reported by a source that could have seen presence.** An endpoint whose ledger
 * history does not cover the obligation's window cannot testify that nothing happened in it. This is
 * the same rule the reconciler learned in phase 04, applied to a different question.
 *
 * **Failure is reported as failure.** `available: false` and `agreed: false` are distinct outputs
 * and both refuse downstream. Nothing here ever silently degrades to an empty result.
 */
import { readSourceLock } from "../lib/source-lock.mjs";

const lock = readSourceLock();
export const XRPL_ENDPOINTS = lock.networks.xrplTestnet.rpc;

/** How far back to look. A redemption window is hundreds of ledgers, so this is generous. */
const DEFAULT_LOOKBACK = 400;

async function rpc(endpoint, method, params, fetchImpl) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params: [params] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
  const body = await response.json();
  if (body?.result?.error) throw new Error(`${endpoint}: ${body.result.error}`);
  return body.result;
}

/** rippled and clio disagree about where the transaction body lives in an account_tx entry. */
function bodyOf(entry) {
  return entry.tx_json ?? entry.tx ?? entry.transaction ?? null;
}

function parseCompleteLedgers(text) {
  if (typeof text !== "string" || text === "empty") return [];
  return text
    .split(",")
    .map((part) => part.split("-").map((n) => Number(n.trim())))
    .filter((range) => range.every((n) => Number.isFinite(n)))
    .map(([from, to]) => [from, to ?? from]);
}

const coversSpan = (ranges, from, to) => ranges.some(([lo, hi]) => lo <= from && hi >= to);

/**
 * Asks one endpoint what it holds for this destination, and whether it could have seen the span.
 *
 * Returns null when the endpoint cannot answer or cannot cover the span. Null is not an empty
 * result: the caller counts sources, and an endpoint that returns null is not counted as having
 * agreed to anything.
 */
async function observeFrom(endpoint, { destination, reference, fromLedger, toLedger }, fetchImpl) {
  let serverInfo;
  try {
    serverInfo = await rpc(endpoint, "server_info", {}, fetchImpl);
  } catch {
    return null;
  }
  const complete = parseCompleteLedgers(serverInfo?.info?.complete_ledgers);
  if (!coversSpan(complete, fromLedger, toLedger)) return null;

  let page;
  try {
    page = await rpc(
      endpoint,
      "account_tx",
      { account: destination, ledger_index_min: fromLedger, ledger_index_max: toLedger, limit: 400, binary: false },
      fetchImpl,
    );
  } catch {
    return null;
  }

  const wanted = reference.toLowerCase().replace(/^0x/, "");
  const payments = [];
  for (const entry of page?.transactions ?? []) {
    const tx = bodyOf(entry);
    if (!tx || tx.TransactionType !== "Payment") continue;
    if (tx.Destination !== destination) continue;
    const memo = tx.Memos?.[0]?.Memo?.MemoData?.toLowerCase();
    if (memo !== wanted) continue;
    const delivered = entry.meta?.delivered_amount ?? tx.DeliverMax ?? tx.Amount;
    payments.push({
      transactionHash: `0x${(entry.hash ?? tx.hash ?? "").toLowerCase()}`,
      destinationAddress: tx.Destination,
      amountDrops: String(typeof delivered === "string" ? delivered : (delivered?.value ?? "0")),
      paymentReference: `0x${wanted}`,
      // Only a validated payment counts. A provisional one is not a result.
      validated: entry.validated === true,
    });
  }
  payments.sort((a, b) => (a.transactionHash < b.transactionHash ? -1 : 1));
  return { endpoint, payments, ledgerIndex: Number(page?.ledger_index_max ?? toLedger) };
}

const fingerprint = (payments) =>
  JSON.stringify(payments.map((p) => [p.transactionHash, p.amountDrops, p.validated]));

/**
 * Builds the `underlying` snapshot the decision requires.
 *
 * The returned `observedAtLedger` is the LOWEST ledger index any agreeing source reported, not the
 * highest. A decision must not be told the ledger has been seen further than the weakest of its
 * witnesses actually saw, because the staleness check downstream is only meaningful if this number
 * is a floor rather than an aspiration.
 */
export async function observeUnderlying({
  destination,
  reference,
  currentValidatedLedger,
  lookback = DEFAULT_LOOKBACK,
  endpoints = XRPL_ENDPOINTS,
  fetchImpl = fetch,
  now = () => Math.floor(Date.now() / 1000),
}) {
  const toLedger = currentValidatedLedger;
  const fromLedger = Math.max(1, currentValidatedLedger - lookback);

  const answers = [];
  for (const endpoint of endpoints) {
    const answer = await observeFrom(endpoint, { destination, reference, fromLedger, toLedger }, fetchImpl);
    if (answer) answers.push(answer);
  }

  if (answers.length === 0) {
    return { available: false, agreed: false, sourceCount: 0, observedAtLedger: 0, observedAtTime: "0", payments: [] };
  }

  const first = fingerprint(answers[0].payments);
  const agreed = answers.every((a) => fingerprint(a.payments) === first);

  return {
    available: true,
    agreed,
    sourceCount: answers.length,
    observedAtLedger: Math.min(...answers.map((a) => a.ledgerIndex)),
    observedAtTime: String(now()),
    // On disagreement the union is reported rather than one side's view. The decision refuses on
    // disagreement anyway, and a reader of the evidence should see everything that was claimed.
    payments: agreed
      ? answers[0].payments
      : Object.values(
          Object.fromEntries(answers.flatMap((a) => a.payments).map((p) => [p.transactionHash, p])),
        ).sort((a, b) => (a.transactionHash < b.transactionHash ? -1 : 1)),
  };
}
