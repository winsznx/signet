# Phase 07 — Signet extension policy

Result: **PARTIAL PASS.** The decision and the canonical encoding are implemented in Go and agree
with the reference model on all 62 frozen fixtures. XRPL signing inside the extension and the FCC
serving surface remain, and the latter is gated on Phase 03.
Date: 2026-08-11
Branch: `build/signet-autonomous`

## 1. Objective

Implement the canonical decoder, compare against the reference model, construct the XRPL Payment,
and produce typed refusals. The completion gate is: valid fixture signs, all invalid fixtures
refuse, no secret in logs.

## 2. The result that matters

```text
checking 62 fixtures against fixtureSetHash
  0x73368da32c57e012df479ab15389b2b1f5c133eb6b494bf1f7968e644567f69c
ok  github.com/signet/extension/internal/conformance
```

Every one of the 62 frozen fixtures produces an identical decision in Go and TypeScript: the same
outcome, the same reason code, the same error class, the same obligation hash, the same
authorization commitment, and a field-by-field identical transaction template.

That is I-016 made real. The Go package exists to be checked against the reference model, not to be
trusted on its own.

## 3. Why this was written from the ADR, not transliterated

The encoding was implemented from `docs/adr/0001-canonical-encoding.md` rather than translated line
by line from the TypeScript. A transliteration reproduces a mistake as faithfully as it reproduces
the design, and would have made the conformance test a check that two copies of one file agree.

It caught a real divergence on the first run.

## 4. The divergence

61 of 62 fixtures matched immediately. One did not:

```text
--- FAIL: refuse-negative-request-generation
    obligationHash:
      go        0x31e3d860072262eeb11afc5e250c3d7e4c884b9702fc4fbc24c0da966c0e9f75
      reference 0x204173467404766afae70b1791ede8d74148541a1fb50f612596bc6908de8e16
```

Go clamped a negative request generation to zero before hashing. The reference model lets the
fixed-width encode fail and falls back to an unattributable hash.

The reference model is right and the clamp was a real bug. Clamping attributes a refusal to
generation 0, which is a genuine and different obligation, so a malformed input would have produced
a refusal receipt pointing at real work. Go now matches.

This is exactly the class of bug the phase exists to catch: both implementations refused, both
returned the same reason code, and they disagreed only on which obligation the refusal was about.
Nothing short of a byte-level cross-language comparison would have surfaced it.

## 5. What the Go extension does not have

There is no arbitrary signing path. The package exposes one decision function taking a complete
obligation and returning either an authorization or a typed refusal. There is no `Sign(message)`,
no wildcard handler and no command that accepts caller-supplied payment fields.

The trust caveats from ADR 0002 are carried into the Go types as comments on `Input`: `Prior` must
come from the extension's own durable state and the registry's on-chain action state, never from a
coordinator request, and `CurrentValidatedLedger` must be observed by the signing boundary itself.

## 6. Tests

| Command | Result |
|---|---|
| `make test-conformance` | 62/62 fixtures agree |
| `make test-race` | pass under `-race` |
| `make lint` (`gofmt`, `go vet`) | clean |

## 7. What remains in this phase

- XRPL transaction **signing** inside the extension. The template is produced and proven identical;
  signing it in Go with the enclave key is not done. Phase 04 proved the signing path with the
  official SDK in a local process.
- The FCC HTTP serving surface (`POST /action`, `GET /state`) and the `AUTHORIZE_REDEMPTION`,
  `HEALTH_CHECK`, `PUBLIC_KEY`, `ROTATION_PREPARE`, `ROTATION_CONFIRM` commands. The contract for
  these is documented in `docs/protocol-seams/fcc.md`; wiring them needs the Phase 03 deployment,
  which is blocked on C2FLR.
- Fuzzing the canonical decoder, and the restart and key-state cases.

Because of those, this phase is recorded as a partial pass. The completion gate's first two clauses
are met against the fixtures; "valid fixture signs" is met in the sense that the valid fixtures
authorize and produce the exact template, not in the sense that Go has signed one.

## 8. Limitations

- Local only. No secret material is handled by this code at all yet, which is why "no secret in
  logs" is trivially true and should not be claimed as a hardened property.
- The Go decision has not been run inside a TEE, simulated or otherwise.
- Conformance proves agreement with the reference model. Both could be wrong together about what
  FAssets requires; that is what Phases 02 and 05 test independently.
