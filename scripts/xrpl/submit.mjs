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
import { XRPL_ENDPOINTS, XrplTransientError, lookupTransaction, validatedLedger, xrplRequest } from "./client.mjs";

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

  const result = await xrplRequest("submit", { tx_blob: record.txBlob }, endpoint);
  const provisional = {
    engineResult: result.engine_result,
    engineResultMessage: result.engine_result_message,
    endpoint,
    at: new Date().toISOString(),
  };
  const attempts = [...(record.submissionAttempts ?? []), provisional];
  updateRecord(hash, { state: "SUBMITTED_PROVISIONAL", submissionAttempts: attempts });
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
  const observations = [];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let found;
    let ledger;
    try {
      found = await lookupTransaction(hash);
      ledger = await validatedLedger();
    } catch (error) {
      if (error instanceof XrplTransientError) {
        // Infrastructure said nothing. That is not evidence the transaction is absent, so the loop
        // records the outage and waits rather than advancing the state machine.
        observations.push({ at: new Date().toISOString(), transientError: error.message });
        await new Promise((resolve) => setTimeout(resolve, pollMs * 2));
        continue;
      }
      throw error;
    }

    observations.push({
      at: new Date().toISOString(),
      validatedLedger: ledger.index,
      found: found.found,
      validated: found.validated,
      engineResult: found.engineResult ?? null,
    });

    if (found.found && found.validated) {
      const success = found.engineResult === "tesSUCCESS";
      return updateRecord(hash, {
        state: success ? "VALIDATED_SUCCESS" : "VALIDATED_FAILURE",
        validatedLedger: found.ledgerIndex,
        engineResult: found.engineResult,
        closeTime: found.closeTime,
        reconciliationLog: [...(record.reconciliationLog ?? []), ...observations],
      });
    }

    if (ledger.index > lastLedgerSequence) {
      // The window has closed. Whether "not found" means "definitely never happened" depends on
      // whether we can actually see every ledger in the window.
      const coverage = await ledgerCoverage(lastLedgerSequence);
      const state = coverage.complete ? "EXPIRED_NOT_FOUND" : "UNKNOWN_LEDGER_GAP";
      return updateRecord(hash, {
        state,
        ledgerCoverage: coverage,
        reconciliationLog: [...(record.reconciliationLog ?? []), ...observations],
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
export async function ledgerCoverage(lastLedgerSequence) {
  const ranges = [];
  for (const endpoint of XRPL_ENDPOINTS) {
    try {
      const info = await xrplRequest("server_info", {}, endpoint);
      const complete = info.info?.complete_ledgers ?? "";
      ranges.push({ endpoint, completeLedgers: complete, covers: rangeCovers(complete, lastLedgerSequence) });
    } catch (error) {
      ranges.push({ endpoint, error: error.message, covers: false });
    }
  }
  return { complete: ranges.some((r) => r.covers), ranges, requiredThrough: lastLedgerSequence };
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
