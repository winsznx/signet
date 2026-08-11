/**
 * The property the underlying observation has to hold, over arbitrary inputs.
 *
 * A worked example proves a case. What matters here is the invariant: across every shape of
 * observation fast-check can build, an authorization is reachable only from an observation that was
 * available, agreed, sufficiently sourced, fresh, and free of a matching validated payment. If any
 * generated input authorizes while failing one of those, the check has a hole.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "../../src/decide.ts";
import { scenarioInput } from "../../src/scenarios.ts";
import type { ReferenceInput } from "../../src/types.ts";

const base = () => scenarioInput("valid-standard-memo");

const hex32 = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((b) => `0x${Buffer.from(b).toString("hex")}` as const);

const observationArb = (input: ReferenceInput) =>
  fc.record({
    available: fc.boolean(),
    agreed: fc.boolean(),
    sourceCount: fc.integer({ min: 0, max: 8 }),
    observedAtLedger: fc.integer({
      min: input.xrpl!.currentValidatedLedger - 40,
      max: input.xrpl!.currentValidatedLedger + 2,
    }),
    observedAtTime: fc.bigInt({ min: 0n, max: 2_000_000_000n }),
    payments: fc.array(
      fc.record({
        transactionHash: hex32,
        destinationAddress: fc.constantFrom(input.redemption!.paymentAddress, "r9oQTGAD1Wnuy5t8sPHA9LWTSdsho4AQ72"),
        amountDrops: fc.bigInt({ min: 0n, max: 100_000_000n }),
        paymentReference: fc.constantFrom(input.redemption!.paymentReference, `0x${"11".repeat(32)}` as const),
        validated: fc.boolean(),
      }),
      { maxLength: 4 },
    ),
  });

describe("the underlying observation gate", () => {
  it("authorizes only from an observation that was available, agreed, sourced, fresh and clean", () => {
    const input = base();
    fc.assert(
      fc.property(observationArb(input), (underlying) => {
        const decision = decide({ ...input, underlying });
        if (decision.kind !== "authorize") return true;

        const policy = input.policy;
        const xrpl = input.xrpl!;
        expect(underlying.available).toBe(true);
        expect(underlying.agreed).toBe(true);
        expect(underlying.sourceCount).toBeGreaterThanOrEqual(policy.minimumUnderlyingSources);
        expect(underlying.observedAtLedger).toBeGreaterThan(0);
        expect(underlying.observedAtLedger).toBeLessThanOrEqual(xrpl.currentValidatedLedger);
        expect(xrpl.currentValidatedLedger - underlying.observedAtLedger).toBeLessThanOrEqual(
          policy.maxObservationAgeLedgers,
        );
        const matching = underlying.payments.filter(
          (p) =>
            p.validated &&
            p.destinationAddress === input.redemption!.paymentAddress &&
            p.paymentReference.toLowerCase() === input.redemption!.paymentReference.toLowerCase(),
        );
        expect(matching).toHaveLength(0);
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("never authorizes when a matching validated payment is present, whatever else is true", () => {
    const input = base();
    fc.assert(
      fc.property(
        fc.record({
          sourceCount: fc.integer({ min: 0, max: 8 }),
          observedAtLedger: fc.integer({
            min: input.xrpl!.currentValidatedLedger - 20,
            max: input.xrpl!.currentValidatedLedger,
          }),
          hash: hex32,
          amountDrops: fc.bigInt({ min: 0n, max: 100_000_000n }),
        }),
        ({ sourceCount, observedAtLedger, hash, amountDrops }) => {
          const decision = decide({
            ...input,
            underlying: {
              available: true,
              agreed: true,
              sourceCount,
              observedAtLedger,
              observedAtTime: 1_800_000_020n,
              payments: [
                {
                  transactionHash: hash,
                  destinationAddress: input.redemption!.paymentAddress,
                  amountDrops,
                  paymentReference: input.redemption!.paymentReference,
                  validated: true,
                },
              ],
            },
          });
          expect(decision.kind).toBe("refuse");
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it("binds the observation: two clean observations at different ledgers cannot share a commitment", () => {
    const input = base();
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9 }),
        (delta) => {
          const at = (ledger: number) =>
            decide({
              ...input,
              underlying: { ...input.underlying!, observedAtLedger: ledger, payments: [] },
            });
          const a = at(input.xrpl!.currentValidatedLedger);
          const b = at(input.xrpl!.currentValidatedLedger - delta);
          if (a.kind !== "authorize" || b.kind !== "authorize") return true;
          expect(a.authorizationCommitment).not.toBe(b.authorizationCommitment);
          expect(a.obligationHash).toBe(b.obligationHash);
          return true;
        },
      ),
      { numRuns: 50 },
    );
  });
});
