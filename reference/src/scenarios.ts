/**
 * The canonical scenario set.
 *
 * These are the inputs the frozen fixtures are generated from, and they are the same cases the Go
 * extension and the Solidity contracts must agree with. Every scenario is built by mutating one
 * field of the same valid base case, so a fixture difference always points at exactly one field
 * rather than at a wholesale rewrite.
 *
 * Addresses are constructed from fixed AccountIDs rather than copied from a live ledger, so the
 * fixtures depend on nothing external and can be regenerated offline.
 */
import type { Hex } from "./bytes.ts";
import { redemptionPaymentReference } from "./payment-reference.ts";
import { toHex } from "./bytes.ts";
import { encodeClassicAddress } from "./xrpl-address.ts";
import type { PriorGenerationSnapshot, ReferenceInput } from "./types.ts";

const accountId = (fill: number): Uint8Array => new Uint8Array(20).fill(fill);

export const SOURCE_ADDRESS = encodeClassicAddress(accountId(0x11));
export const DESTINATION_ADDRESS = encodeClassicAddress(accountId(0x22));
export const OTHER_ADDRESS = encodeClassicAddress(accountId(0x33));

const AGENT_VAULT = "0x00000000000000000000000000000000000000a1" as const;
const OTHER_AGENT_VAULT = "0x00000000000000000000000000000000000000a2" as const;
const ASSET_MANAGER = "0x00000000000000000000000000000000000000b1" as const;
const INSTRUCTION_SENDER = "0x00000000000000000000000000000000000000c1" as const;
const CODE_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const OTHER_CODE_HASH = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;

const REQUEST_ID = 4242n;

/**
 * The valid base case. Every other scenario is this with exactly one thing changed.
 *
 * The numbers are chosen to sit comfortably inside every bound so that a mutation, rather than an
 * accidental boundary, is what makes a scenario refuse.
 */
export function baseInput(): ReferenceInput {
  return {
    domain: {
      schemaVersion: 1,
      flareChainId: 114n,
      instructionSender: INSTRUCTION_SENDER,
      assetManager: ASSET_MANAGER,
      xrplNetworkId: 1,
    },
    binding: {
      agentVault: AGENT_VAULT,
      assetManager: ASSET_MANAGER,
      flareChainId: 114n,
      instructionSender: INSTRUCTION_SENDER,
      xrplNetworkId: 1,
      xrplSourceAddress: SOURCE_ADDRESS,
      signingMode: "REGULAR_KEY",
      signerCount: 0,
      keyState: "ACTIVE",
      status: "ACTIVE",
      extensionId: 7n,
      approvedCodeHash: CODE_HASH,
      policyVersion: 1,
    },
    redemption: {
      requestId: REQUEST_ID,
      requestGeneration: 0,
      status: "ACTIVE",
      agentVault: AGENT_VAULT,
      paymentAddress: DESTINATION_ADDRESS,
      paymentReference: toHex(redemptionPaymentReference(REQUEST_ID)) as Hex,
      valueUBA: 10_000_000n,
      feeUBA: 50_000n,
      firstUnderlyingBlock: 19_800_000n,
      lastUnderlyingBlock: 19_800_500n,
      lastUnderlyingTimestamp: 1_800_000_900n,
      requiresDestinationTag: false,
      destinationTag: 0n,
      assetMintingDecimals: 6,
    },
    xrpl: {
      sequenceMode: "SEQUENCE",
      sequenceOrTicket: 91,
      currentValidatedLedger: 19_800_010,
      currentLedgerCloseTime: 1_800_000_020n,
      lastLedgerSequence: 19_800_110,
      feeDrops: 12n,
      maxFeeDrops: 5_000n,
      baseFeeDrops: 10n,
    },
    policy: {
      policyVersion: 1,
      extensionId: 7n,
      extensionCodeHash: CODE_HASH,
      revokedCodeHashes: [],
      paused: false,
      safetyMarginLedgers: 50,
      safetyMarginSeconds: 300n,
      ledgerCloseIntervalSeconds: 4n,
    },
    prior: [],
  };
}

