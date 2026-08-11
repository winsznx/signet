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
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * Error class per PRD section 23.1. A transient infrastructure failure must never be recorded as a
 * permanent policy denial (FR-024), so the class travels with the refusal rather than being
 * inferred from the code by each consumer.
 */
export type ErrorClass = "POLICY_DENIAL" | "TRANSIENT_INFRA";

const TRANSIENT: ReadonlySet<ReasonCode> = new Set<ReasonCode>(["S017_STATE_UNAVAILABLE"]);

export function errorClassOf(reason: ReasonCode): ErrorClass {
  return TRANSIENT.has(reason) ? "TRANSIENT_INFRA" : "POLICY_DENIAL";
}

export function isReasonCode(value: string): value is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(value);
}
