/** Byte helpers shared by the encoder. Deliberately tiny and dependency-free. */

export type Hex = `0x${string}`;

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`hex string has odd length: ${hex}`);
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error(`not a hex string: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function toHex(bytes: Uint8Array): Hex {
  return `0x${bytesToHex(bytes)}`;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Big-endian unsigned integer of an exact byte width. Overflow is an error, never a truncation. */
export function uintBE(value: bigint, byteLength: number): Uint8Array {
  if (value < 0n) throw new Error(`negative value ${value} cannot be encoded as unsigned`);
  const max = (1n << BigInt(byteLength * 8)) - 1n;
  if (value > max) throw new Error(`value ${value} does not fit in ${byteLength} bytes`);
  const out = new Uint8Array(byteLength);
  let remaining = value;
  for (let i = byteLength - 1; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

/** A 0x-prefixed 20-byte EVM address, lower-cased. Rejects anything else. */
export function addressBytes(address: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not a 20-byte address: ${address}`);
  return hexToBytes(address);
}

export function bytes32(value: string): Uint8Array {
  const bytes = hexToBytes(value);
  if (bytes.length !== 32) throw new Error(`expected 32 bytes, got ${bytes.length}`);
  return bytes;
}