type Mutator = (input: ReferenceInput) => ReferenceInput;

const withRedemption = (patch: Partial<NonNullable<ReferenceInput["redemption"]>>): Mutator => (input) => ({
  ...input,
  redemption: input.redemption === null ? null : { ...input.redemption, ...patch },
});

const withBinding = (patch: Partial<NonNullable<ReferenceInput["binding"]>>): Mutator => (input) => ({
  ...input,
  binding: input.binding === null ? null : { ...input.binding, ...patch },
});

const withXrpl = (patch: Partial<NonNullable<ReferenceInput["xrpl"]>>): Mutator => (input) => ({
  ...input,
  xrpl: input.xrpl === null ? null : { ...input.xrpl, ...patch },
});

const withPolicy = (patch: Partial<ReferenceInput["policy"]>): Mutator => (input) => ({
  ...input,
  policy: { ...input.policy, ...patch },
});

const withDomain = (patch: Partial<ReferenceInput["domain"]>): Mutator => (input) => ({
  ...input,
  domain: { ...input.domain, ...patch },
});

const withPrior = (prior: readonly PriorGenerationSnapshot[]): Mutator => (input) => ({ ...input, prior });

export interface Scenario {
  readonly id: string;
  /** What this case is protecting against, in one line. */
  readonly intent: string;
  readonly expect: "authorize" | "refuse";
  readonly reason?: string;
  readonly mutate: Mutator;
}

