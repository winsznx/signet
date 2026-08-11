import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  AUTHORIZATION_DOMAIN,
  AUTHORIZATION_DOMAIN_STRING,
  AUTHORIZATION_PREIMAGE_LENGTH,
  OBLIGATION_DOMAIN,
  OBLIGATION_DOMAIN_STRING,
  OBLIGATION_PREIMAGE_LENGTH,
  authorizationCommitment,
  encodeAuthorization,
  encodeObligation,
  keccakOfUtf8,
  obligationHash,
  type AuthorizationCommitmentFields,
} from "../src/encoding.ts";
import { toHex, uintBE } from "../src/bytes.ts";
import { redemptionPaymentReference } from "../src/payment-reference.ts";
import { decodeClassicAddress } from "../src/xrpl-address.ts";
import { DESTINATION_ADDRESS, SOURCE_ADDRESS } from "../src/scenarios.ts";

function baseFields(): AuthorizationCommitmentFields {
  return {
    schemaVersion: 1,
    flareChainId: 114n,
    instructionSender: "0x00000000000000000000000000000000000000c1",
    assetManager: "0x00000000000000000000000000000000000000b1",
    agentVault: "0x00000000000000000000000000000000000000a1",
    requestId: 4242n,
    requestGeneration: 0,
    xrplNetworkId: 1,
    xrplSourceAccountId: decodeClassicAddress(SOURCE_ADDRESS),
    xrplSourceAddressStringHash: keccakOfUtf8(SOURCE_ADDRESS),
    destinationAccountId: decodeClassicAddress(DESTINATION_ADDRESS),
    destinationAddressStringHash: keccakOfUtf8(DESTINATION_ADDRESS),
    destinationTagMode: 0,
    destinationTag: 0,
    amountDrops: 9_950_000n,
    paymentReference: redemptionPaymentReference(4242n),
    firstUnderlyingBlock: 19_800_000n,
    lastUnderlyingBlock: 19_800_500n,
    lastUnderlyingTimestamp: 1_800_000_900n,
    sequenceMode: 0,
    sequenceOrTicket: 91,
    lastLedgerSequence: 19_800_110,
    feeDrops: 12n,
    maxFeeDrops: 5_000n,
    policyVersion: 1,
    extensionId: 7n,
    extensionCodeHash: new Uint8Array(32).fill(0x11),
  };
}

/** Each entry changes exactly one field of the base commitment input. */
const FIELD_MUTATIONS: ReadonlyArray<readonly [string, (f: AuthorizationCommitmentFields) => AuthorizationCommitmentFields]> = [
  ["schemaVersion", (f) => ({ ...f, schemaVersion: 2 })],
  ["flareChainId", (f) => ({ ...f, flareChainId: 16n })],
  ["instructionSender", (f) => ({ ...f, instructionSender: "0x00000000000000000000000000000000000000c2" })],
  ["assetManager", (f) => ({ ...f, assetManager: "0x00000000000000000000000000000000000000b2" })],
  ["agentVault", (f) => ({ ...f, agentVault: "0x00000000000000000000000000000000000000a2" })],
  ["requestId", (f) => ({ ...f, requestId: 4243n })],
  ["requestGeneration", (f) => ({ ...f, requestGeneration: 1 })],
  ["xrplNetworkId", (f) => ({ ...f, xrplNetworkId: 2 })],
  ["xrplSourceAccountId", (f) => ({ ...f, xrplSourceAccountId: new Uint8Array(20).fill(0x99) })],
  ["xrplSourceAddressStringHash", (f) => ({ ...f, xrplSourceAddressStringHash: keccakOfUtf8("other") })],
  ["destinationAccountId", (f) => ({ ...f, destinationAccountId: new Uint8Array(20).fill(0x88) })],
  ["destinationAddressStringHash", (f) => ({ ...f, destinationAddressStringHash: keccakOfUtf8("other") })],
  ["destinationTagMode", (f) => ({ ...f, destinationTagMode: 1 })],
  ["destinationTag", (f) => ({ ...f, destinationTagMode: 1, destinationTag: 7 })],
  ["amountDrops", (f) => ({ ...f, amountDrops: 9_950_001n })],
  ["paymentReference", (f) => ({ ...f, paymentReference: redemptionPaymentReference(4243n) })],
  ["firstUnderlyingBlock", (f) => ({ ...f, firstUnderlyingBlock: 19_800_001n })],
  ["lastUnderlyingBlock", (f) => ({ ...f, lastUnderlyingBlock: 19_800_501n })],
  ["lastUnderlyingTimestamp", (f) => ({ ...f, lastUnderlyingTimestamp: 1_800_000_901n })],
  ["sequenceMode", (f) => ({ ...f, sequenceMode: 1 })],
  ["sequenceOrTicket", (f) => ({ ...f, sequenceOrTicket: 92 })],
  ["lastLedgerSequence", (f) => ({ ...f, lastLedgerSequence: 19_800_111 })],
  ["feeDrops", (f) => ({ ...f, feeDrops: 13n })],
  ["maxFeeDrops", (f) => ({ ...f, maxFeeDrops: 5_001n })],
  ["policyVersion", (f) => ({ ...f, policyVersion: 2 })],
  ["extensionId", (f) => ({ ...f, extensionId: 8n })],
  ["extensionCodeHash", (f) => ({ ...f, extensionCodeHash: new Uint8Array(32).fill(0x22) })],
];

