/**
 * FAssets standard payment reference.
 *
 * Derived from the pinned implementation at
 * `upstream/fassets/contracts/assetManager/library/data/PaymentReference.sol`:
 *
 *   redemption(id) = bytes32(id | (0x4642505266410002 << 192))
 *
 * The 0x464250526641 prefix is ASCII "FBPRfA" and 0x0002 is the redemption type. FAssets requires
 * `_payment.paymentReference == PaymentReference.redemption(requestId)` before it will confirm a
 * redemption, so this value is not advisory: a payment carrying anything else can never close the
 * obligation, and Signet must refuse rather than sign one.
 */
import { bytesToHex, hexToBytes } from "./bytes.ts";

const TYPE_SHIFT = 192n;
const REDEMPTION_TYPE = 0x4642505266410002n;
const LOW_BITS_MASK = (1n << TYPE_SHIFT) - 1n;
const TYPE_MASK = ((1n << 64n) - 1n) << TYPE_SHIFT;
const MAX_ID = (1n << 64n) - 1n;

export class PaymentReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentReferenceError";
  }
}

/** The 32-byte payment reference FAssets requires for a redemption with this request id. */
export function redemptionPaymentReference(requestId: bigint): Uint8Array {
  if (requestId <= 0n) throw new PaymentReferenceError("request id must be positive");
  if (requestId > MAX_ID) throw new PaymentReferenceError("request id exceeds uint64");
  const value = requestId | (REDEMPTION_TYPE << TYPE_SHIFT);
  return hexToBytes(value.toString(16).padStart(64, "0"));
}

/**
 * Mirrors PaymentReference.isValid for the redemption type: the type bits must match and the low
 * bits may never be zero.
 */
export function isValidRedemptionReference(reference: Uint8Array): boolean {
  if (reference.length !== 32) return false;
  const value = BigInt(`0x${bytesToHex(reference)}`);
  return (value & TYPE_MASK) === REDEMPTION_TYPE << TYPE_SHIFT && (value & LOW_BITS_MASK) !== 0n;
}

export function decodeRedemptionReferenceId(reference: Uint8Array): bigint {
  if (!isValidRedemptionReference(reference)) {
    throw new PaymentReferenceError("not a valid FAssets redemption payment reference");
  }
  return BigInt(`0x${bytesToHex(reference)}`) & LOW_BITS_MASK;
}
