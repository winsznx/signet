/**
 * XRPL classic address handling.
 *
 * FAssets hands Signet a redemption destination as a free-form string. Treating that string as
 * canonical would let an attacker exploit any difference between how Signet, XRPL and FDC read it.
 * So Signet decodes it to the 20-byte AccountID and binds both forms: the decoded AccountID, which
 * is what the ledger actually indexes, and the keccak of the exact authoritative string, which is
 * what FAssets recorded.
 *
 * Decoding is base58check with XRPL's dictionary and a double-SHA256 checksum. A string that does
 * not round-trip is rejected rather than normalised - Signet never repairs a destination.
 */
import { sha256 } from "@noble/hashes/sha2";

export const XRPL_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

/** Type prefix for a classic AccountID payload. */
const ACCOUNT_ID_PREFIX = 0x00;
const ACCOUNT_ID_LENGTH = 20;

export class XrplAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XrplAddressError";
  }
}

function base58Decode(input: string): Uint8Array {
  if (input.length === 0) throw new XrplAddressError("empty address");
  let value = 0n;
  for (const char of input) {
    const index = XRPL_ALPHABET.indexOf(char);
    if (index < 0) throw new XrplAddressError(`character ${JSON.stringify(char)} is not in the XRPL base58 alphabet`);
    value = value * 58n + BigInt(index);
  }

  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const body = hex === "0" ? new Uint8Array(0) : Uint8Array.from(Buffer.from(hex, "hex"));

  let leadingZeros = 0;
  for (const char of input) {
    if (char !== XRPL_ALPHABET[0]) break;
    leadingZeros += 1;
  }

  const out = new Uint8Array(leadingZeros + body.length);
  out.set(body, leadingZeros);
  return out;
}

function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let out = "";
  while (value > 0n) {
    out = XRPL_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = XRPL_ALPHABET[0] + out;
  }
  return out;
}

function checksum(payload: Uint8Array): Uint8Array {
  return sha256(sha256(payload)).slice(0, 4);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Decodes a classic `r...` address to its 20-byte AccountID.
 * Throws on any malformed, mis-checksummed, wrong-length or wrong-type input.
 */
export function decodeClassicAddress(address: string): Uint8Array {
  const raw = base58Decode(address);
  if (raw.length !== 1 + ACCOUNT_ID_LENGTH + 4) {
    throw new XrplAddressError(`decoded length ${raw.length}, expected ${1 + ACCOUNT_ID_LENGTH + 4}`);
  }
  const body = raw.slice(0, 1 + ACCOUNT_ID_LENGTH);
  const provided = raw.slice(1 + ACCOUNT_ID_LENGTH);
  if (body[0] !== ACCOUNT_ID_PREFIX) {
    throw new XrplAddressError(`type prefix 0x${body[0]?.toString(16)} is not a classic AccountID`);
  }
  if (!bytesEqual(checksum(body), provided)) {
    throw new XrplAddressError("base58check checksum mismatch");
  }
  return body.slice(1);
}

export function encodeClassicAddress(accountId: Uint8Array): string {
  if (accountId.length !== ACCOUNT_ID_LENGTH) {
    throw new XrplAddressError(`AccountID must be ${ACCOUNT_ID_LENGTH} bytes, got ${accountId.length}`);
  }
  const body = new Uint8Array(1 + ACCOUNT_ID_LENGTH);
  body[0] = ACCOUNT_ID_PREFIX;
  body.set(accountId, 1);
  const full = new Uint8Array(body.length + 4);
  full.set(body);
  full.set(checksum(body), body.length);
  return base58Encode(full);
}

/**
 * True only when `address` is a well-formed classic address that re-encodes to itself.
 * The round-trip requirement rejects non-canonical encodings that decode successfully.
 */
export function isCanonicalClassicAddress(address: string): boolean {
  try {
    return encodeClassicAddress(decodeClassicAddress(address)) === address;
  } catch {
    return false;
  }
}