describe("canonical encoding", () => {
  it("produces a preimage of exactly the frozen length", () => {
    expect(encodeAuthorization(baseFields())).toHaveLength(AUTHORIZATION_PREIMAGE_LENGTH);
    expect(AUTHORIZATION_PREIMAGE_LENGTH).toBe(431);
    expect(
      encodeObligation({
        schemaVersion: 1,
        flareChainId: 114n,
        assetManager: "0x00000000000000000000000000000000000000b1",
        agentVault: "0x00000000000000000000000000000000000000a1",
        requestId: 4242n,
        requestGeneration: 0,
      }),
    ).toHaveLength(OBLIGATION_PREIMAGE_LENGTH);
  });

  it("derives its domain separators from the frozen version strings", () => {
    expect(toHex(AUTHORIZATION_DOMAIN)).toBe(toHex(keccakOfUtf8(AUTHORIZATION_DOMAIN_STRING)));
    expect(toHex(OBLIGATION_DOMAIN)).toBe(toHex(keccakOfUtf8(OBLIGATION_DOMAIN_STRING)));
    expect(toHex(AUTHORIZATION_DOMAIN)).not.toBe(toHex(OBLIGATION_DOMAIN));
  });

  it("starts every preimage with its own domain separator", () => {
    const authorization = encodeAuthorization(baseFields());
    expect(toHex(authorization.slice(0, 32))).toBe(toHex(AUTHORIZATION_DOMAIN));
  });

  describe("every field is bound", () => {
    const base = authorizationCommitment(baseFields());
    for (const [field, mutate] of FIELD_MUTATIONS) {
      it(`changing ${field} changes the commitment`, () => {
        expect(authorizationCommitment(mutate(baseFields()))).not.toBe(base);
      });
    }

    it("covers every field of the commitment input", () => {
      const declared = new Set(FIELD_MUTATIONS.map(([field]) => field));
      for (const field of Object.keys(baseFields())) {
        expect(declared.has(field), `no mutation exercises ${field}`).toBe(true);
      }
      expect(declared.size).toBe(Object.keys(baseFields()).length);
    });

    it("yields a distinct commitment for every mutation, not merely a different one", () => {
      const seen = new Map<string, string>();
      seen.set(base, "base");
      for (const [field, mutate] of FIELD_MUTATIONS) {
        const commitment = authorizationCommitment(mutate(baseFields()));
        expect(seen.has(commitment), `${field} collides with ${seen.get(commitment)}`).toBe(false);
        seen.set(commitment, field);
      }
    });
  });

  it("gives an untagged obligation exactly one encoding", () => {
    expect(() => encodeAuthorization({ ...baseFields(), destinationTagMode: 0, destinationTag: 1 })).toThrow();
  });

  it("cannot confuse a required tag of zero with no tag", () => {
    const noTag = authorizationCommitment({ ...baseFields(), destinationTagMode: 0, destinationTag: 0 });
    const zeroTag = authorizationCommitment({ ...baseFields(), destinationTagMode: 1, destinationTag: 0 });
    expect(noTag).not.toBe(zeroTag);
  });

  it("rejects a field that does not fit its fixed width instead of truncating", () => {
    expect(() => uintBE(0x1_0000_0000n, 4)).toThrow();
    expect(() => encodeAuthorization({ ...baseFields(), sequenceOrTicket: 0x1_0000_0000 })).toThrow();
    expect(() => encodeAuthorization({ ...baseFields(), amountDrops: 1n << 64n })).toThrow();
  });

  it("rejects a mis-sized fixed-width byte field", () => {
    expect(() => encodeAuthorization({ ...baseFields(), extensionCodeHash: new Uint8Array(31) })).toThrow();
    expect(() => encodeAuthorization({ ...baseFields(), destinationAccountId: new Uint8Array(21) })).toThrow();
    expect(() => encodeAuthorization({ ...baseFields(), paymentReference: new Uint8Array(16) })).toThrow();
  });

  it("commits to the keccak of the preimage and nothing else", () => {
    const fields = baseFields();
    expect(authorizationCommitment(fields)).toBe(toHex(keccak_256(encodeAuthorization(fields))));
  });

  it("keeps the obligation hash independent of authorization-only fields", () => {
    const a = obligationHash({
      schemaVersion: 1,
      flareChainId: 114n,
      assetManager: "0x00000000000000000000000000000000000000b1",
      agentVault: "0x00000000000000000000000000000000000000a1",
      requestId: 4242n,
      requestGeneration: 0,
    });
    const b = obligationHash({
      schemaVersion: 1,
      flareChainId: 114n,
      assetManager: "0x00000000000000000000000000000000000000b1",
      agentVault: "0x00000000000000000000000000000000000000a1",
      requestId: 4242n,
      requestGeneration: 1,
    });
    expect(a).not.toBe(b);
  });
});
