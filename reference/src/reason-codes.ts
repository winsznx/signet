/**
 * Stable refusal reason codes, frozen by PRD section 20.4.
 *
 * These strings are protocol surface: they appear in signed refusal receipts and in public
 * evidence, so a code may be added but never renamed or repurposed.
 */
export const REASON_CODES = [
  "S001_UNKNOWN_SCHEMA",
  "S002_WRONG_DOMAIN",
  "S003_UNBOUND_AGENT",
  "S004_INACTIVE_REDEMPTION",
  "S005_WRONG_AGENT",
  "S006_ALREADY_CONSUMED",
  "S007_EXPIRED_WINDOW",
  "S008_INSUFFICIENT_SAFETY_MARGIN",
  "S009_DESTINATION_INVALID",
  "S010_AMOUNT_INVALID",
  "S011_REFERENCE_INVALID",
  "S012_TAG_INVALID",
  "S013_FEE_CAP_EXCEEDED",
  "S014_SEQUENCE_CONFLICT",
  "S015_CODE_VERSION_REVOKED",
  "S016_PAUSED",
  "S017_STATE_UNAVAILABLE",
  "S018_REPLACEMENT_NOT_AUTHORIZED",
  "S019_KEY_NOT_ACTIVE",
  "S020_INTERNAL_FAIL_CLOSED",
  "S021_PAYMENT_ALREADY_OBSERVED",
  "S022_UNDERLYING_STATE_UNAVAILABLE",
  "S023_UNDERLYING_STATE_DISAGREEMENT",
  "S024_UNDERLYING_OBSERVATION_STALE",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * Error class per PRD section 23.1. A transient infrastructure failure must never be recorded as a
 * permanent policy denial (FR-024), so the class travels with the refusal rather than being
 * inferred from the code by each consumer.
 */
export type ErrorClass = "POLICY_DENIAL" | "TRANSIENT_INFRA";

/**
 * `S023_UNDERLYING_STATE_DISAGREEMENT` is deliberately not transient.
 *
 * Two XRPL endpoints disagreeing about whether an obligation has already been paid usually means one
 * is lagging, and retrying would usually resolve it. That is exactly why it must not be retried
 * automatically: a loop that retries until the sources agree is a loop that keeps asking until it
 * gets the answer that lets it pay. A disagreement about whether money has already moved is an
 * operator's decision, not a scheduler's.
 *
 * `S024_UNDERLYING_OBSERVATION_STALE` is transient, because a stale observation becomes a fresh one
 * by looking again, and looking again is the correct response rather than a way of shopping for an
 * answer.
 */
const TRANSIENT: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "S017_STATE_UNAVAILABLE",
  "S022_UNDERLYING_STATE_UNAVAILABLE",
  "S024_UNDERLYING_OBSERVATION_STALE",
]);

export function errorClassOf(reason: ReasonCode): ErrorClass {
  return TRANSIENT.has(reason) ? "TRANSIENT_INFRA" : "POLICY_DENIAL";
}

export function isReasonCode(value: string): value is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(value);
}
