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
import { AUTHORIZATION_ENCODING_VERSION, OBLIGATION_ENCODING_VERSION } from "./types.ts";

export const OBLIGATION_DOMAIN_STRING = "SIGNET_FASSETS_OBLIGATION_V1";
export const AUTHORIZATION_DOMAIN_STRING = "SIGNET_FASSETS_REDEMPTION_V1";

export const OBLIGATION_DOMAIN = keccak_256(new TextEncoder().encode(OBLIGATION_DOMAIN_STRING));
export const AUTHORIZATION_DOMAIN = keccak_256(new TextEncoder().encode(AUTHORIZATION_DOMAIN_STRING));

/**
 * Exact byte lengths, asserted by the encoder and by tests.
 *
 * The authorization preimage grew by 37 bytes in V2: a 4-byte observed ledger, a 1-byte source
 * count, and a 32-byte root over the payments that observation found. Binding them is what makes
 * the check auditable rather than merely performed: the commitment now states which ledger the
 * decision saw, how many independent sources agreed on it, and what they found.
 */
export const AUTHORIZATION_PREIMAGE_LENGTH = 468;
export const OBLIGATION_PREIMAGE_LENGTH = 141;

export const OBSERVATION_DOMAIN_STRING = "SIGNET_UNDERLYING_OBSERVATION_V1";
export const OBSERVATION_DOMAIN = keccak_256(new TextEncoder().encode(OBSERVATION_DOMAIN_STRING));

export interface ObservedPaymentForRoot {
  readonly transactionHash: string;
  readonly amountDrops: bigint;
}

/**
 * Root over what the observation found.
 *
 * The match list is the only variable-length part of the whole scheme, so it is hashed to a fixed
 * 32 bytes rather than inlined; everything else stays fixed-width with no length prefixes. Matches
 * are sorted by transaction hash so that two observers who saw the same payments in a different
 * order produce the same root, and the count is bound explicitly so a truncated list cannot pass as
 * a shorter one.
 *
 * `available` and `agreed` are inside the root because a decision that was allowed to proceed on an
 * unavailable or contradictory observation would otherwise be indistinguishable, after the fact,
 * from one that had a clean look at the ledger.
 */
export function observationRoot(fields: {
  available: boolean;
  agreed: boolean;
  observedAtLedger: number;
  observedAtTime: bigint;
  sourceCount: number;
  payments: readonly ObservedPaymentForRoot[];
}): Uint8Array {
  // A total order, not merely a sort key. Ordering by hash alone leaves ties, and a tie is then
  // resolved by whatever each language's sort happens to do: Array.prototype.sort is spec-stable,
  // Go's sort.Slice explicitly is not, and two entries sharing a hash produced different roots in
  // the two implementations. Comparing the amount as well makes the remaining ties genuinely
  // indistinguishable, so the root does not depend on the order the observer reported.
  const sorted = [...fields.payments].sort((a, b) => {
    const left = a.transactionHash.toLowerCase();
    const right = b.transactionHash.toLowerCase();
    if (left !== right) return left < right ? -1 : 1;
    if (a.amountDrops !== b.amountDrops) return a.amountDrops < b.amountDrops ? -1 : 1;
    return 0;
  });
  return keccak_256(
    concat(
      OBSERVATION_DOMAIN,
      uintBE(fields.available ? 1n : 0n, 1),
      uintBE(fields.agreed ? 1n : 0n, 1),
      uintBE(BigInt(fields.observedAtLedger), 4),
      uintBE(fields.observedAtTime, 8),
      uintBE(BigInt(fields.sourceCount), 1),
      uintBE(BigInt(sorted.length), 4),
      ...sorted.flatMap((p) => [bytes32(p.transactionHash), uintBE(p.amountDrops, 8)]),
    ),
  );
}

/**
 * Note the absence of a `schemaVersion` field.
 *
 * Both version bytes are constants of the encoding rather than inputs: the obligation preimage is
 * frozen at 1 to stay equal to what the deployed contract computes, and the authorization preimage
 * is 2. A caller-supplied version would be a field that looks like it changes the commitment and
 * does not, which is worse than no field at all. The input schema version gates acceptance in
 * `decide`; it is not part of either preimage.
 */
export interface ObligationCommitmentFields {
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
  /** The validated ledger the underlying observation covers up to. */
  readonly observedAtLedger: number;
  /** How many independently operated endpoints agreed on that observation. */
  readonly observedSourceCount: number;
  /** Root over the payments the observation found. */
  readonly observationRoot: Uint8Array;
}

function requireLength(bytes: Uint8Array, length: number, label: string): Uint8Array {
  if (bytes.length !== length) throw new Error(`${label} must be ${length} bytes, got ${bytes.length}`);
  return bytes;
}

/**
 * The obligation preimage.
 *
 * Its version byte is a constant 1 rather than the input's schema version, and that is deliberate.
 * The obligation encoding identifies which obligation a decision concerns and has not changed
 * across V2: the same six fields at the same widths. It is also what `SignetInstructionSender`
 * computes on Coston2, and that deployed bytecode writes a literal 1. Writing the input's version
 * here would change every obligation hash and silently break agreement with a contract nobody can
 * redeploy under the same address.
 */
export function encodeObligation(fields: ObligationCommitmentFields): Uint8Array {
  const encoded = concat(
    OBLIGATION_DOMAIN,
    uintBE(BigInt(OBLIGATION_ENCODING_VERSION), 1),
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
    uintBE(BigInt(AUTHORIZATION_ENCODING_VERSION), 1),
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
    uintBE(BigInt(fields.observedAtLedger), 4),
    uintBE(BigInt(fields.observedSourceCount), 1),
    requireLength(fields.observationRoot, 32, "observationRoot"),
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
