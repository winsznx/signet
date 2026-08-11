/**
 * The verifier has to catch a corrupted bundle, which means every field it reads must be one it
 * actually checks rather than one it merely copies into its output.
 *
 * These tests corrupt one field at a time and require a FAIL. They run against stubbed sources
 * rather than the network, because a test that needs the internet is a test that gets skipped, and
 * a skipped verifier test is how a verifier quietly stops verifying.
 *
 * The last two tests are the ones that matter most. One proves a receipt cannot escape a check by
 * omitting the field that triggers it. The other proves the honest receipt passes, because a
 * verifier that fails everything catches corruption for the wrong reason.
 */
import { describe, expect, it } from "vitest";
import { redemptionPaymentReference, toHex } from "@signet/reference";
import { verifyReceipt, type ObligationSource, type Receipt, type XrplTransaction } from "../src/verify.ts";

const REQUEST_ID = 0x2acd438n;

// Derived, not copied. A hardcoded expected memo would pass even if the derivation were wrong in
// both the verifier and the fixture, which is exactly the mistake shared fixtures exist to prevent.
const MEMO = toHex(redemptionPaymentReference(REQUEST_ID)).replace(/^0x/, "").toUpperCase();

const TX: XrplTransaction = {
  Account: "rPvarExLQuuqtkMBfDHp3pNnESZ5HByXta",
  Destination: "rpa8bBa8GS1Zit6y9PcpQbahkqFahpWMyb",
  Amount: "9950000",
  Fee: "10",
  Flags: 0,
  Sequence: 19822144,
  LastLedgerSequence: 19823429,
  Memos: [{ Memo: { MemoData: MEMO } }],
  validated: true,
  ledger_index: 19823392,
  meta: { TransactionResult: "tesSUCCESS" },
};

const HONEST: Receipt = {
  seam: "composed-lifecycle",
  requestId: REQUEST_ID.toString(),
  agentVault: "0xd5defe2c62d48788bb3889534fbfe7aea0602d64",
  authorizationCommitment: "0xcommitment",
  txHash: "28B48DC36ACFDA1C22E97C033941355E4680B8F28964DB78F68AA44B41FBEFF4",
  validatedLedger: 19823392,
};

const obligations: ObligationSource = {
  async readCanonicalRedemption() {
    return {
      agentVault: "0xd5defe2c62d48788bb3889534fbfe7aea0602d64",
      paymentAddress: "rpa8bBa8GS1Zit6y9PcpQbahkqFahpWMyb",
      valueUBA: 10_000_000n,
      feeUBA: 50_000n,
      status: "ACTIVE",
    };
  },
};

/** Answers every endpoint with the same transaction, so endpoint agreement is not what is under test. */
function ledgerHolding(tx: XrplTransaction): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ result: tx }), { status: 200 })) as unknown as typeof fetch;
}

const ENDPOINTS = ["https://a.invalid", "https://b.invalid"];

async function verify(receipt: Receipt, tx: XrplTransaction = TX, commitment: string | null = "0xcommitment") {
  return verifyReceipt("test", receipt, {
    xrplEndpoints: ENDPOINTS,
    obligations,
    fetchImpl: ledgerHolding(tx),
    recomputeCommitment: () => commitment,
  });
}

describe("a corrupted bundle", () => {
  it("passes when nothing is corrupted", async () => {
    const result = await verify(HONEST);
    expect(result.verdict).toBe("PASS");
  });

  it("is caught when the recorded commitment does not match the payment", async () => {
    const result = await verify({ ...HONEST, authorizationCommitment: "0xdeadbeef" });
    expect(result.verdict).toBe("FAIL");
    expect(result.findings.find((f) => f.outcome === "FAIL")?.name).toContain("commitment");
  });

  it("is caught when the payment went somewhere fassets did not name", async () => {
    const result = await verify(HONEST, { ...TX, Destination: "r9oQTGAD1Wnuy5t8sPHA9LWTSdsho4AQ72" });
    expect(result.verdict).toBe("FAIL");
  });

  it("is caught when the amount is not value minus fee", async () => {
    const result = await verify(HONEST, { ...TX, Amount: "9950001" });
    expect(result.verdict).toBe("FAIL");
  });

  it("is caught when the memo is not the reference this request id derives", async () => {
    const result = await verify(HONEST, {
      ...TX,
      // The reference for a different request id: right shape, wrong obligation.
      Memos: [{ Memo: { MemoData: toHex(redemptionPaymentReference(REQUEST_ID + 1n)).replace(/^0x/, "").toUpperCase() } }],
    });
    expect(result.verdict).toBe("FAIL");
  });

  it("is caught when the receipt names a ledger the payment is not in", async () => {
    const result = await verify({ ...HONEST, validatedLedger: 19823391 });
    expect(result.verdict).toBe("FAIL");
  });

  it("is caught when the transaction was never validated", async () => {
    const result = await verify(HONEST, { ...TX, validated: false });
    expect(result.verdict).toBe("FAIL");
  });

  it("is caught when the ledger did not accept the transaction", async () => {
    const result = await verify(HONEST, { ...TX, meta: { TransactionResult: "tecPATH_DRY" } });
    expect(result.verdict).toBe("FAIL");
  });

  it("is caught when partial payment was enabled", async () => {
    const result = await verify(HONEST, { ...TX, Flags: 0x00020000 });
    expect(result.verdict).toBe("FAIL");
  });

  it("is caught when the receipt names an agent fassets did not assign", async () => {
    const result = await verify({ ...HONEST, agentVault: "0x000000000000000000000000000000000000dead" });
    expect(result.verdict).toBe("FAIL");
  });

  it("is caught when independent endpoints disagree about the payment", async () => {
    let call = 0;
    const inconsistent = (async () => {
      call += 1;
      const tx = call === 1 ? TX : { ...TX, Amount: "1" };
      return new Response(JSON.stringify({ result: tx }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await verifyReceipt("test", HONEST, {
      xrplEndpoints: ENDPOINTS,
      obligations,
      fetchImpl: inconsistent,
      recomputeCommitment: () => "0xcommitment",
    });
    expect(result.verdict).toBe("FAIL");
  });
});

describe("a receipt cannot escape a check by staying silent", () => {
  it("claims settlement when it does not say otherwise, so a mismatch condemns it", async () => {
    const result = await verify(HONEST, { ...TX, Destination: "r9oQTGAD1Wnuy5t8sPHA9LWTSdsho4AQ72" });
    expect(result.verdict).toBe("FAIL");
  });

  it("only relaxes to NOT_CLAIMED on an explicit settles:false", async () => {
    const result = await verify({ ...HONEST, settles: false }, { ...TX, Destination: "r9oQTGAD1Wnuy5t8sPHA9LWTSdsho4AQ72" });
    expect(result.verdict).not.toBe("FAIL");
    expect(result.findings.some((f) => f.outcome === "NOT_CLAIMED")).toBe(true);
  });

  it("is unverifiable, never passing, when the commitment cannot be recomputed", async () => {
    const result = await verify(HONEST, TX, null);
    expect(result.verdict).toBe("UNVERIFIABLE");
  });

  it("is unverifiable, never passing, when the obligation is not publicly readable", async () => {
    const result = await verifyReceipt("test", HONEST, {
      xrplEndpoints: ENDPOINTS,
      obligations: { async readCanonicalRedemption() { return null; } },
      fetchImpl: ledgerHolding(TX),
      recomputeCommitment: () => "0xcommitment",
    });
    expect(result.verdict).toBe("UNVERIFIABLE");
  });
});
