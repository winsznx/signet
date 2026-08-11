# Phase 13 — Hardening

Result: **PASS**, with one open high-severity architectural gap accepted and stated rather than
closed.
Date: 2026-08-11
Documents: [`../threat-model.md`](../threat-model.md), [`../runbooks/recovery.md`](../runbooks/recovery.md)

## 1. Dependency scan: clean

`pnpm audit` reported a high and a moderate `ws` advisory reaching the tree through `viem`, plus a
critical `vitest` advisory.

`vitest` was a version bump. `ws` was not: a `pnpm` override never bound, because `isows` takes `ws`
as a peer dependency and the override did not reach the peer-resolved edge. Bumping `viem` to
2.55.13 and reinstalling from a deleted lockfile resolved it.

```text
No known vulnerabilities found
```

The alternative considered and rejected was deleting `viem`, which is imported by exactly one
access-probe script. Removing a dependency to dodge an advisory, and replacing audited ABI decoding
with hand-rolled decoding in the process, would have traded a theoretical risk for a real one.

## 2. Fuzzing the decision boundary

Two targets, both asserting **totality** rather than acceptance. Fuzzing toward acceptance is fuzzing
toward a weaker parser.

| target | executions | result |
|---|---|---|
| `FuzzDecodeNeverPanics` (wire decoder) | 1,690,429 | no panic |
| `FuzzDecideIsTotal` (policy) | 4,580,859 | no panic, no untyped refusal, no decision without an obligation |

`Decide` promises every input yields either an authorization or a typed refusal. That promise is what
makes the extension a trust boundary: a caller who can crash the decider can stop payments, and one
who can make it return nothing can make a coordinator guess.

## 3. Threat model: what is closed and what is not

[`docs/threat-model.md`](../threat-model.md) has the table. Thirteen threats are closed, each with
the mechanism and where it is proven.

**One is not.** A coordinator that reports a genuine active obligation while naming a destination of
its own choosing receives a real signature. PRD section 22.3 lists "coordinator cannot obtain
arbitrary signature" as the mitigation for that adversary and it is not implemented. What exists is
attributability: the commitment covers every payment field, the verifier recomputes it, and phase
11's corruption tests prove a moved destination is caught. That is detection after a signature
exists.

Rated high, accepted for this build, blocking for production. Closing it means the signing boundary
reading FAssets itself rather than accepting a snapshot, which is architecture work rather than
hardening.

Five medium risks are accepted with stated reasons: the signing library, the plaintext blob,
receipt-supplied decision context, the head-following fork, and fixture-covered tag and ticket modes.

## 4. Recovery runbook

[`docs/runbooks/recovery.md`](../runbooks/recovery.md) covers a crash between signing and submitting,
an unresolved submission, a refusal an operator disputes, key rotation, and suspected extension
compromise.

Every procedure opens with the same question, because getting it wrong is how one redemption becomes
two payments: can a source outside this process say what happened to the last signed transaction? If
not, nothing else proceeds.

It also records what does not exist: there is no override that turns a refusal into an
authorization, because a path like that is an arbitrary signing endpoint wearing a different name.

## 5. Performance

Decision latency over 200 runs, process spawn included, because that is how the extension is
invoked:

| p50 | p95 | p99 | max |
|---|---|---|---|
| 5.0 ms | 19.4 ms | 62.7 ms | 71.2 ms |

The tail is spawn cost. The decision itself runs in the low hundreds of microseconds, implied by the
fuzzer sustaining 4.6M executions in 30 seconds.

## 6. Fresh-clone verification

> **Counts below predate schema V2.** They were true when this phase ran. The current figures are 174
> reference tests and 76 V2 conformance fixtures; see `docs/evidence/organizer-accepted-proof-boundary.md`.


The branch was cloned to a clean directory and built from nothing but the lockfile and
`scripts/install-go.sh`.

```text
150 reference tests
 12 property tests
 69 contract tests, including 12 fork tests against live Coston2
    Go conformance across all 62 frozen fixtures: PASS
 17 verifier tests
    web accessibility and honesty checks: pass
  5 reconciliation regression tests
  7 secret-scan regression fixtures
    secret scan: 153 tracked files, no key material
    pnpm audit: no known vulnerabilities
```

`make bootstrap` refetched all 11 pinned upstream sources with matching content hashes. The verifier
ran from the clone with no credentials and recomputed the authorization commitment of the composed
lifecycle receipt successfully.

## 7. Not done

- No container scan: nothing is containerised in this build.
- No process-level chaos testing. Crash and concurrency behaviour is proven at the database and
  ledger layers, which is where the invariants live, but killing running processes would be a
  stronger statement.
- No external penetration test and no third-party audit.
- No screen-reader testing of the proof pages.
