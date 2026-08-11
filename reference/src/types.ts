import type { Hex } from "./bytes.ts";
import type { ErrorClass, ReasonCode } from "./reason-codes.ts";

/**
 * Schema version of the reference input. Bumping this is a fork, and this is the fork.
 *
 * V2 exists because V1 could not express what an obligation's FAssets status does not tell you:
 * whether the underlying payment already exists. A V1 input is refused rather than interpreted,
 * because the one thing a V1 input cannot carry is the observation that V2 requires, and accepting
 * it would mean accepting exactly the blindness that caused incident 44928272.
 */
export const SIGNET_SCHEMA_VERSION = 2;

/**
 * The obligation preimage's own version byte, which is NOT the input schema version.
 *
 * The obligation encoding identifies which obligation a decision concerns, and it has not changed:
 * the same six fields in the same widths. It is also computed by `SignetInstructionSender` on
 * Coston2, whose deployed bytecode writes a literal 1. Bumping this byte would change every
 * obligation hash and silently break agreement with a contract that cannot be changed, so it stays
 * at 1 and the authorization encoding carries the version that actually moved.
 */
export const OBLIGATION_ENCODING_VERSION = 1;

/** The authorization preimage's version byte. V2 binds the underlying observation. */
export const AUTHORIZATION_ENCODING_VERSION = 2;

export type Address = `0x${string}`;

/**
 * Redemption status as FAssets reports it. Mirrors
 * `RedemptionRequestInfo.Status` in the pinned periphery. Only ACTIVE can be signed for.
 */
export type RedemptionStatus =
  | "ACTIVE"
  | "DEFAULTED_UNCONFIRMED"
  | "SUCCESSFUL"
  | "DEFAULTED_FAILED"
  | "BLOCKED"
  | "REJECTED";

/** Key lifecycle state per PRD section 12.3. Only ACTIVE may sign. */
export type KeyState =
  | "UNINITIALIZED"
  | "GENERATED"
  | "PUBLIC_KEY_VERIFIED"
  | "ACTIVATION_PENDING"
  | "ACTIVE"
  | "ROTATION_PENDING"
  | "RETIRED"
  | "EMERGENCY_REVOKED"
  | "RECOVERY_REQUIRED";

export type BindingStatus = "ACTIVE" | "PAUSED" | "RETIRED";

/** Whether the XRPL sequence number or a pre-created Ticket carries this transaction. */
export type SequenceMode = "SEQUENCE" | "TICKET";

/** Destination-tag mode. NONE and a tag value of zero are distinct and must never collide. */
export type DestinationTagMode = "NONE" | "REQUIRED";

/**
 * The chain and contract domain the decision is bound to. Any mismatch between this and the
 * instruction is a cross-domain replay attempt (I-011).
 */
export interface SignetDomain {
  readonly schemaVersion: number;
  readonly flareChainId: bigint;
  readonly instructionSender: Address;
  readonly assetManager: Address;
  readonly xrplNetworkId: number;
}

/**
 * FR-002 requires the binding to record the network identifiers it was created for, not only the
 * agent and the code version. Without them there is nothing to compare an incoming domain against,
 * and an action from another chain, sender or XRPL network would pass domain validation on shape
 * alone. These four fields are what make I-011 enforceable.
 */
export interface AgentBindingSnapshot {
  readonly agentVault: Address;
  readonly assetManager: Address;
  readonly flareChainId: bigint;
  readonly instructionSender: Address;
  readonly xrplNetworkId: number;
  readonly xrplSourceAddress: string;
  readonly signingMode: "REGULAR_KEY" | "SIGNER_LIST";
  /** Number of signers in the XRPL signer list. Zero in REGULAR_KEY mode. */
  readonly signerCount: number;
  readonly keyState: KeyState;
  readonly status: BindingStatus;
  readonly extensionId: bigint;
  readonly approvedCodeHash: Hex;
  readonly policyVersion: number;
}

/**
 * The authoritative obligation, exactly as FAssets reports it. Signet never accepts a
 * caller-supplied payment field; every value here is read from the AssetManager.
 */
export interface RedemptionSnapshot {
  readonly requestId: bigint;
  readonly requestGeneration: number;
  readonly status: RedemptionStatus;
  readonly agentVault: Address;
  readonly paymentAddress: string;
  readonly paymentReference: Hex;
  readonly valueUBA: bigint;
  readonly feeUBA: bigint;
  readonly firstUnderlyingBlock: bigint;
  readonly lastUnderlyingBlock: bigint;
  readonly lastUnderlyingTimestamp: bigint;
  readonly requiresDestinationTag: boolean;
  readonly destinationTag: bigint;
  readonly assetMintingDecimals: number;
}

/** The XRPL-side allocation the coordinator proposes. The extension validates, never trusts, it. */
export interface XrplAllocationSnapshot {
  readonly sequenceMode: SequenceMode;
  readonly sequenceOrTicket: number;
  readonly currentValidatedLedger: number;
  readonly currentLedgerCloseTime: bigint;
  readonly lastLedgerSequence: number;
  readonly feeDrops: bigint;
  readonly maxFeeDrops: bigint;
  /** The ledger's current base fee. A multi-signed transaction costs a multiple of it. */
  readonly baseFeeDrops: bigint;
}