const identity: Mutator = (input) => input;

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "valid-standard-memo",
    intent: "The base lawful obligation: memo mode, sequence allocation, comfortable margins.",
    expect: "authorize",
    mutate: identity,
  },
  {
    id: "valid-destination-tag",
    intent: "Tagged redemption mode carries an exact DestinationTag and a distinct commitment.",
    expect: "authorize",
    mutate: withRedemption({ requiresDestinationTag: true, destinationTag: 305_419_896n }),
  },
  {
    id: "valid-ticket-allocation",
    intent: "A pre-created Ticket carries the transaction instead of the account sequence.",
    expect: "authorize",
    mutate: withXrpl({ sequenceMode: "TICKET", sequenceOrTicket: 12_345 }),
  },
  {
    id: "valid-authorized-replacement",
    intent: "Generation 1 is authorized once generation 0 is proven not successful.",
    expect: "authorize",
    mutate: (input) =>
      withPrior([
        { requestGeneration: 0, sequenceMode: "SEQUENCE", sequenceOrTicket: 90, outcome: "PROVEN_NOT_SUCCESSFUL" },
      ])(withRedemption({ requestGeneration: 1 })(input)),
  },
  {
    id: "valid-minimum-amount",
    intent: "A one-drop obligation still converts exactly and authorizes.",
    expect: "authorize",
    mutate: withRedemption({ valueUBA: 2n, feeUBA: 1n }),
  },
  {
    id: "valid-tag-zero-required",
    intent: "A required tag of zero is distinct from no tag and must still authorize.",
    expect: "authorize",
    mutate: withRedemption({ requiresDestinationTag: true, destinationTag: 0n }),
  },

  {
    id: "refuse-unknown-schema",
    intent: "An unsupported schema version fails closed rather than being interpreted.",
    expect: "refuse",
    reason: "S001_UNKNOWN_SCHEMA",
    mutate: withDomain({ schemaVersion: 2 }),
  },
  {
    id: "refuse-wrong-asset-manager",
    intent: "A binding for a different asset manager is a cross-domain replay.",
    expect: "refuse",
    reason: "S002_WRONG_DOMAIN",
    mutate: withBinding({ assetManager: "0x00000000000000000000000000000000000000b2" }),
  },
  {
    id: "refuse-retired-binding",
    intent: "A retired binding may not authorize anything.",
    expect: "refuse",
    reason: "S003_UNBOUND_AGENT",
    mutate: withBinding({ status: "RETIRED" }),
  },
  {
    id: "refuse-inactive-redemption",
    intent: "Only an ACTIVE obligation can be paid.",
    expect: "refuse",
    reason: "S004_INACTIVE_REDEMPTION",
    mutate: withRedemption({ status: "DEFAULTED_UNCONFIRMED" }),
  },
  {
    id: "refuse-wrong-agent",
    intent: "An obligation assigned to another agent is not ours to pay.",
    expect: "refuse",
    reason: "S005_WRONG_AGENT",
    mutate: withRedemption({ agentVault: OTHER_AGENT_VAULT }),
  },
  {
    id: "refuse-already-successful",
    intent: "One obligation can produce at most one validated successful payment.",
    expect: "refuse",
    reason: "S006_ALREADY_CONSUMED",
    mutate: withPrior([
      { requestGeneration: 0, sequenceMode: "SEQUENCE", sequenceOrTicket: 90, outcome: "SUCCESSFUL" },
    ]),
  },
  {
    id: "refuse-duplicate-generation",
    intent: "Re-signing the same generation is a replay.",
    expect: "refuse",
    reason: "S006_ALREADY_CONSUMED",
    mutate: withPrior([
      { requestGeneration: 0, sequenceMode: "SEQUENCE", sequenceOrTicket: 90, outcome: "PROVEN_NOT_SUCCESSFUL" },
    ]),
  },
  {
    id: "refuse-expired-window",
    intent: "Both the block and the time limit have passed, so the obligation can no longer be paid.",
    expect: "refuse",
    reason: "S007_EXPIRED_WINDOW",
    mutate: withXrpl({ currentValidatedLedger: 19_800_600, currentLedgerCloseTime: 1_800_001_000n }),
  },
  {
    id: "refuse-margin-ledgers",
    intent: "LastLedgerSequence leaves too few ledgers before the obligation's last block.",
    expect: "refuse",
    reason: "S008_INSUFFICIENT_SAFETY_MARGIN",
    mutate: withXrpl({ lastLedgerSequence: 19_800_480 }),
  },
  {
    id: "refuse-margin-seconds",
    intent: "The projected close time leaves too little time before the obligation's deadline.",
    expect: "refuse",
    reason: "S008_INSUFFICIENT_SAFETY_MARGIN",
    mutate: withRedemption({ lastUnderlyingTimestamp: 1_800_000_500n }),
  },
  {
    id: "refuse-last-ledger-in-past",
    intent: "A LastLedgerSequence at or behind the validated ledger can never be included.",
    expect: "refuse",
    reason: "S008_INSUFFICIENT_SAFETY_MARGIN",
    mutate: withXrpl({ lastLedgerSequence: 19_800_010 }),
  },
  {
    id: "refuse-malformed-destination",
    intent: "A destination that is not a canonical classic address is never repaired.",
    expect: "refuse",
    reason: "S009_DESTINATION_INVALID",
    mutate: withRedemption({ paymentAddress: "rNotAValidAddress" }),
  },
  {
    id: "refuse-destination-checksum",
    intent: "A single-character corruption breaks base58check and must be rejected.",
    expect: "refuse",
    reason: "S009_DESTINATION_INVALID",
    mutate: (input) =>
      withRedemption({
        paymentAddress: `${DESTINATION_ADDRESS.slice(0, -1)}${DESTINATION_ADDRESS.endsWith("r") ? "p" : "r"}`,
      })(input),
  },
  {
    id: "refuse-destination-equals-source",
    intent: "Paying the bound account itself is never a lawful redemption payment.",
    expect: "refuse",
    reason: "S009_DESTINATION_INVALID",
    mutate: withRedemption({ paymentAddress: SOURCE_ADDRESS }),
  },
  {
    id: "refuse-zero-amount",
    intent: "A fee that consumes the whole value leaves nothing lawful to pay.",
    expect: "refuse",
    reason: "S010_AMOUNT_INVALID",
    mutate: withRedemption({ valueUBA: 50_000n, feeUBA: 50_000n }),
  },
  {
    id: "refuse-inexact-conversion",
    intent: "A UBA amount that is not a whole number of drops must refuse, never round.",
    expect: "refuse",
    reason: "S010_AMOUNT_INVALID",
    mutate: withRedemption({ assetMintingDecimals: 9, valueUBA: 10_000_001n, feeUBA: 0n }),
  },
  {
    id: "refuse-wrong-payment-reference",
    intent: "A reference for a different request id can never close this obligation.",
    expect: "refuse",
    reason: "S011_REFERENCE_INVALID",
    mutate: withRedemption({ paymentReference: toHex(redemptionPaymentReference(REQUEST_ID + 1n)) as Hex }),
  },
  {
    id: "refuse-non-redemption-reference",
    intent: "A well-formed reference of the wrong FAssets type is still invalid.",
    expect: "refuse",
    reason: "S011_REFERENCE_INVALID",
    mutate: withRedemption({
      paymentReference: "0x4642505266410001000000000000000000000000000000000000000000001092" as Hex,
    }),
  },
  {
    id: "refuse-tag-out-of-range",
    intent: "XRPL destination tags are 32-bit; a wider value cannot be represented.",
    expect: "refuse",
    reason: "S012_TAG_INVALID",
    mutate: withRedemption({ requiresDestinationTag: true, destinationTag: 4_294_967_296n }),
  },
  {
    id: "refuse-tag-without-mode",
    intent: "A tag value on an untagged obligation is a field the agent must not add.",
    expect: "refuse",
    reason: "S012_TAG_INVALID",
    mutate: withRedemption({ requiresDestinationTag: false, destinationTag: 7n }),
  },
  {
    id: "refuse-fee-above-cap",
    intent: "A fee spike above the configured ceiling is refused, not absorbed.",
    expect: "refuse",
    reason: "S013_FEE_CAP_EXCEEDED",
    mutate: withXrpl({ feeDrops: 5_001n }),
  },
  {
    id: "refuse-sequence-collision",
    intent: "Reusing a sequence an earlier generation holds risks two validated payments.",
    expect: "refuse",
    reason: "S014_SEQUENCE_CONFLICT",
    mutate: (input) =>
      withPrior([
        { requestGeneration: 0, sequenceMode: "SEQUENCE", sequenceOrTicket: 91, outcome: "PROVEN_NOT_SUCCESSFUL" },
      ])(withRedemption({ requestGeneration: 1 })(input)),
  },
  {
    id: "refuse-ticket-collision",
    intent: "The same collision rule applies to Tickets.",
    expect: "refuse",
    reason: "S014_SEQUENCE_CONFLICT",
    mutate: (input) =>
      withPrior([
        { requestGeneration: 0, sequenceMode: "TICKET", sequenceOrTicket: 12_345, outcome: "PROVEN_NOT_SUCCESSFUL" },
      ])(withXrpl({ sequenceMode: "TICKET", sequenceOrTicket: 12_345 })(withRedemption({ requestGeneration: 1 })(input))),
  },
  {
    id: "refuse-revoked-code-hash",
    intent: "A revoked extension version may not produce an accepted result.",
    expect: "refuse",
    reason: "S015_CODE_VERSION_REVOKED",
    mutate: withPolicy({ revokedCodeHashes: [CODE_HASH] }),
  },
  {
    id: "refuse-unapproved-code-hash",
    intent: "Running code the binding never approved is a stale or substituted version.",
    expect: "refuse",
    reason: "S015_CODE_VERSION_REVOKED",
    mutate: withPolicy({ extensionCodeHash: OTHER_CODE_HASH }),
  },
  {
    id: "refuse-wrong-extension-id",
    intent: "A result from another registered extension is out of domain.",
    expect: "refuse",
    reason: "S015_CODE_VERSION_REVOKED",
    mutate: withPolicy({ extensionId: 8n }),
  },
  {
    id: "refuse-policy-paused",
    intent: "Emergency pause stops new authorizations.",
    expect: "refuse",
    reason: "S016_PAUSED",
    mutate: withPolicy({ paused: true }),
  },
  {
    id: "refuse-binding-paused",
    intent: "A paused agent cannot receive a new authorization.",
    expect: "refuse",
    reason: "S016_PAUSED",
    mutate: withBinding({ status: "PAUSED" }),
  },
  {
    id: "refuse-missing-redemption",
    intent: "Unavailable state is transient and must not be recorded as a policy denial.",
    expect: "refuse",
    reason: "S017_STATE_UNAVAILABLE",
    mutate: (input) => ({ ...input, redemption: null }),
  },
  {
    id: "refuse-missing-binding",
    intent: "No binding means nothing to authorize against.",
    expect: "refuse",
    reason: "S017_STATE_UNAVAILABLE",
    mutate: (input) => ({ ...input, binding: null }),
  },
  {
    id: "refuse-replacement-unresolved",
    intent: "The central replacement rule: never replace while the earlier attempt is unresolved.",
    expect: "refuse",
    reason: "S018_REPLACEMENT_NOT_AUTHORIZED",
    mutate: (input) =>
      withPrior([{ requestGeneration: 0, sequenceMode: "SEQUENCE", sequenceOrTicket: 90, outcome: "UNRESOLVED" }])(
        withRedemption({ requestGeneration: 1 })(input),
      ),
  },
  {
    id: "refuse-replacement-without-history",
    intent: "A later generation with no record of the earlier one cannot be justified.",
    expect: "refuse",
    reason: "S018_REPLACEMENT_NOT_AUTHORIZED",
    mutate: withRedemption({ requestGeneration: 1 }),
  },
  {
    id: "refuse-key-not-active",
    intent: "A key mid-rotation must not sign.",
    expect: "refuse",
    reason: "S019_KEY_NOT_ACTIVE",
    mutate: withBinding({ keyState: "ROTATION_PENDING" }),
  },
  {
    id: "refuse-key-revoked",
    intent: "An emergency-revoked key must not sign.",
    expect: "refuse",
    reason: "S019_KEY_NOT_ACTIVE",
    mutate: withBinding({ keyState: "EMERGENCY_REVOKED" }),
  },
  {
    id: "refuse-malformed-source-binding",
    intent: "A malformed bound source account is a configuration failure that fails closed.",
    expect: "refuse",
    reason: "S020_INTERNAL_FAIL_CLOSED",
    mutate: withBinding({ xrplSourceAddress: "not-an-address" }),
  },

  {
    id: "refuse-wrong-flare-chain",
    intent: "An action carrying another Flare chain id is a cross-domain replay (I-011).",
    expect: "refuse",
    reason: "S002_WRONG_DOMAIN",
    mutate: withDomain({ flareChainId: 16n }),
  },
  {
    id: "refuse-wrong-instruction-sender",
    intent: "A well-formed instruction sender that is not the bound one is still foreign (I-011).",
    expect: "refuse",
    reason: "S002_WRONG_DOMAIN",
    mutate: withDomain({ instructionSender: "0x00000000000000000000000000000000000000c2" }),
  },
  {
    id: "refuse-wrong-xrpl-network",
    intent: "An action for another XRPL network would produce a payment on the wrong ledger.",
    expect: "refuse",
    reason: "S002_WRONG_DOMAIN",
    mutate: withDomain({ xrplNetworkId: 0 }),
  },
  {
    id: "refuse-zero-value-uba",
    intent: "A zero-value obligation has nothing lawful to pay, independent of the fee.",
    expect: "refuse",
    reason: "S010_AMOUNT_INVALID",
    mutate: withRedemption({ valueUBA: 0n, feeUBA: 0n }),
  },
  {
    id: "refuse-signer-list-fee-below-multisign-floor",
    intent: "A multi-signed transaction costs base fee times one plus signatures; underpaying never validates (I-007).",
    expect: "refuse",
    reason: "S013_FEE_CAP_EXCEEDED",
    mutate: withBinding({ signingMode: "SIGNER_LIST", signerCount: 3 }),
  },
  {
    id: "valid-signer-list-fee-at-multisign-floor",
    intent: "The same signer list authorizes once the fee meets the multi-sign floor exactly.",
    expect: "authorize",
    mutate: (input) =>
      withXrpl({ feeDrops: 40n })(withBinding({ signingMode: "SIGNER_LIST", signerCount: 3 })(input)),
  },
  {
    id: "refuse-fdc-delay-prior-already-successful",
    intent:
      "Under FDC proof latency FAssets can still report ACTIVE while XRPL already paid; a second signature would be a duplicate (I-009).",
    expect: "refuse",
    reason: "S006_ALREADY_CONSUMED",
    mutate: (input) =>
      withPrior([
        { requestGeneration: 0, sequenceMode: "SEQUENCE", sequenceOrTicket: 90, outcome: "SUCCESSFUL" },
      ])(withRedemption({ requestGeneration: 1 })(input)),
  },
  {
    id: "refuse-ledger-gap-with-expired-window",
    intent:
      "An unresolved earlier attempt blocks replacement even after the window has expired, and the reason must stay the replacement one (I-010, ADR 0002 ordering).",
    expect: "refuse",
    reason: "S018_REPLACEMENT_NOT_AUTHORIZED",
    mutate: (input) =>
      withXrpl({ currentValidatedLedger: 19_800_600, currentLedgerCloseTime: 1_800_001_000n })(
        withPrior([
          { requestGeneration: 0, sequenceMode: "SEQUENCE", sequenceOrTicket: 90, outcome: "UNRESOLVED" },
        ])(withRedemption({ requestGeneration: 1 })(input)),
      ),
  },

  {
    id: "boundary-fee-equals-cap",
    intent: "A fee exactly at the cap is lawful; the check is a ceiling, not a strict bound.",
    expect: "authorize",
    mutate: withXrpl({ feeDrops: 5_000n }),
  },
  {
    id: "boundary-fee-one-above-cap",
    intent: "One drop past the cap refuses, pinning the inequality direction.",
    expect: "refuse",
    reason: "S013_FEE_CAP_EXCEEDED",
    mutate: withXrpl({ feeDrops: 5_001n }),
  },
  {
    id: "boundary-ledger-margin-exact",
    intent:
      "LastLedgerSequence exactly at the ledger-margin limit is lawful; the time margin is given ample headroom so this isolates the ledger inequality.",
    expect: "authorize",
    mutate: (input) =>
      withXrpl({ lastLedgerSequence: 19_800_450 })(withRedemption({ lastUnderlyingTimestamp: 1_800_010_000n })(input)),
  },
  {
    id: "boundary-ledger-margin-one-short",
    intent: "One ledger past the margin limit refuses, pinning the inequality direction.",
    expect: "refuse",
    reason: "S008_INSUFFICIENT_SAFETY_MARGIN",
    mutate: (input) =>
      withXrpl({ lastLedgerSequence: 19_800_451 })(withRedemption({ lastUnderlyingTimestamp: 1_800_010_000n })(input)),
  },
  {
    id: "boundary-tag-at-uint32-max",
    intent: "The largest representable XRPL destination tag is lawful.",
    expect: "authorize",
    mutate: withRedemption({ requiresDestinationTag: true, destinationTag: 4_294_967_295n }),
  },
  {
    id: "boundary-validated-ledger-equals-last-underlying-block",
    intent:
      "At equality the obligation is not yet expired, but no lawful LastLedgerSequence remains: it would have to exceed the validated ledger and not exceed the last underlying block at once. The refusal must be the margin one, not the expiry one.",
    expect: "refuse",
    reason: "S008_INSUFFICIENT_SAFETY_MARGIN",
    mutate: (input) =>
      withPolicy({ safetyMarginLedgers: 0, safetyMarginSeconds: 0n })(
        withXrpl({ currentValidatedLedger: 19_800_500, lastLedgerSequence: 19_800_501 })(input),
      ),
  },
  {
    id: "boundary-validated-ledger-one-past-last-underlying-block-and-time",
    intent: "One past both limits is genuinely expired, and the reason changes to the expiry one.",
    expect: "refuse",
    reason: "S007_EXPIRED_WINDOW",
    mutate: withXrpl({ currentValidatedLedger: 19_800_501, currentLedgerCloseTime: 1_800_000_901n }),
  },
  {
    id: "boundary-max-request-id",
    intent: "The largest uint64 request id still derives a valid payment reference.",
    expect: "authorize",
    mutate: (input) =>
      withRedemption({
        requestId: 18_446_744_073_709_551_615n,
        paymentReference: toHex(redemptionPaymentReference(18_446_744_073_709_551_615n)) as Hex,
      })(input),
  },

  {
    id: "refuse-prior-history-gap",
    intent:
      "A history missing generation 1 means the caller lost track of the obligation; a decision built on it would be guesswork.",
    expect: "refuse",
    reason: "S018_REPLACEMENT_NOT_AUTHORIZED",
    mutate: (input) =>
      withPrior([
        { requestGeneration: 0, sequenceMode: "SEQUENCE", sequenceOrTicket: 90, outcome: "PROVEN_NOT_SUCCESSFUL" },
        { requestGeneration: 2, sequenceMode: "SEQUENCE", sequenceOrTicket: 92, outcome: "PROVEN_NOT_SUCCESSFUL" },
      ])(withRedemption({ requestGeneration: 3 })(input)),
  },
  {
    id: "refuse-prior-history-duplicate-generation",
    intent: "A duplicated generation in the history is an inconsistent record, not a resolved one.",
    expect: "refuse",
    reason: "S018_REPLACEMENT_NOT_AUTHORIZED",
    mutate: (input) =>
      withPrior([
        { requestGeneration: 0, sequenceMode: "SEQUENCE", sequenceOrTicket: 90, outcome: "PROVEN_NOT_SUCCESSFUL" },
        { requestGeneration: 0, sequenceMode: "SEQUENCE", sequenceOrTicket: 93, outcome: "PROVEN_NOT_SUCCESSFUL" },
      ])(withRedemption({ requestGeneration: 2 })(input)),
  },
  {
    id: "refuse-prior-history-short",
    intent:
      "A history shorter than the generation number is the omission a lying coordinator would attempt (I-009).",
    expect: "refuse",
    reason: "S018_REPLACEMENT_NOT_AUTHORIZED",
    mutate: withRedemption({ requestGeneration: 2 }),
  },
  {
    id: "refuse-older-unresolved-buried-under-newer-resolved",
    intent:
      "An older unresolved attempt must not be buried under a newer resolved one; every generation is checked, not just the last (I-010).",
    expect: "refuse",
    reason: "S018_REPLACEMENT_NOT_AUTHORIZED",
    mutate: (input) =>
      withPrior([
        { requestGeneration: 0, sequenceMode: "SEQUENCE", sequenceOrTicket: 90, outcome: "UNRESOLVED" },
        { requestGeneration: 1, sequenceMode: "SEQUENCE", sequenceOrTicket: 92, outcome: "PROVEN_NOT_SUCCESSFUL" },
      ])(withRedemption({ requestGeneration: 2 })(input)),
  },
  {
    id: "refuse-negative-request-generation",
    intent: "A negative generation is rejected by policy, not left to fail deep inside the encoder.",
    expect: "refuse",
    reason: "S018_REPLACEMENT_NOT_AUTHORIZED",
    mutate: withRedemption({ requestGeneration: -1 }),
  },
];



export function scenarioInput(id: string): ReferenceInput {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (scenario === undefined) throw new Error(`unknown scenario ${id}`);
  return scenario.mutate(baseInput());
}
