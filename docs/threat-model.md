# Threat model closure

The completion gate for hardening asks for no open critical or high issue, explicit acceptance of
medium risk, and an honest claim ledger. This is the accounting.

## Closed

| threat | closure |
|---|---|
| Coordinator obtains a signature for an arbitrary payment | Closed by gate B. `authorizeRedemption(uint256,uint32)` takes a request id and a generation; every payment field is read from FAssets by the contract. No parameter can express one. Live on Coston2. See below. |
| An obligation already paid on the underlying chain is paid again | Closed in V2 for anything validated at or before the observation; residual window stated in `docs/guarantee.md`. |
| A decision is made without looking at the underlying chain | `S022`. Refusing is the default; there is no input that authorizes without an observation. |
| An observation is stale, unsourced or contradictory | `S022`/`S023`/`S024`, all fail closed. `S023` is deliberately not auto-retried. |
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
| A caller names an obligation that does not exist | `SignetFccInstructionSender.authorizeRedemption` checks the obligation against `SignetRegistry` and reverts `NoSuchAction`. Verified live on Coston2. The first deployed sender did not do this and is retired. |
| An arbitrary command reaches the FCC extension | The extension registers one op-type and two commands, with no wildcard. An unregistered op-type or command is 501, never a decision. `scripts/fcc/extension.test.mjs`. |
| Malformed input crashes the decider | `Decide` is total. 4.6M fuzz executions, no panic, no untyped refusal. |
| Two implementations disagree | 62 frozen fixtures, plus malformed-input agreement. A review found the two parsers diverging on unknown fields; fixed in phase 09. |

## Scope note

Flare declined to approve new FAssets agents on 2026-08-11 and directed Signet to test the execution
layer instead. Threats below that concern Signet acting as an agent's signing authority describe
production architecture and are not instantiated by this deliverable. See
[`docs/evidence/organizer-accepted-proof-boundary.md`](evidence/organizer-accepted-proof-boundary.md).

## Closed by gate B: the coordinator can no longer choose the destination

This was the one real architectural gap. It is now closed, and the closure is structural rather
than statistical.

**What it was.** `decide()` trusted the redemption snapshot it was handed. A coordinator that
reported a genuine, active obligation while naming a destination or amount of its own choosing
received a real signature over a real transaction paying that destination. The obligation hash
covered only the obligation's identity, so nothing caught the substitution before signing. What
existed was attributability, which is detection after a signature exists, not prevention.

**What changed.** The FCC instruction no longer carries a caller-authored snapshot.
`SignetFccInstructionSender.authorizeRedemption(uint256 requestId, uint32 generation)` resolves the
obligation through `FAssetsAdapter.readCanonicalRedemptionById`, which reads the agent from the
request rather than accepting one, refuses anything FAssets does not report `ACTIVE`, checks the
binding and the registry action, and ABI-encodes the canonical instruction itself. The extension
decodes that payload and reads the obligation from it alone. A caller-authored obligation now fails
to *decode* on the FCC path, and the FCC test asserts it fails as a decode error rather than a policy
refusal, because a policy refusal would mean the path still existed.

> **Scoped precisely.** An earlier version of this paragraph said "the JSON path is gone rather than
> deprecated". That is true of the FCC-reachable path and false of the repository: `internal/wire`
> still decodes a fully caller-authored obligation and `cmd/signet-extension` still runs it from
> stdin. Nothing reaches a key through it in this build, and the composed lifecycle uses it only for
> a Go-versus-reference conformance check on script-derived input. Recorded as an open finding below
> rather than described as removed.

There is no parameter through which a caller can express a payment field. That is the invariant's
strongest available form.

**Two things the extension still supplies for itself,** because a caller must not control them and
the chain cannot know them:

| input | why it is not caller-supplied |
|---|---|
| XRPL allocation | bounded downstream by the fee cap and the safety margin |
| underlying observation | taken by `internal/xrplobserve` across independently hosted endpoints that must agree. An observation supplied by the party that wants the signature is worth nothing, which is why this is a second implementation of the coordinator's observer rather than a call into it |

**Proof.**

