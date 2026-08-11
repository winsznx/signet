/**
 * Minimal XRPL JSON-RPC client.
 *
 * xrpl.js ships a WebSocket client. This uses JSON-RPC over HTTPS instead, for two reasons that
 * both matter to the product rather than to convenience: it works through an ordinary HTTP egress
 * path, and it keeps every step of submission explicit, so persist-before-submit and validated-only
 * reconciliation are things this code does rather than things a library does somewhere inside a
 * convenience wrapper.
 *
 * The SDK is still used for the parts where hand-rolling would be reckless: key handling, canonical
 * binary serialisation and signing.
 */
import { readFileSync } from "node:fs";
import { REPO_ROOT } from "../lib/source-lock.mjs";
import { join } from "node:path";

const lock = JSON.parse(readFileSync(join(REPO_ROOT, "docs", "source-lock.json"), "utf8"));

/** Both locked endpoints. Reconciliation must be able to consult more than one operator. */
export const XRPL_ENDPOINTS = lock.networks.xrplTestnet.rpc;
export const XRPL_FAUCET = lock.networks.xrplTestnet.faucet;
export const XRPL_NETWORK_ID = lock.networks.xrplTestnet.networkId;

export class XrplRpcError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "XrplRpcError";
    this.detail = detail;
  }
}

/**
 * HTTP statuses that mean "ask again", not "the answer is no".
 * 418 is what the public testnet cluster returns when it rate-limits a caller, which a
 * reconciliation loop will hit; treating it as an answer would let a rate limit masquerade as a
 * missing transaction.
 */
const RETRYABLE_STATUS = new Set([408, 418, 425, 429, 500, 502, 503, 504]);

export class XrplTransientError extends XrplRpcError {
  constructor(message, detail) {
    super(message, detail);
    this.name = "XrplTransientError";
  }
}

async function requestOnce(method, params, endpoint) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params: [params] }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    // A network failure is never evidence about the ledger.
    throw new XrplTransientError(`${method}: ${error.message}`, null);
  }
  if (RETRYABLE_STATUS.has(response.status)) {
    throw new XrplTransientError(`${method}: HTTP ${response.status}`, { status: response.status, endpoint });
  }
  if (!response.ok) throw new XrplRpcError(`${method}: HTTP ${response.status}`, { status: response.status });
  const body = await response.json();
  const result = body.result;
  if (result?.status === "error") {
    throw new XrplRpcError(`${method}: ${result.error} ${result.error_message ?? ""}`.trim(), result);
  }
  return result;
}

/**
 * Bounded retry with endpoint rotation (FR-012). Transient failures are retried against every
 * locked endpoint before giving up, and giving up raises a transient error rather than returning
 * anything a caller could mistake for a result.
 */
export async function xrplRequest(method, params = {}, endpoint = null) {
  const endpoints = endpoint ? [endpoint, ...XRPL_ENDPOINTS.filter((e) => e !== endpoint)] : [...XRPL_ENDPOINTS];
  let lastTransient = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (const target of endpoints) {
      try {
        return await requestOnce(method, params, target);
      } catch (error) {
        if (!(error instanceof XrplTransientError)) throw error;
        lastTransient = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
  }
  throw lastTransient ?? new XrplTransientError(`${method}: exhausted every endpoint`, null);
}

/** Asks every locked endpoint the same question. Disagreement is the caller's to handle, not to hide. */
export async function xrplRequestAll(method, params = {}) {
  const answers = [];
  for (const endpoint of XRPL_ENDPOINTS) {
    try {
      answers.push({ endpoint, ok: true, result: await xrplRequest(method, params, endpoint) });
    } catch (error) {
      answers.push({ endpoint, ok: false, error: error.message });
    }
  }
  return answers;
}

export async function validatedLedger(endpoint = XRPL_ENDPOINTS[0]) {
  const info = await xrplRequest("server_info", {}, endpoint);
  const ledger = info.info?.validated_ledger;
  if (!ledger) throw new XrplRpcError("server reports no validated ledger", info);
  return {
    index: ledger.seq,
    closeTimeIso: info.info.time,
    baseFeeXrp: ledger.base_fee_xrp,
    reserveBaseXrp: ledger.reserve_base_xrp,
    endpoint,
  };
}

export async function accountInfo(account, endpoint = XRPL_ENDPOINTS[0]) {
  return xrplRequest("account_info", { account, ledger_index: "validated" }, endpoint);
}

/**
 * Looks up a transaction and reports only what a validated ledger says.
 * A provisional server response is never a result (FR-042).
 */
export async function lookupTransaction(hash, endpoint = XRPL_ENDPOINTS[0]) {
  try {
    const result = await xrplRequest("tx", { transaction: hash, binary: false }, endpoint);
    return {
      found: true,
      validated: result.validated === true,
      engineResult: result.meta?.TransactionResult ?? null,
      ledgerIndex: result.ledger_index ?? null,
      closeTime: result.close_time_iso ?? null,
      raw: result,
    };
  } catch (error) {
    if (/txnNotFound/i.test(error.message)) return { found: false, validated: false };
    throw error;
  }
}

export async function currentFeeDrops(endpoint = XRPL_ENDPOINTS[0]) {
  const fee = await xrplRequest("fee", {}, endpoint);
  return {
    baseFeeDrops: BigInt(fee.drops.base_fee),
    openLedgerFeeDrops: BigInt(fee.drops.open_ledger_fee),
    medianFeeDrops: BigInt(fee.drops.median_fee),
  };
}
