import type { Hex } from "./bytes.ts";
import type { ErrorClass, ReasonCode } from "./reason-codes.ts";

/** Schema version of the reference input and of the canonical encoding. Bumping this is a fork. */
export const SIGNET_SCHEMA_VERSION = 1;

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
export interface ReferenceInput {
  readonly domain: SignetDomain;
  readonly binding: AgentBindingSnapshot | null;
  readonly redemption: RedemptionSnapshot | null;
  readonly xrpl: XrplAllocationSnapshot | null;
  readonly policy: PolicySnapshot;
  readonly prior: readonly PriorGenerationSnapshot[];
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
