# Threat model closure

The completion gate for hardening asks for no open critical or high issue, explicit acceptance of
medium risk, and an honest claim ledger. This is the accounting.

## Closed

| threat | closure |
|---|---|
| Coordinator obtains a signature for an arbitrary payment | **Not closed.** See below. |
| Coordinator replays an obligation to pay twice | Registry rejects a repeated action (`ActionExists`); the coordinator database enforces one completion per obligation by unique index; the XRP ledger refuses a consumed sequence with `tefPAST_SEQ`. Three independent layers, each proven. |
| Duplicate event delivery creates duplicate authority | `observed_events` primary key with `ON CONFLICT DO NOTHING`; proven under three concurrent workers. |
| A crash between signing and submitting loses or duplicates a payment | The blob is persisted before first submission and survives restart with `submitted_at` null; proven. |
| A stale worker writes after losing its lease | Fencing tokens from a monotonic sequence; a stale token is rejected; proven. |
| A replacement is created while the prior generation is unresolved | `S018_REPLACEMENT_NOT_AUTHORIZED` unless every prior generation is `PROVEN_NOT_SUCCESSFUL`. |
| A replacement is created during a ledger-history gap | Absence requires an endpoint that answers "not found" and whose history covers the whole span. A review found an earlier version accepting coverage from an endpoint never asked; fixed in phase 04. |
| Partial payment delivers less than the obligation | `Flags` pinned to 0 by both deciders, compared in the signed blob, and re-checked on the ledger by the verifier. |
| An unapproved build signs | Registry approves a code hash; a revoked hash refuses `S015`. |
| Governance authorizes itself as a signer | `approveSigner` rejects governance. |
| Signature malleability | Low-s and v bounds enforced in `_recover`. |
| Malformed input crashes the decider | `Decide` is total. 4.6M fuzz executions, no panic, no untyped refusal. |
| Two implementations disagree | 62 frozen fixtures, plus malformed-input agreement. A review found the two parsers diverging on unknown fields; fixed in phase 09. |

## Open: the coordinator can obtain a signature for a destination it chooses

This is the one real architectural gap and it is not closed.

`decide()` trusts the redemption snapshot it is handed. A coordinator that reports a genuine, active
obligation while naming a destination or amount of its own choosing receives a real signature over a
real transaction paying that destination. The obligation hash covers only the obligation's identity,
so nothing about it catches the substitution before signing.

PRD section 22.3 lists "coordinator cannot obtain arbitrary signature" as the mitigation for a
malicious coordinator operator. **It is not implemented.**

What exists is attributability. The authorization commitment covers every payment field, so an
independent party who reads the obligation from FAssets recomputes a different commitment. Phase 11's
verifier performs that recomputation and phase 11's corruption tests prove a moved destination is
caught by it. That is detection after a signature exists, not prevention.

Closing it properly means the signing boundary reading FAssets itself rather than accepting a
snapshot, which is architecture work, not hardening. It is recorded in the claim ledger under
`claim-composed-lifecycle` and stated in the phase 09 evidence.

**Risk rating: high, accepted for this build, blocking for production.** A V0 whose extension runs
outside a TEE already has no isolation between the decider and the process that supplies its inputs,
so closing this in isolation would not buy what it appears to.

## Accepted medium risks

Each of these is a decision, not an oversight.

1. **XRPL serialization and signing use the `xrpl` library rather than Go.** The decision, and so
   every payment field, is constructed in Go. The library only encodes and signs, and the blob is
   decoded back and compared field by field. Accepted: a hand-written serializer would be new,
   unaudited code in the most safety-critical path, which is a worse trade than a widely used
   library plus a round-trip check.
2. **The signed blob is stored in plain text.** PRD 14.3 asks for encryption at rest. Accepted for a
   testnet build with test-only keys, and recorded rather than done. A blob is not a key: it
   authorizes exactly one payment that is already public once submitted.
3. **`decisionContext` is supplied by the receipt.** A receipt that lied about `extensionCodeHash`
   would produce a self-consistent commitment. Accepted until the registry is deployed, at which
   point the verifier reads it from chain instead.
4. **The fork follows the live Coston2 head.** A run is not reproducible by block number alone,
   because it also depends on a real agent's capacity. Accepted: pinning a block produces expired
   payment windows, which disables exactly the checks the run exists to exercise.
5. **Tag mode and ticket mode are covered by fixtures, not end to end.** Accepted: 62 frozen
   fixtures cover both, and the composed lifecycle exercises whichever mode the obligation uses.

## Measured

| | |
|---|---|
| Decision latency, p50 | 5.0 ms |
| p95 | 19.4 ms |
| p99 | 62.7 ms |
| max over 200 runs | 71.2 ms |

Process spawn included, because that is how the extension is invoked. The tail is spawn cost rather
than decision cost; the decision itself is a few hundred microseconds by the fuzzer's throughput
(4.6M executions in 30 seconds across cores).

## Not done

- No container scan: nothing is containerised in this build.
- No chaos testing against running processes. Crash and concurrency behaviour is proven at the
  database and ledger layers instead, which is where the invariants live, but a process-level chaos
  suite would be a stronger statement.
- No external penetration test.
