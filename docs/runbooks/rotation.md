# Machine rotation and key recovery

FCC gives a TEE machine a **new identity after a restart**, and there is no supported flow to restore
the old one. So rotation is not an exceptional procedure. It is the normal consequence of a restart,
and any design that assumed an enclave holds its key across restarts is wrong.

**No payment may be signed during an ambiguous binding transition.** Stalling a redemption is
recoverable. A duplicate payment, or one signed by an authority nobody can attribute afterwards, is
not.

## The state machine

```text
STEADY
  → OLD_MACHINE_UNAVAILABLE      authorization paused
    → REPLACEMENT_REGISTERED     replacement FCC machine registered and attested
      → BINDING_ESTABLISHED      new machine bound in SignetRegistry
        → AUTHORITY_ROTATED      XRPL RegularKey/signer moved via the offline recovery authority
          → OLD_AUTHORITY_REVOKED
            → STALE_MACHINE_PAUSED
              → STEADY           authorization resumes
```

Executable form: [`reference/src/rotation.ts`](../../reference/src/rotation.ts). Steps may not be
skipped and may not run backwards, asserted over all ordered pairs.

## The signing rule

Signing is permitted only when **exactly one** machine can receive routing, **exactly one** XRPL
authority can sign, the two refer to each other, and the declared state is `STEADY`. Everything else
refuses with a typed reason:

| code | when |
|---|---|
| `S030_MACHINE_UNAVAILABLE` | no machine can receive routing |
| `S031_BINDING_AMBIGUOUS` | more than one active machine, or no binding |
| `S032_AUTHORITY_MISMATCH` | the bound machine does not hold the signing authority, or the old authority still can sign |
| `S033_ROTATION_IN_PROGRESS` | any state other than `STEADY` |
| `S034_STALE_MACHINE_ACTIVE` | the routable machine is not the bound one |

## The hazards, and where each is proven

All in [`reference/test/property/rotation.property.test.ts`](../../reference/test/property/rotation.property.test.ts),
15 tests including 2,000-run fuzzed properties:

| hazard | outcome |
|---|---|
| old TEE + new XRPL key | `S032_AUTHORITY_MISMATCH` |
| new TEE + old XRPL key | `S032_AUTHORITY_MISMATCH` |
| two simultaneously active machine bindings | `S031_BINDING_AMBIGUOUS` |
| stale machine returns after rotation | `S034_STALE_MACHINE_ACTIVE` |
| coordinator attempts payment mid-rotation | `S033_ROTATION_IN_PROGRESS`, every non-steady state |
| old authority not yet revoked | `S032_AUTHORITY_MISMATCH` |
| replay across machine generations | an earlier generation's receipt **stays verifiable**; a receipt claiming a future generation is refused |

Receipt verification deliberately survives rotation. Rotation changes who may sign next; it does not
retract what was signed. A design where rotating keys invalidates history is one that loses its own
evidence.

## What V0 enforces, and what it does not

This is the honest split, and most of it falls on the wrong side.

| | |
|---|---|
| **enforced in V0** | at most one FCC instruction dispatch per `(requestId, generation)`, on chain via `instructionDispatched`, surviving any off-chain restart |
| **enforced in V0** | `make doctor` detects every hazard above from public state: multiple active machines, a stale machine, a registered URL whose live identity disagrees, an old extension still routable |
| **specification only** | the rotation state machine itself. It is executable and tested, but nothing in V0 *forces* a coordinator through it |
| **production architecture** | binding an FCC machine identity to an XRPL authority. This needs an attested machine identity, which this deployment does not have |
| **production architecture** | the offline recovery authority that performs the XRPL `SetRegularKey` rotation and revocation |

**Classification: the rotation state machine is production architecture with an executable
specification and property tests. It is not an implemented V0 control.** Recorded that way in the
claim ledger rather than presented as a working feature.

## Operator procedure

1. **Detect.** `make doctor`. More than one active machine is a loud `WARN`; a registered URL whose
   live identity disagrees is a `FAIL`.
2. **Pause authorization.** Before anything else. `SignetRegistry.pauseAgent(bindingId, true)`, which
   the contract tests prove stops an otherwise admissible dispatch.
3. **Register the replacement** and confirm its attestation and code hash.
4. **Bind it** in `SignetRegistry`.
5. **Rotate XRPL authority** through the offline recovery authority.
6. **Revoke the old authority.** Verify exactly one authority can sign.
7. **Pause the stale FCC machine** so it cannot receive routing.
8. **Resume.** `make doctor` must be clean first.

`make doctor` never performs any of steps 2 through 7. It reads. A command that both diagnoses and
mutates gets run reflexively during an incident, which is when mutating is most dangerous.