| | |
|---|---|
| Solidity | 5 tests, including a 256-run fuzz over caller addresses asserting one request id yields one payload for every caller, and a selector assertion that `authorizeRedemption(uint256,uint32)` carries no payment field |
| Go | 16 tests, covering schema refusal, truncation, and an override attempt on each of destination, amount, fee, reference, tag mode, tag value, both deadlines and agent. The trailing-byte case is not an assertion; see open finding 4 |
| live | sender [`0x3FFA63a3bf21a626c1B391D2577b1800e67F5Be0`](https://coston2.testnet.flarescan.com/address/0x3FFA63a3bf21a626c1B391D2577b1800e67F5Be0), extension id `66244`, deployed and registered on the live Coston2 `FlareTeeManager`. `getTeeExtensionInstructionsSender(66244)` returns that address |

**Residual, and it is not small.** The extension still runs as a local process with no attestation,
so an operator with host access can bypass the contract path entirely by running its own binary
against its own key. Gate B removes the *protocol-level* path to an arbitrary signature; it does not
create isolation between the decider and the host. That is what a real TEE would buy and this
deliverable does not have one. **Risk rating: medium, accepted for this build, blocking for
production.**

## Open after gate B

An adversarial review of the gate B boundary on 2026-08-14 found five defects. All five are recorded
here rather than fixed, because phase 14's completion gate forbids feature work and the contract half
is already deployed: changing the source without redeploying would put the repository and the chain
out of agreement, which is a worse failure than a stated defect. Each was independently reproduced
before being written down.

| # | severity | defect | reachable today? |
|---|---|---|---|
| 1 | high | `authorizeRedemption` is re-invocable after a decision is recorded | **no**, see below |
| 2 | high | the FCC extension never populates `Prior`, so `generation > 0` is always refused | yes, fail-closed |
| 3 | medium | a caller-authored JSON obligation decoder still exists outside the FCC path | yes, reaches no key |
| 4 | medium | `fccinput.Decode` does not reject trailing bytes although its doc comment says it does | no |
| 5 | low | `xrplobserve` matches only `Memos[0]` when looking for a payment reference | yes, narrows an accepted residual |

### 1. `authorizeRedemption` does not gate on the action state it needs

`SignetFccInstructionSender.sol:180` reads:

```solidity
if (action.state == SignetRegistry.ActionState.NONE) revert NoSuchAction();
```

That admits `REQUESTED`, `AUTHORIZED`, `REFUSED` and `EVIDENCE_FINALIZED` alike, so an action already
moved to `AUTHORIZED` can be instructed again. The extension cannot catch the repeat, because it sets
`Prior: nil` (defect 2) and re-reads the XRPL account's current sequence, so a second call would
produce a second independently valid payment. `S021_PAYMENT_ALREADY_OBSERVED` only fires once the
first payment has validated on the XRP ledger, which leaves the settlement-latency window open.

**It is not reachable in the deployed configuration.** No TEE machine is registered for extension
`66244`, so line 211's `getRandomTeeIds(66244, 1)` reverts `0xd65ac61e` before any instruction is
sent. Verified live:

```bash
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getActiveTeeMachines(uint256)(address[])" 66244 --rpc-url https://coston2-api.flare.network/ext/C/rpc
# []
```

**This arms itself the moment gate A lands.** Registering a TEE machine is precisely what makes this
path executable, so the guard must be tightened to `!= REQUESTED` with a typed error, and a Foundry
test must assert the revert, *before* any Confidential Space deployment. It is listed as a blocker in
[`../run/GATE_A_STRETCH.md`](../run/GATE_A_STRETCH.md). No existing test covers it: the five gate B
Solidity tests exercise the read-only `canonicalInstructionFor` preview and the entry point's
selector, never the state-changing function.

### 2. `Prior` is hardcoded to nil, so the replacement flow is dead code

`extension/cmd/signet-fcc-extension/main.go:346` sets `Prior: nil` unconditionally.
`policy.go:386` then reads `if len(in.Prior) != r.RequestGeneration { refuse(ReasonReplacementNotAuthorized) }`,
so every request with `generation > 0` is refused `S018` regardless of merit, and the
prior-generation and sequence-collision guards below it can never fire.

This contradicts `phase-07.md:66-68`, which records that `Prior` must come from the extension's own
durable state and the registry's on-chain action state. It does neither. The behaviour is fail-closed
and opens no fund-loss path, but it disables a documented feature and removes a category of
decision-time protection. It cannot be fixed by wiring alone: `CanonicalInstruction` carries no
prior-generation data, so either the schema extends or the extension gains a registry client.

### 3. The caller-authored decoder still exists outside the FCC path

`extension/internal/wire/input.go` accepts `PaymentAddress`, `ValueUBA`, `FeeUBA`,
`PaymentReference`, the destination tag, both window bounds, `Prior` and `Underlying` directly from
JSON, and `cmd/signet-extension` still runs it from stdin. It is still built.

Nothing reaches a key through it here, and the composed lifecycle uses it only for a Go-versus-
reference conformance check on script-derived input. It matters because the decoder that made the
pre-gate-B vulnerability possible was never deleted: wiring this binary's output to a real key "for
local ops" would reopen it immediately. Either delete `internal/wire` and `cmd/signet-extension`, or
keep the scope statement above attached to every description of gate B.

### 4. `Decode` does not reject trailing bytes

`extension/internal/fccinput/canonical.go:94` claims: *"It refuses an unknown schema version and a
payload with trailing bytes."* No length check exists in the function. Appending 32 zero bytes to a
valid payload is accepted silently. `TestTrailingBytesAreNotSilentlyAccepted` passes only because it
was written to accept either outcome.

Not currently exploitable: the `message` bytes are built exclusively by `abi.encode(instruction)`
on chain, so appending to them means already controlling the FCC transport, which is host-access
equivalent. It is a forward-compatibility gap and a comment that describes code that does not exist.

### 5. `xrplobserve` inspects only the first memo

`extension/internal/xrplobserve/observe.go:185` matches `tx.Memos[0]` only. A third-party payment
carrying the redemption reference in a later memo slot would be invisible to `S021`. Signet's own
payments always use a single memo, so this widens the already-accepted competing-payment residual
rather than creating a new class of risk.

### What the review confirmed clean

Every attempt to influence destination, amount, fee, reference, tag mode, tag value, either window
bound or the agent vault through the FCC path failed. Truncation is correctly rejected. Pagination in
`xrplobserve` fails closed rather than truncating, non-responding endpoints are excluded from the
agreement comparison rather than counted as agreeing, and `readCanonicalRedemptionById` cannot return
an agent that diverges from the binding looked up in the same call.

## Closed in V2: an obligation already paid by someone else

Found by running Phase 10 against the live chain, where it caused a real duplicate payment on
request 44928272. Now corrected at the protocol layer rather than mitigated around.

A FAssets status of `ACTIVE` does not mean an obligation is unpaid. It means the underlying payment
has not yet been confirmed on Flare, and confirmation is a separate transaction submitted after the
payment validates. In that window FAssets reports the obligation as open while the payment exists.

Signet's three original duplicate-payment guards all watched the wrong chain for it. The registry
action state, the coordinator's unique indexes and the ledger's sequence consumption prevent *Signet*
paying twice; none can see a payment made by another party.

**Schema V2 adds the missing observation.** The decision now requires the signing boundary to have
looked at the XRP ledger itself, and refuses on every way that look can fail:

| code | when |
|---|---|
| `S021_PAYMENT_ALREADY_OBSERVED` | a validated payment already carries this reference to this destination |
| `S022_UNDERLYING_STATE_UNAVAILABLE` | no observation, an unavailable one, or too few agreeing sources |
| `S023_UNDERLYING_STATE_DISAGREEMENT` | independently operated endpoints contradicted each other |
| `S024_UNDERLYING_OBSERVATION_STALE` | older than policy allows, or from a ledger nobody validated |

The observation is bound into the authorization commitment, so a decision made on a bad look is not
afterwards indistinguishable from one made on a clean look, and the width of the window for any
historical payment is public arithmetic.

`scripts/lifecycle/incident-44928272.test.mjs` replays the incident against both implementations
every time the gate runs. It asserts the refusal and, more importantly, that **no V2 input reproduces
the original authorization**.

**Residual, and it cannot be closed:** a competing payment that validates after Signet's observation
and before Signet's own payment validates is not detectable. That window measured 4 ledgers in the single V2 run this build
produced; one sample is not a range. See [`docs/guarantee.md`](guarantee.md) for the precise statement and for the production
configuration under which no independent legitimate payer exists at all.

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
