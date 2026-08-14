/**
 * The machine-rotation state machine.
 *
 * FCC gives a TEE machine a new identity after a restart, and there is no supported flow to restore
 * the old one. So "the enclave holds the key across restarts" is false, and any design that assumed
 * it is wrong. What replaces it is an explicit rotation, during which **no payment may be signed**.
 *
 * The dangerous states are not the endpoints. They are the middles: a moment where the old machine
 * and the new one are both plausible signers, or where the FCC identity has moved and the XRPL
 * authority has not. A coordinator that keeps working through those windows is how one obligation
 * becomes two payments, or how a payment gets signed by an authority nobody can attribute later.
 *
 * This module is the executable form of that state machine. It is deliberately in the reference
 * model rather than in the extension: V0 cannot enforce most of it, because enforcement needs an
 * attested machine identity that this deployment does not have. What V0 gets is a specification
 * with tests, and an honest label. See docs/runbooks/rotation.md.
 */

export const ROTATION_STATE = {
  /** One machine, one XRPL authority, agreeing. The only state in which signing is permitted. */
  STEADY: "STEADY",
  /** The old machine is gone or unreachable. Authorization is paused. */
  OLD_MACHINE_UNAVAILABLE: "OLD_MACHINE_UNAVAILABLE",
  /** A replacement machine exists and is attested, but holds no XRPL authority yet. */
  REPLACEMENT_REGISTERED: "REPLACEMENT_REGISTERED",
  /** The replacement is bound in Signet's registry. Still no XRPL authority. */
  BINDING_ESTABLISHED: "BINDING_ESTABLISHED",
  /** XRPL RegularKey/signer authority has moved to the replacement. The old one may still work. */
  AUTHORITY_ROTATED: "AUTHORITY_ROTATED",
  /** The old XRPL authority is revoked. Exactly one authority remains. */
  OLD_AUTHORITY_REVOKED: "OLD_AUTHORITY_REVOKED",
  /** The stale FCC machine is paused so it cannot receive routing. */
  STALE_MACHINE_PAUSED: "STALE_MACHINE_PAUSED",
} as const;

export type RotationState = (typeof ROTATION_STATE)[keyof typeof ROTATION_STATE];

/** The ordered recovery path. Skipping a step is what the tests exist to catch. */
export const ROTATION_SEQUENCE: RotationState[] = [
  ROTATION_STATE.STEADY,
  ROTATION_STATE.OLD_MACHINE_UNAVAILABLE,
  ROTATION_STATE.REPLACEMENT_REGISTERED,
  ROTATION_STATE.BINDING_ESTABLISHED,
  ROTATION_STATE.AUTHORITY_ROTATED,
  ROTATION_STATE.OLD_AUTHORITY_REVOKED,
  ROTATION_STATE.STALE_MACHINE_PAUSED,
];

export const ROTATION_REASON = {
  MACHINE_UNAVAILABLE: "S030_MACHINE_UNAVAILABLE",
  BINDING_AMBIGUOUS: "S031_BINDING_AMBIGUOUS",
  AUTHORITY_MISMATCH: "S032_AUTHORITY_MISMATCH",
  ROTATION_IN_PROGRESS: "S033_ROTATION_IN_PROGRESS",
  STALE_MACHINE_ACTIVE: "S034_STALE_MACHINE_ACTIVE",
} as const;

export interface RotationView {
  /** FCC machine identities currently able to receive routing. */
  activeMachineIds: string[];
  /** The machine identity Signet's registry binding names. */
  boundMachineId: string | null;
  /** XRPL authorities that can currently sign for the source account. */
  xrplAuthorities: string[];
  /** The XRPL authority the bound machine actually holds. */
  boundXrplAuthority: string | null;
  state: RotationState;
}

export interface RotationDecision {
  maySign: boolean;
  reason: string | null;
}

/**
 * May a payment be signed in this state?
 *
 * The rule is deliberately narrow: signing is permitted only when exactly one machine can receive
 * routing, exactly one XRPL authority can sign, and the two refer to each other. Everything else
 * refuses. It is far better to stall a redemption than to sign one under an ambiguous binding,
 * because a stalled redemption is recoverable and a duplicate payment is not.
 */
export function maySign(view: RotationView): RotationDecision {
  const refuse = (reason: string): RotationDecision => ({ maySign: false, reason });

  // Two machines able to receive routing is the ambiguity itself, whatever the declared state says.
  if (view.activeMachineIds.length > 1) return refuse(ROTATION_REASON.BINDING_AMBIGUOUS);
  if (view.activeMachineIds.length === 0) return refuse(ROTATION_REASON.MACHINE_UNAVAILABLE);

  const active = view.activeMachineIds[0];

  // A stale machine that came back after rotation: active, but not the one we are bound to.
  if (view.boundMachineId === null) return refuse(ROTATION_REASON.BINDING_AMBIGUOUS);
  if (active !== view.boundMachineId) return refuse(ROTATION_REASON.STALE_MACHINE_ACTIVE);

  // New TEE with the old XRPL key, or an old TEE with a new one. Both are a mismatch and both refuse.
  if (view.boundXrplAuthority === null) return refuse(ROTATION_REASON.AUTHORITY_MISMATCH);
  if (!view.xrplAuthorities.includes(view.boundXrplAuthority)) return refuse(ROTATION_REASON.AUTHORITY_MISMATCH);

  // More than one authority can still sign: the old one was not revoked. Someone else can pay.
  if (view.xrplAuthorities.length > 1) return refuse(ROTATION_REASON.AUTHORITY_MISMATCH);

  // Any declared state other than steady means a rotation is mid-flight; the coordinator does not
  // get to decide that the checks above are enough.
  if (view.state !== ROTATION_STATE.STEADY) return refuse(ROTATION_REASON.ROTATION_IN_PROGRESS);

  return { maySign: true, reason: null };
}

/** Is this a legal step along the recovery path? Rotation may not skip or run backwards. */
export function isLegalTransition(from: RotationState, to: RotationState): boolean {
  const i = ROTATION_SEQUENCE.indexOf(from);
  const j = ROTATION_SEQUENCE.indexOf(to);
  if (i === -1 || j === -1) return false;
  // Completing the sequence returns to steady. Everything else must advance exactly one step.
  if (from === ROTATION_STATE.STALE_MACHINE_PAUSED && to === ROTATION_STATE.STEADY) return true;
  return j === i + 1;
}

/**
 * Is a receipt from an earlier machine generation still verifiable?
 *
 * Yes, and it must be. Rotation changes who may sign next; it does not retract what was signed. A
 * receipt names the machine generation that produced it, and a verifier checks it against that
 * generation rather than against whatever is current. A design where rotating keys invalidates
 * history is a design that loses its own evidence.
 */
export function receiptRemainsVerifiable(receiptGeneration: number, currentGeneration: number): boolean {
  return Number.isInteger(receiptGeneration) && receiptGeneration >= 0 && receiptGeneration <= currentGeneration;
}
