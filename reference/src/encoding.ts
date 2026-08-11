/**
 * Canonical authorization commitment. Frozen by docs/adr/0001-canonical-encoding.md.
 *
 * The commitment binds every field that can change the meaning of the payment. Encoding is a
 * fixed-width big-endian byte string with no length prefixes and no variable-length members, so
 * there is exactly one byte string per input and no way to move a boundary between two fields.
 *
 * Two separate domains exist and must never be confused:
 *
 * - the obligation hash identifies which obligation and generation a decision is about, and is
 *   emitted on refusals too, where most authorization fields do not exist;
 * - the authorization commitment covers the full signed payment and is emitted only on authorize.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { addressBytes, bytes32, concat, hexToBytes, toHex, uintBE } from "./bytes.ts";
import type { Hex } from "./bytes.ts";

export const OBLIGATION_DOMAIN_STRING = "SIGNET_FASSETS_OBLIGATION_V1";
export const AUTHORIZATION_DOMAIN_STRING = "SIGNET_FASSETS_REDEMPTION_V1";

export const OBLIGATION_DOMAIN = keccak_256(new TextEncoder().encode(OBLIGATION_DOMAIN_STRING));
export const AUTHORIZATION_DOMAIN = keccak_256(new TextEncoder().encode(AUTHORIZATION_DOMAIN_STRING));

/** Exact byte length of the authorization preimage. Asserted by the encoder and by tests. */
export const AUTHORIZATION_PREIMAGE_LENGTH = 431;
export const OBLIGATION_PREIMAGE_LENGTH = 141;

export interface ObligationCommitmentFields {
  readonly schemaVersion: number;
  readonly flareChainId: bigint;
  readonly assetManager: string;
  readonly agentVault: string;
  readonly requestId: bigint;
  readonly requestGeneration: number;
}

export interface AuthorizationCommitmentFields extends ObligationCommitmentFields {
  readonly instructionSender: string;
  readonly xrplNetworkId: number;
  readonly xrplSourceAccountId: Uint8Array;
  readonly xrplSourceAddressStringHash: Uint8Array;
  readonly destinationAccountId: Uint8Array;
  readonly destinationAddressStringHash: Uint8Array;
  /** 0 for no tag, 1 for a required tag. Never inferred from the tag value. */
  readonly destinationTagMode: 0 | 1;
  readonly destinationTag: number;
  readonly amountDrops: bigint;
  readonly paymentReference: Uint8Array;
  readonly firstUnderlyingBlock: bigint;
  readonly lastUnderlyingBlock: bigint;
  readonly lastUnderlyingTimestamp: bigint;
  /** 0 for an account sequence, 1 for a Ticket. */
  readonly sequenceMode: 0 | 1;
  readonly sequenceOrTicket: number;
  readonly lastLedgerSequence: number;
  readonly feeDrops: bigint;
  readonly maxFeeDrops: bigint;
  readonly policyVersion: number;
  readonly extensionId: bigint;
  readonly extensionCodeHash: Uint8Array;
}

function requireLength(bytes: Uint8Array, length: number, label: string): Uint8Array {
  if (bytes.length !== length) throw new Error(`${label} must be ${length} bytes, got ${bytes.length}`);
  return bytes;
}

export function encodeObligation(fields: ObligationCommitmentFields): Uint8Array {
  const encoded = concat(
    OBLIGATION_DOMAIN,
    uintBE(BigInt(fields.schemaVersion), 1),
    uintBE(fields.flareChainId, 32),
    addressBytes(fields.assetManager),
    addressBytes(fields.agentVault),
    uintBE(fields.requestId, 32),
    uintBE(BigInt(fields.requestGeneration), 4),
  );
  return requireLength(encoded, OBLIGATION_PREIMAGE_LENGTH, "obligation preimage");
}

export function obligationHash(fields: ObligationCommitmentFields): Hex {
  return toHex(keccak_256(encodeObligation(fields)));
}

export function encodeAuthorization(fields: AuthorizationCommitmentFields): Uint8Array {
  // The tag value is meaningless unless the mode says a tag applies. Forcing it to zero in that
  // case gives "no tag" exactly one encoding, so it can never collide with "tag 0".
  if (fields.destinationTagMode === 0 && fields.destinationTag !== 0) {
    throw new Error("destinationTag must be 0 when destinationTagMode is NONE");
  }

  const encoded = concat(
    AUTHORIZATION_DOMAIN,
    uintBE(BigInt(fields.schemaVersion), 1),
    uintBE(fields.flareChainId, 32),
    addressBytes(fields.instructionSender),
    addressBytes(fields.assetManager),
    addressBytes(fields.agentVault),
    uintBE(fields.requestId, 32),
    uintBE(BigInt(fields.requestGeneration), 4),
    uintBE(BigInt(fields.xrplNetworkId), 4),
    requireLength(fields.xrplSourceAccountId, 20, "xrplSourceAccountId"),
    requireLength(fields.xrplSourceAddressStringHash, 32, "xrplSourceAddressStringHash"),
    requireLength(fields.destinationAccountId, 20, "destinationAccountId"),
    requireLength(fields.destinationAddressStringHash, 32, "destinationAddressStringHash"),
    uintBE(BigInt(fields.destinationTagMode), 1),
    uintBE(BigInt(fields.destinationTag), 4),
    uintBE(fields.amountDrops, 8),
    requireLength(fields.paymentReference, 32, "paymentReference"),
    uintBE(fields.firstUnderlyingBlock, 8),
    uintBE(fields.lastUnderlyingBlock, 8),
    uintBE(fields.lastUnderlyingTimestamp, 8),
    uintBE(BigInt(fields.sequenceMode), 1),
    uintBE(BigInt(fields.sequenceOrTicket), 4),
    uintBE(BigInt(fields.lastLedgerSequence), 4),
    uintBE(fields.feeDrops, 8),
    uintBE(fields.maxFeeDrops, 8),
    uintBE(BigInt(fields.policyVersion), 4),
    uintBE(fields.extensionId, 32),
    requireLength(fields.extensionCodeHash, 32, "extensionCodeHash"),
  );
  return requireLength(encoded, AUTHORIZATION_PREIMAGE_LENGTH, "authorization preimage");
}

export function authorizationCommitment(fields: AuthorizationCommitmentFields): Hex {
  return toHex(keccak_256(encodeAuthorization(fields)));
}

export function keccakOfUtf8(text: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(text));
}

export { hexToBytes, bytes32, toHex };
