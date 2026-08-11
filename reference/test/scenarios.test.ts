import { describe, expect, it } from "vitest";
import { decide } from "../src/decide.ts";
import { REASON_CODES } from "../src/reason-codes.ts";
import { SCENARIOS, baseInput, scenarioInput } from "../src/scenarios.ts";

describe("scenario matrix", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: ${scenario.intent}`, () => {
      const decision = decide(scenarioInput(scenario.id));
      expect(decision.kind, `${scenario.id} expected ${scenario.expect}`).toBe(scenario.expect);
      if (decision.kind === "refuse") {
        expect(decision.reason).toBe(scenario.reason);
      }
    });
  }

  it("declares a reason for every refusing scenario and none for authorizing ones", () => {
    for (const scenario of SCENARIOS) {
      if (scenario.expect === "refuse") {
        expect(scenario.reason, `${scenario.id} must declare a reason`).toBeDefined();
        expect(REASON_CODES).toContain(scenario.reason);
      } else {
        expect(scenario.reason).toBeUndefined();
      }
    }
  });

  it("covers every reason code that policy can produce", () => {
    const covered = new Set(SCENARIOS.filter((s) => s.expect === "refuse").map((s) => s.reason));
    for (const code of REASON_CODES) {
      expect(covered.has(code), `no scenario produces ${code}`).toBe(true);
    }
  });

  it("uses distinct scenario ids", () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });
});

describe("authorized transaction template", () => {
  it("never enables partial payment and always bounds the ledger range", () => {
    for (const scenario of SCENARIOS.filter((s) => s.expect === "authorize")) {
      const decision = decide(scenarioInput(scenario.id));
      if (decision.kind !== "authorize") throw new Error("expected authorize");
      expect(decision.txTemplate.Flags).toBe(0);
      expect(decision.txTemplate.LastLedgerSequence).toBeGreaterThan(0);
      expect(decision.txTemplate.TransactionType).toBe("Payment");
    }
  });

  it("carries exactly one 32-byte memo holding the payment reference", () => {
    const decision = decide(baseInput());
    if (decision.kind !== "authorize") throw new Error("expected authorize");
    expect(decision.txTemplate.Memos).toHaveLength(1);
    const memo = decision.txTemplate.Memos[0].Memo.MemoData;
    expect(memo).toMatch(/^[0-9A-F]{64}$/);
    const input = baseInput();
    expect(`0x${memo.toLowerCase()}`).toBe(input.redemption?.paymentReference);
  });

  it("pays exactly value minus fee in drops", () => {
    const input = baseInput();
    const decision = decide(input);
    if (decision.kind !== "authorize") throw new Error("expected authorize");
    const expected = (input.redemption?.valueUBA ?? 0n) - (input.redemption?.feeUBA ?? 0n);
    expect(decision.txTemplate.Amount).toBe(expected.toString(10));
  });

  it("omits NetworkID on XRPL Testnet and includes it above the threshold", () => {
    const testnet = decide(baseInput());
    if (testnet.kind !== "authorize") throw new Error("expected authorize");
    expect(testnet.txTemplate.NetworkID).toBeUndefined();

    // The binding records the network it was created for, so both must move together. Moving only
    // the domain is the cross-domain replay the S002 check exists to reject, asserted below.
    const input = baseInput();
    const sidechain = decide({
      ...input,
      domain: { ...input.domain, xrplNetworkId: 1025 },
      binding: input.binding === null ? null : { ...input.binding, xrplNetworkId: 1025 },
    });
    if (sidechain.kind !== "authorize") throw new Error("expected authorize");
    expect(sidechain.txTemplate.NetworkID).toBe(1025);

    const mismatched = decide({ ...input, domain: { ...input.domain, xrplNetworkId: 1025 } });
    expect(mismatched.kind).toBe("refuse");
    if (mismatched.kind === "refuse") expect(mismatched.reason).toBe("S002_WRONG_DOMAIN");
  });

  it("uses TicketSequence with a zero Sequence when a ticket carries the transaction", () => {
    const decision = decide(scenarioInput("valid-ticket-allocation"));
    if (decision.kind !== "authorize") throw new Error("expected authorize");
    expect(decision.txTemplate.TicketSequence).toBe(12_345);
    expect(decision.txTemplate.Sequence).toBe(0);
  });

  it("includes DestinationTag only in tagged mode", () => {
    const tagged = decide(scenarioInput("valid-destination-tag"));
    const plain = decide(baseInput());
    if (tagged.kind !== "authorize" || plain.kind !== "authorize") throw new Error("expected authorize");
    expect(tagged.txTemplate.DestinationTag).toBe(305_419_896);
    expect(plain.txTemplate.DestinationTag).toBeUndefined();
  });
});

describe("determinism", () => {
  it("produces an identical decision for an identical input", () => {
    for (const scenario of SCENARIOS) {
      const first = decide(scenarioInput(scenario.id));
      const second = decide(scenarioInput(scenario.id));
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    }
  });
});