export interface PolicySnapshot {
  readonly policyVersion: number;
  readonly extensionId: bigint;
  readonly extensionCodeHash: Hex;
  readonly revokedCodeHashes: readonly Hex[];
  readonly paused: boolean;
  /** Independently operated XRPL endpoints that must agree before an observation counts. */
  readonly minimumUnderlyingSources: number;
  /** How many ledgers old an observation may be before it must be taken again. */
  readonly maxObservationAgeLedgers: number;
  /** Ledgers that must remain between LastLedgerSequence and the obligation's last block. */
  readonly safetyMarginLedgers: number;
  /** Seconds that must remain between the projected close time and lastUnderlyingTimestamp. */
  readonly safetyMarginSeconds: bigint;
  /** Seconds per validated ledger, used to project close time. */
  readonly ledgerCloseIntervalSeconds: bigint;
}

/**
 * What is known about an earlier generation of this same obligation.
 *
 * TRUST SOURCE, normative: this record is owned by the signing boundary. It must be reconstructed
 * from the extension's own durable state and from the Signet registry's on-chain action state, and
 * must never be read from a coordinator-supplied request payload. PRD section 10.2 assigns
 * anti-replay state to the extension and states the coordinator is untrusted for payment authority;
 * a `prior` array the coordinator can author collapses I-009 and I-010 into "the coordinator says
 * so". `decide` enforces what a pure function can - that the record is complete and internally
 * consistent for generations 0..n-1 - but completeness of an empty array cannot be proven from
 * inside, which is exactly why the source is constrained here rather than validated later.
 */
export interface PriorGenerationSnapshot {
  readonly requestGeneration: number;
  readonly sequenceMode: SequenceMode;
  readonly sequenceOrTicket: number;
  /**
   * `UNRESOLVED` is the dangerous one: it means the earlier transaction's fate is not yet known,
   * and a replacement must not be signed (I-010, FR-044).
   */
  readonly outcome: "UNRESOLVED" | "PROVEN_NOT_SUCCESSFUL" | "SUCCESSFUL";
}

/**
 * Every field carries a trust source, recorded in docs/adr/0002-policy-semantics.md section
 * "Trust sources". Two of them are load-bearing and easy to get wrong:
 *
 * - `prior` must come from extension-owned state and on-chain action state, never the coordinator;
 * - `xrpl.currentValidatedLedger` and `currentLedgerCloseTime` must be observed by the signing
 *   boundary from independent XRPL endpoints, never accepted as a coordinator assertion, because
 *   an under-reported ledger height makes an expired obligation look open.
 */
/**
 * One payment seen on the XRP ledger that carries an obligation's payment reference.
 *
 * The signing boundary must have observed these itself. A coordinator-supplied list is worthless:
 * an empty list is exactly what an attacker would send, and the whole point of the check is that
 * the party who wants the signature is not the party who reports whether the money already moved.
 */
export interface ObservedUnderlyingPayment {
  readonly transactionHash: Hex;
  readonly destinationAddress: string;
  readonly amountDrops: bigint;
  readonly paymentReference: Hex;
  /** Only a validated payment counts. A provisional one is not a result. */
  readonly validated: boolean;
}

/**
 * What the signing boundary saw on the XRP ledger, and how sure it is.
 *
 * `available` and `agreed` are separate because "I could not look" and "I looked and my sources
 * contradicted each other" are different failures with different correct responses. Collapsing them
 * would make one of the two responses wrong.
 */
export interface UnderlyingObservationSnapshot {
  /** False when the observation could not be completed at all. */
  readonly available: boolean;
  /** False when independently operated endpoints returned contradictory answers. */
  readonly agreed: boolean;
  /** How many independently operated endpoints answered consistently. */
  readonly sourceCount: number;
  /** The validated ledger index the observation covers up to. */
  readonly observedAtLedger: number;
  /** Close time of that ledger, used for nothing but evidence legibility. */
  readonly observedAtTime: bigint;
  /** Every payment seen carrying this obligation's reference. Usually empty. */
  readonly payments: readonly ObservedUnderlyingPayment[];
}

export interface ReferenceInput {
  readonly domain: SignetDomain;
  readonly binding: AgentBindingSnapshot | null;
  readonly redemption: RedemptionSnapshot | null;
  readonly xrpl: XrplAllocationSnapshot | null;
  readonly policy: PolicySnapshot;
  readonly prior: readonly PriorGenerationSnapshot[];
  /**
   * The XRP ledger observation. Null means the signing boundary did not look, which is refused:
   * a decision that skipped the check must never be indistinguishable from one that passed it.
   */
  readonly underlying: UnderlyingObservationSnapshot | null;
}

/**
 * The XRPL Payment Signet builds. There is no path by which a caller supplies any of these fields:
 * every one is derived from the obligation, the binding or the validated allocation.
 */
export interface CanonicalXrplPayment {
  readonly TransactionType: "Payment";
  readonly Account: string;
  readonly Destination: string;
  readonly Amount: string;
  readonly Fee: string;
  readonly Flags: 0;
  readonly LastLedgerSequence: number;
  readonly Memos: readonly [{ readonly Memo: { readonly MemoData: string } }];
  readonly Sequence?: number;
  readonly TicketSequence?: number;
  readonly DestinationTag?: number;
  readonly NetworkID?: number;
}

export interface AuthorizeDecision {
  readonly kind: "authorize";
  readonly obligationHash: Hex;
  readonly authorizationCommitment: Hex;
  readonly txTemplate: CanonicalXrplPayment;
}

export interface RefuseDecision {
  readonly kind: "refuse";
  readonly obligationHash: Hex;
  readonly reason: ReasonCode;
  readonly errorClass: ErrorClass;
}

export type ReferenceDecision = AuthorizeDecision | RefuseDecision;
