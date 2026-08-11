/**
 * Reliable XRPL submission, implementing the rules in PRD sections 8.5 and 15.2.
 *
 * The whole point of this module is what it refuses to do:
 *
 * - it never treats a provisional `submit` response as a result (FR-042);
 * - it persists the signed blob and its hash before the first submission, so a crash between
 *   signing and submitting cannot lose the transaction (FR-040);
 * - it resubmits the identical blob rather than building a new one, because a different
 *   transaction is a different generation (state machine 15.2);
 * - it distinguishes "expired, definitively absent" from "we do not know", and never lets the
 *   second look like the first (FR-043, FR-044).
 *
 * The state machine is BUILT -> SIGNED -> DURABLY_PERSISTED -> SUBMITTED_PROVISIONAL ->
 * VALIDATED_SUCCESS | VALIDATED_FAILURE | EXPIRED_NOT_FOUND | UNKNOWN_LEDGER_GAP.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/source-lock.mjs";
import { XRPL_ENDPOINTS, XrplTransientError, lookupTransaction, requestFrom, validatedLedger, xrplRequest } from "./client.mjs";

export const SUBMISSION_STATES = [
  "BUILT",
  "SIGNED",
  "DURABLY_PERSISTED",
  "SUBMITTED_PROVISIONAL",
  "VALIDATED_SUCCESS",
  "VALIDATED_FAILURE",
  "EXPIRED_NOT_FOUND",
  "UNKNOWN_LEDGER_GAP",
];

const STORE = join(REPO_ROOT, ".runtime", "xrpl", "submissions");

function recordPath(hash) {
  return join(STORE, `${hash}.json`);
}

/**
 * Writes the signed transaction to disk before anything is sent to the network.
 * This is the single most important ordering in the module: a signed blob that exists only in
 * memory is a payment that may already be spendable and that a restart would forget.
 */
