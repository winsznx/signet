/**
 * The properties machine rotation has to hold, over arbitrary states.
 *
 * FCC gives a restarted machine a new identity and there is no restore path, so rotation is not an
 * exceptional case: it is the normal consequence of a restart. These tests fix the behaviour of the
 * dangerous middles, where the old machine and the new one are both plausible signers.
 *
 * Every named scenario from the run instruction has a test here, and the fuzzed properties exist so
 * the named cases cannot be satisfied by special-casing them.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ROTATION_REASON,
  ROTATION_SEQUENCE,
  ROTATION_STATE,
  isLegalTransition,
  maySign,
  receiptRemainsVerifiable,

  type RotationView,
} from "../../src/rotation.ts";

const RUNS = 2_000;

const MACHINE_A = "machine-a";
const MACHINE_B = "machine-b";
const KEY_OLD = "xrpl-authority-old";
const KEY_NEW = "xrpl-authority-new";

const steady = (): RotationView => ({
  activeMachineIds: [MACHINE_A],
  boundMachineId: MACHINE_A,
  xrplAuthorities: [KEY_OLD],
  boundXrplAuthority: KEY_OLD,
  state: ROTATION_STATE.STEADY,
});

describe("the only state that may sign", () => {
  it("permits signing when one machine, one authority and the binding all agree", () => {
    expect(maySign(steady())).toEqual({ maySign: true, reason: null });
  });
});

describe("the named rotation hazards", () => {
  it("refuses an old TEE holding a new XRPL key", () => {
    const v = { ...steady(), xrplAuthorities: [KEY_NEW], boundXrplAuthority: KEY_OLD };
    expect(maySign(v)).toEqual({ maySign: false, reason: ROTATION_REASON.AUTHORITY_MISMATCH });
  });

  it("refuses a new TEE holding the old XRPL key", () => {
    const v: RotationView = {
      activeMachineIds: [MACHINE_B],
      boundMachineId: MACHINE_B,
      xrplAuthorities: [KEY_OLD],
      boundXrplAuthority: KEY_NEW,
      state: ROTATION_STATE.STEADY,
    };
    expect(maySign(v)).toEqual({ maySign: false, reason: ROTATION_REASON.AUTHORITY_MISMATCH });
  });

  it("refuses two simultaneously active machine bindings", () => {
    const v = { ...steady(), activeMachineIds: [MACHINE_A, MACHINE_B] };
    expect(maySign(v)).toEqual({ maySign: false, reason: ROTATION_REASON.BINDING_AMBIGUOUS });
  });

  it("refuses a stale machine that comes back after rotation", () => {
    // Bound to B after rotating, but A reappears and is the one routable.
    const v: RotationView = {
      activeMachineIds: [MACHINE_A],
      boundMachineId: MACHINE_B,
      xrplAuthorities: [KEY_NEW],
      boundXrplAuthority: KEY_NEW,
      state: ROTATION_STATE.STEADY,
    };
    expect(maySign(v)).toEqual({ maySign: false, reason: ROTATION_REASON.STALE_MACHINE_ACTIVE });
  });

  it("refuses a coordinator attempting payment mid-rotation", () => {
    for (const state of ROTATION_SEQUENCE.filter((s) => s !== ROTATION_STATE.STEADY)) {
      const v = { ...steady(), state };
      expect(maySign(v).maySign, `state ${state} must not sign`).toBe(false);
    }
  });

  it("refuses while the old XRPL authority is still able to sign", () => {
    const v = { ...steady(), xrplAuthorities: [KEY_OLD, KEY_NEW], boundXrplAuthority: KEY_NEW };
    expect(maySign(v)).toEqual({ maySign: false, reason: ROTATION_REASON.AUTHORITY_MISMATCH });
  });

  it("refuses when no machine can receive routing", () => {
    const v = { ...steady(), activeMachineIds: [] };
    expect(maySign(v)).toEqual({ maySign: false, reason: ROTATION_REASON.MACHINE_UNAVAILABLE });
  });
});

describe("replay across machine generations", () => {
  it("keeps an earlier generation's receipt verifiable", () => {
    // Rotation changes who may sign next. It does not retract what was signed.
    expect(receiptRemainsVerifiable(0, 3)).toBe(true);
    expect(receiptRemainsVerifiable(3, 3)).toBe(true);
  });

  it("refuses a receipt claiming a generation that does not exist yet", () => {
    expect(receiptRemainsVerifiable(4, 3)).toBe(false);
    expect(receiptRemainsVerifiable(-1, 3)).toBe(false);
  });

  it("holds over arbitrary generation pairs", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: 500 }), (receiptGen, currentGen) => {
        expect(receiptRemainsVerifiable(receiptGen, currentGen)).toBe(receiptGen <= currentGen);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("the recovery path may not be skipped", () => {
  it("permits exactly the ordered steps, plus the return to steady", () => {
    for (const [i, from] of ROTATION_SEQUENCE.entries()) {
      const to = ROTATION_SEQUENCE[i + 1];
      if (to === undefined) break;
      expect(isLegalTransition(from, to)).toBe(true);
    }
    expect(isLegalTransition(ROTATION_STATE.STALE_MACHINE_PAUSED, ROTATION_STATE.STEADY)).toBe(true);
  });

  it("refuses every skip and every backward step", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: ROTATION_SEQUENCE.length - 1 }),
        fc.integer({ min: 0, max: ROTATION_SEQUENCE.length - 1 }),
        (i, j) => {
          const from = ROTATION_SEQUENCE[i];
          const to = ROTATION_SEQUENCE[j];
          if (from === undefined || to === undefined) return;
          const legal = isLegalTransition(from, to);
          const isNextStep = j === i + 1;
          const isWrapToSteady = from === ROTATION_STATE.STALE_MACHINE_PAUSED && to === ROTATION_STATE.STEADY;
          expect(legal).toBe(isNextStep || isWrapToSteady);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe("the property that matters, fuzzed", () => {
  const arbState = fc.constantFrom(...ROTATION_SEQUENCE);
  const arbId = fc.constantFrom(MACHINE_A, MACHINE_B, "machine-c");
  const arbKey = fc.constantFrom(KEY_OLD, KEY_NEW, "xrpl-authority-third");

  it("never permits signing unless exactly one machine, exactly one authority, and both bound", () => {
    fc.assert(
      fc.property(
        fc.array(arbId, { maxLength: 3 }),
        fc.option(arbId, { nil: null }),
        fc.array(arbKey, { maxLength: 3 }),
        fc.option(arbKey, { nil: null }),
        arbState,
        (activeMachineIds, boundMachineId, xrplAuthorities, boundXrplAuthority, state) => {
          const view: RotationView = {
            activeMachineIds,
            boundMachineId,
            xrplAuthorities,
            boundXrplAuthority,
            state,
          };
          const decision = maySign(view);
          if (!decision.maySign) {
            expect(decision.reason).toBeTruthy();
            return;
          }
          // If it said yes, every one of these must independently hold.
          expect(activeMachineIds).toHaveLength(1);
          expect(xrplAuthorities).toHaveLength(1);
          expect(activeMachineIds[0]).toBe(boundMachineId);
          expect(xrplAuthorities[0]).toBe(boundXrplAuthority);
          expect(state).toBe(ROTATION_STATE.STEADY);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("always gives a typed reason when it refuses", () => {
    const codes = new Set(Object.values(ROTATION_REASON));
    fc.assert(
      fc.property(
        fc.array(arbId, { maxLength: 3 }),
        fc.option(arbId, { nil: null }),
        fc.array(arbKey, { maxLength: 3 }),
        fc.option(arbKey, { nil: null }),
        arbState,
        (activeMachineIds, boundMachineId, xrplAuthorities, boundXrplAuthority, state) => {
          const decision = maySign({ activeMachineIds, boundMachineId, xrplAuthorities, boundXrplAuthority, state });
          if (!decision.maySign) expect(codes.has(decision.reason as never)).toBe(true);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
