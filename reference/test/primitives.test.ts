import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_XRP_DROPS, obligationAmountDrops, paymentValueUBA, ubaToDrops } from "../src/amount.ts";
import { bytesToHex, hexToBytes, uintBE } from "../src/bytes.ts";
import {
  decodeRedemptionReferenceId,
  isValidRedemptionReference,
  redemptionPaymentReference,
} from "../src/payment-reference.ts";
import {
  decodeClassicAddress,
  encodeClassicAddress,
  isCanonicalClassicAddress,
  XrplAddressError,
} from "../src/xrpl-address.ts";

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../test-vectors/xrpl-addresses.json", import.meta.url)), "utf8"),
) as {
  validClassicAddresses: string[];
  invalidAddresses: { value: string; why: string }[];
};

describe("xrpl classic addresses", () => {
  it("decodes real testnet addresses this repository did not construct", () => {
    for (const address of vectors.validClassicAddresses) {
      const accountId = decodeClassicAddress(address);
      expect(accountId).toHaveLength(20);
      expect(encodeClassicAddress(accountId)).toBe(address);
    }
  });

  it("rejects every malformed address without repairing it", () => {
    for (const { value, why } of vectors.invalidAddresses) {
      expect(isCanonicalClassicAddress(value), `${JSON.stringify(value)} should be rejected: ${why}`).toBe(false);
    }
  });

  it("round-trips every 20-byte AccountID", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 20, maxLength: 20 }), (bytes) => {
        const address = encodeClassicAddress(bytes);
        expect(bytesToHex(decodeClassicAddress(address))).toBe(bytesToHex(bytes));
        expect(isCanonicalClassicAddress(address)).toBe(true);
        return true;
      }),
      { numRuns: 1_000 },
    );
  });

  it("rejects any single-character corruption of a valid address", () => {
    const alphabet = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
    const address = encodeClassicAddress(new Uint8Array(20).fill(0x42));
    let rejected = 0;
    let tried = 0;
    for (let i = 0; i < address.length; i += 1) {
      for (const char of alphabet) {
        if (char === address[i]) continue;
        tried += 1;
        const corrupted = `${address.slice(0, i)}${char}${address.slice(i + 1)}`;
        if (!isCanonicalClassicAddress(corrupted)) rejected += 1;
      }
    }
    // base58check with a 4-byte checksum leaves a ~2^-32 chance per corruption; over a few
    // thousand mutations, anything short of total rejection means the checksum is not being read.
    expect(rejected).toBe(tried);
  });

  it("rejects a non-AccountID type prefix", () => {
    expect(() => decodeClassicAddress("sEdTM1uX8pu2do5XvTnutH6HsouMaM2")).toThrow(XrplAddressError);
  });

  it("refuses to encode an AccountID of the wrong length", () => {
    expect(() => encodeClassicAddress(new Uint8Array(19))).toThrow(XrplAddressError);
    expect(() => encodeClassicAddress(new Uint8Array(21))).toThrow(XrplAddressError);
  });
});

describe("fassets payment reference", () => {
  it("matches the pinned PaymentReference.redemption derivation", () => {
    // redemption(id) = bytes32(id | 0x4642505266410002 << 192)
    expect(bytesToHex(redemptionPaymentReference(1n))).toBe(
      "4642505266410002000000000000000000000000000000000000000000000001",
    );
    expect(bytesToHex(redemptionPaymentReference(4242n))).toBe(
      "4642505266410002000000000000000000000000000000000000000000001092",
    );
  });

  it("round-trips the request id", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 2n ** 64n - 1n }), (id) => {
        const reference = redemptionPaymentReference(id);
        expect(isValidRedemptionReference(reference)).toBe(true);
        expect(decodeRedemptionReferenceId(reference)).toBe(id);
        return true;
      }),
      { numRuns: 1_000 },
    );
  });

  it("rejects a zero id and an id above uint64", () => {
    expect(() => redemptionPaymentReference(0n)).toThrow();
    expect(() => redemptionPaymentReference(2n ** 64n)).toThrow();
  });

  it("rejects the minting reference type, which is well formed but wrong", () => {
    const minting = hexToBytes("4642505266410001000000000000000000000000000000000000000000001092");
    expect(isValidRedemptionReference(minting)).toBe(false);
  });

  it("rejects a redemption-typed reference with zero low bits", () => {
    const zeroLow = hexToBytes("4642505266410002000000000000000000000000000000000000000000000000");
    expect(isValidRedemptionReference(zeroLow)).toBe(false);
  });
});

describe("uba to drops", () => {
  it("is one to one at six minting decimals, which is FXRP", () => {
    const result = ubaToDrops(9_950_000n, 6);
    expect(result.ok && result.drops).toBe(9_950_000n);
  });

  it("scales exactly when decimals differ and refuses when they cannot", () => {
    const exact = ubaToDrops(1_000n, 9);
    expect(exact.ok && exact.drops).toBe(1n);
    expect(ubaToDrops(1_001n, 9).ok).toBe(false);

    const upscaled = ubaToDrops(5n, 3);
    expect(upscaled.ok && upscaled.drops).toBe(5_000n);
  });

  it("never rounds: any inexact conversion is a refusal", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.integer({ min: 7, max: 18 }), (uba, decimals) => {
        const divisor = 10n ** BigInt(decimals - 6);
        const result = ubaToDrops(uba, decimals);
        if (uba % divisor === 0n) {
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.drops * divisor).toBe(uba);
        } else {
          expect(result.ok).toBe(false);
        }
        return true;
      }),
      { numRuns: 2_000 },
    );
  });

  it("refuses an amount above the total XRP supply", () => {
    expect(ubaToDrops(MAX_XRP_DROPS + 1n, 6).ok).toBe(false);
  });

  it("requires a positive payable amount after the fee", () => {
    expect(paymentValueUBA(100n, 100n).ok).toBe(false);
    expect(paymentValueUBA(100n, 101n).ok).toBe(false);
    expect(paymentValueUBA(0n, 0n).ok).toBe(false);
    const ok = paymentValueUBA(100n, 1n);
    expect(ok.ok && ok.drops).toBe(99n);
  });

  it("composes value, fee and scale into the exact drop amount", () => {
    const result = obligationAmountDrops(10_000_000n, 50_000n, 6);
    expect(result.ok && result.drops).toBe(9_950_000n);
  });
});

describe("fixed-width integer encoding", () => {
  it("is big-endian", () => {
    expect(bytesToHex(uintBE(1n, 4))).toBe("00000001");
    expect(bytesToHex(uintBE(0x0102_0304n, 4))).toBe("01020304");
  });

  it("throws rather than truncating or wrapping", () => {
    expect(() => uintBE(256n, 1)).toThrow();
    expect(() => uintBE(-1n, 4)).toThrow();
  });

  it("rejects malformed hex instead of coercing it", () => {
    expect(() => hexToBytes("0x1")).toThrow();
    expect(() => hexToBytes("0xzz")).toThrow();
  });
});