export function persistBeforeSubmit(record) {
  mkdirSync(STORE, { recursive: true });
  const path = recordPath(record.txHash);
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, "utf8"));
    if (existing.txBlob !== record.txBlob) {
      throw new Error(`refusing to overwrite a different signed blob for ${record.txHash}`);
    }
    return { path, alreadyPersisted: true };
  }
  writeFileSync(
    path,
    `${JSON.stringify({ ...record, state: "DURABLY_PERSISTED", persistedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return { path, alreadyPersisted: false };
}

export function loadRecord(hash) {
  const path = recordPath(hash);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

export function updateRecord(hash, patch) {
  const record = loadRecord(hash);
  if (record === null) throw new Error(`no persisted record for ${hash}`);
  const updated = { ...record, ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(recordPath(hash), `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

/**
 * Submits an already-persisted blob. Returns the provisional engine result, which is explicitly
 * NOT a decision: the caller must reconcile.
 */
export async function submitPersisted(hash, endpoint = XRPL_ENDPOINTS[0]) {
  const record = loadRecord(hash);
  if (record === null) throw new Error(`refusing to submit ${hash}: not persisted first`);

  // The window a transaction could have validated in starts at the ledger current when it was
  // first submitted. Without this lower bound, coverage can only be checked at a single point, and
  // a node whose retention boundary is transiting the window would report it fully covered.
  const beforeSubmit = record.submittedAtLedger ?? (await validatedLedger()).index;

  const result = await xrplRequest("submit", { tx_blob: record.txBlob }, endpoint);
  const provisional = {
    engineResult: result.engine_result,
    engineResultMessage: result.engine_result_message,
    endpoint,
    at: new Date().toISOString(),
  };
  const attempts = [...(record.submissionAttempts ?? []), provisional];
  updateRecord(hash, {
    state: "SUBMITTED_PROVISIONAL",
    submissionAttempts: attempts,
    submittedAtLedger: beforeSubmit,
  });
  return provisional;
}

/**
 * Watches validated ledgers until the transaction reaches a final state.
 *
 * A transaction is only successful when a *validated* ledger says so. It is only definitively
 * absent when the validated ledger index has passed LastLedgerSequence AND the server's complete
 * ledger range actually covers the whole window; if there is a gap, the answer is
 * UNKNOWN_LEDGER_GAP and no replacement may be built (FR-044, I-010).
 */
export async function reconcile(hash, { pollMs = 4_000, timeoutMs = 180_000 } = {}) {
  const record = loadRecord(hash);
  if (record === null) throw new Error(`no persisted record for ${hash}`);
  const lastLedgerSequence = record.lastLedgerSequence;
  // Lower bound of the window. Falls back to the build ledger, and finally to the sequence itself,
  // so a missing bound can only ever make the coverage requirement stricter.
  const windowFrom = record.submittedAtLedger ?? record.builtAtLedger ?? lastLedgerSequence;
  const observations = [];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Ask every endpoint the same question. One endpoint's silence is not the ledger's answer, and
    // a "not found" is only usable later if it came from a server that can see the whole window.
    const answers = await Promise.all(
      XRPL_ENDPOINTS.map(async (endpoint) => {
        try {
          return { endpoint, ...(await lookupTransaction(hash, endpoint)) };
        } catch (error) {
          return { endpoint, transient: error instanceof XrplTransientError, error: error.message };
        }
      }),
    );

    const usable = answers.filter((a) => a.error === undefined);
    if (usable.length === 0) {
      // Infrastructure said nothing at all. That is not evidence about the ledger.
      observations.push({ at: new Date().toISOString(), outage: answers.map((a) => a.error) });
      await new Promise((resolve) => setTimeout(resolve, pollMs * 2));
      continue;
    }

    // A single endpoint reporting a validated transaction settles it. Absence needs consensus and
    // coverage; presence does not, because a validated ledger cannot be invented.
    const validatedHit = usable.find((a) => a.found && a.validated);
    if (validatedHit) {
      const success = validatedHit.engineResult === "tesSUCCESS";
      return updateRecord(hash, {
        state: success ? "VALIDATED_SUCCESS" : "VALIDATED_FAILURE",
        validatedLedger: validatedHit.ledgerIndex,
        engineResult: validatedHit.engineResult,
        closeTime: validatedHit.closeTime,
        settledBy: validatedHit.endpoint,
        reconciliationLog: [...(record.reconciliationLog ?? []), ...observations],
      });
    }

    let heights;
    try {
      heights = await Promise.all(
        usable.map(async (a) => ({ endpoint: a.endpoint, index: (await validatedLedger(a.endpoint)).index })),
      );
    } catch (error) {
      if (error instanceof XrplTransientError) {
        observations.push({ at: new Date().toISOString(), transientError: error.message });
        await new Promise((resolve) => setTimeout(resolve, pollMs * 2));
        continue;
      }
      throw error;
    }

    observations.push({
      at: new Date().toISOString(),
      answers: usable.map((a) => ({ endpoint: a.endpoint, found: a.found, validated: a.validated })),
      heights,
    });

    const pastWindow = heights.filter((h) => h.index > lastLedgerSequence).map((h) => h.endpoint);
    if (pastWindow.length > 0) {
      // Only endpoints that were actually asked about this transaction, said they do not have it,
      // and are themselves past the window may testify to its absence. Their own complete-ledger
      // range must then span the entire window, not merely its last ledger.
      const witnesses = usable
        .filter((a) => !a.found && pastWindow.includes(a.endpoint))
        .map((a) => a.endpoint);

      const coverage = await ledgerCoverage(windowFrom, lastLedgerSequence, witnesses);
      const state = coverage.complete ? "EXPIRED_NOT_FOUND" : "UNKNOWN_LEDGER_GAP";
      return updateRecord(hash, {
        state,
        ledgerCoverage: coverage,
        reconciliationLog: [...(record.reconciliationLog ?? []), ...observations],
        ...(state === "UNKNOWN_LEDGER_GAP"
          ? { note: "no endpoint both reported the transaction absent and proved it can see the whole window" }
          : {}),
      });
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return updateRecord(hash, {
    state: "UNKNOWN_LEDGER_GAP",
    reconciliationLog: [...(record.reconciliationLog ?? []), ...observations],
    note: "reconciliation timed out before the window closed; treated as unknown, never as absent",
  });
}

/**
 * Asks every endpoint whether its complete ledger history actually spans the payment window.
 * A server that has pruned the window cannot testify that a transaction is absent from it.
 */
export async function ledgerCoverage(fromLedger, toLedger, witnesses = XRPL_ENDPOINTS) {
  const ranges = [];
  for (const endpoint of witnesses) {
    try {
      // Asked of that endpoint specifically, with no rotation: the point is what THIS server can
      // see, so a fallback answer from a different one would defeat the check.
      const info = await requestFrom(endpoint, "server_info");
      const complete = info.info?.complete_ledgers ?? "";
      ranges.push({
        endpoint,
        completeLedgers: complete,
        covers: rangeCoversSpan(complete, fromLedger, toLedger),
      });
    } catch (error) {
      ranges.push({ endpoint, error: error.message, covers: false });
    }
  }
  return {
    complete: ranges.some((r) => r.covers),
    ranges,
    windowFrom: fromLedger,
    windowTo: toLedger,
    witnesses,
  };
}

/** True only when a single contiguous reported range contains the whole span. */
export function rangeCoversSpan(completeLedgers, fromLedger, toLedger) {
  if (typeof completeLedgers !== "string" || completeLedgers === "" || completeLedgers === "empty") return false;
  const from = Math.min(fromLedger, toLedger);
  const to = Math.max(fromLedger, toLedger);
  for (const part of completeLedgers.split(",")) {
    const bounds = part.split("-").map((n) => Number.parseInt(n.trim(), 10));
    const lo = bounds[0];
    const hi = bounds.length > 1 ? bounds[1] : bounds[0];
    if (Number.isFinite(lo) && Number.isFinite(hi) && from >= lo && to <= hi) return true;
  }
  return false;
}

/** Parses rippled's "a-b,c-d" complete_ledgers string and asks whether `target` falls inside it. */
export function rangeCovers(completeLedgers, target) {
  if (typeof completeLedgers !== "string" || completeLedgers === "" || completeLedgers === "empty") return false;
  for (const part of completeLedgers.split(",")) {
    const [from, to] = part.split("-").map((n) => Number.parseInt(n.trim(), 10));
    if (Number.isFinite(from) && Number.isFinite(to) && target >= from && target <= to) return true;
    if (Number.isFinite(from) && !Number.isFinite(to) && target === from) return true;
  }
  return false;
}
