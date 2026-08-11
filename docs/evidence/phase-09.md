# Phase 09 — Full local composed lifecycle

Result: **PASS.** 59/59 checks.
Date: 2026-08-11
Command: `make lifecycle`
Artifact: [`artifacts/lifecycle-run.json`](artifacts/lifecycle-run.json)

## 1. What is real here

A lifecycle demo that blurs the line between real and simulated is worse than no demo, so:

| | |
|---|---|
| real | the FAssets code producing the obligation: deployed Coston2 bytecode, executing on a fork |
| real | the Signet contracts, deployed and driven through their actual entry points |
| real | the XRPL Testnet payment: signed, submitted, validated, reconciled against independent endpoints |
| real | the FDC XRPPayment attestation request, answered `VALID` by the testnet verifier |
| local | the chain the Flare half runs on. A fork, so no C2FLR is required and the run repeats |
| local | the extension's execution environment. A process, not Confidential Space. **Nothing here is hardware-attested and nothing claims to be.** |

## 2. How the obligation is created

The run impersonates a genuine Coston2 FXRP holder on the fork and calls the real
`redeem(lots, underlyingAddress, executor)`, naming **our own** XRPL Testnet account as the
redeemer's underlying address. FAssets then selects an agent, burns the FXRP and emits
`RedemptionRequested` with the payment window, amount, fee and reference it chose.

Using our own destination is what makes the XRPL half executable. A payment to a third party's agent
address would move real testnet funds inside someone else's live redemption, and proving our system
works is not a reason to interfere with theirs.

Nothing about the obligation is asserted by the test, and nothing is substituted. Destination,
amount, fee, reference and both halves of the payment window are read out of the event FAssets
emitted, and the run asserts field by field that the values reaching the decision are those values:

```text
ok   obligation field firstUnderlyingBlock is the one fassets emitted    19823217
ok   obligation field lastUnderlyingBlock is the one fassets emitted     19824222
ok   obligation field lastUnderlyingTimestamp is the one fassets emitted 1786464166
ok   obligation field valueUBA is the one fassets emitted                10000000
ok   obligation field feeUBA is the one fassets emitted                  50000
ok   obligation field paymentReference is the one fassets emitted
ok   obligation field paymentAddress is the one fassets emitted
```

Those guards exist because an earlier version of this harness did substitute the window, replacing
`firstUnderlyingBlock` and `lastUnderlyingBlock` with values derived from the live XRP ledger while
a comment claimed the opposite. The deadline and safety-margin checks were therefore running against
a window this harness invented, which is exactly the invariant Signet exists to hold. A security
review caught it. The window is now used verbatim, and the guards make a repeat visible.

### Run coordinates

The 59/59 figure belongs to one specific run, and the state it depended on lives on a live testnet
rather than in this repository:

| | |
|---|---|
| Coston2 fork block | 33928981 |
| FAssets request id | 44892968 |
| agent vault | 0xd5defe2c62d48788bb3889534fbfe7aea0602d64 |
| FXRP holder impersonated | 0xff02f742106b8a25c26e65c1f0d66bec3c90d429 |
| XRPL transaction | 28B48DC36ACFDA1C22E97C033941355E4680B8F28964DB78F68AA44B41FBEFF4 |

A rerun picks a fresh head and a fresh request id, and would fail loudly rather than silently pass
if that holder's balance or the agent's redeemable capacity changed.

## 3. Three implementations, one obligation

```text
solidity   SignetInstructionSender.obligationHashFor, called on the deployed contract
go         extension/cmd/signet-extension
typescript reference/src/cli-decide.ts
```

All three returned `0x2471ac8799e2efa0f23a700b8884b41d05b4bf08c2fff5150b8a5e2b073d66a7` for request
44892968. The Go and TypeScript deciders were handed byte-identical input and were required to agree
on kind, obligation hash, authorization commitment and reason code for **every** case in the run,
valid and attack alike.

The extension is now a process rather than a library, and the decoder that parses its input was
moved into `extension/internal/wire` so the binary and the 62 frozen conformance fixtures share one
parser. Before this, the fixtures tested a parser that never ran in production.

## 4. The payment came from FAssets, not from us

```text
ok   destination came from fassets          rpa8bBa8GS1Zit6y9PcpQbahkqFahpWMyb
ok   amount is value minus fee, exactly     9950000 drops
ok   memo carries the fassets payment reference
ok   source is the bound account            rPvarExLQuuqtkMBfDHp3pNnESZ5HByXta
```

The transaction submitted is the decision's own payment object. Nothing is added, corrected or
re-derived between the decision and the signature. The signed blob is then decoded back and compared
field by field to what the extension authorized, because a signature over a transaction the decider
never approved is precisely the failure this system exists to prevent.

## 5. Live XRPL execution

```text
ok   signed transaction persisted before first submission
ok   provisional response received                    tesSUCCESS (not a result)
ok   payment reached validated success on xrpl testnet  ledger 19823767
ok   resubmitting the identical blob cannot pay twice   tefPAST_SEQ
ok   fdc verifier accepts an attestation request        VALID
```

Transaction `28B48DC36ACFDA1C22E97C033941355E4680B8F28964DB78F68AA44B41FBEFF4` on XRPL Testnet.

The replay line is the one worth reading twice. The identical signed blob was submitted a second
time and the ledger refused it, because its sequence was already consumed. That is the last line of
defence behind the coordinator's database constraints and the registry's action state, and it is now
demonstrated rather than assumed.

## 6. Attack lifecycles

Every one was run through both deciders, which agreed on all of them.

| attack | outcome |
|---|---|
| destination moved to an attacker's address | **authorizes**, and the commitment changes |
| amount raised by one unit | **authorizes**, and the commitment changes |
| redemption already SUCCESSFUL | `S004_INACTIVE_REDEMPTION` |
| obligation belongs to another agent | `S005_WRONG_AGENT` |
| underlying window fully expired | `S007_EXPIRED_WINDOW` |
| fee above the cap | `S013_FEE_CAP_EXCEEDED` |
| system paused | `S016_PAUSED` |
| binding retired | `S003_UNBOUND_AGENT` |
| binding covers a different vault | `S005_WRONG_AGENT` |
| binding state unreadable | `S017_STATE_UNAVAILABLE` |
| extension code version revoked | `S015_CODE_VERSION_REVOKED` |
| replacement generation with an unresolved prior | `S018_REPLACEMENT_NOT_AUTHORIZED` |
| replaying the action on chain | reverts `ActionExists` |
| opening an action for an unbound agent | reverts `BindingNotActive` |

### The first two rows are an open gap, not a defeated attack

A coordinator that reports a real, active obligation but names a destination or amount of its
choosing **is not refused**. It gets a real signature over a real transaction paying the address it
chose. The run asserts that outcome explicitly rather than hoping nobody looks:

```text
ok   the moved destination still authorizes, so detection cannot rely on refusal
ok   moving the destination does not change the obligation identity
ok   moving the destination breaks the authorization commitment
```

The obligation hash covers only schema version, chain id, asset manager, agent vault, request id and
generation. It does not cover the destination, so nothing in the obligation identity catches this
before signing. `decide()` trusts the redemption snapshot it is handed, and no component in this
build performs an independent FAssets read before signing.

PRD section 22.3 lists "coordinator cannot obtain arbitrary signature" as the mitigation for a
malicious coordinator operator. **That mitigation is not implemented as of this phase and must not
be treated as satisfied by it.** What exists is attributability: the authorization commitment covers
every payment field, so anyone who reads the obligation from FAssets themselves recomputes a
different commitment and the lie becomes visible in public evidence. That is detection after the
signature exists and after persist-before-submit has already made the blob durable and submittable.
Phase 11's independent verifier is what performs the recomputation. Closing the gap properly means
the signing boundary reading FAssets itself rather than accepting a snapshot, which is architecture
work this phase does not do.

Three failure modes that could have been collapsed into one reason code deliberately are not:
retired binding, mismatched vault and unreadable state. Only the last is safe to retry, so merging
them would make retry behaviour wrong.

## 7. Malformed input, and a divergence a review found

The two deciders agreed on every well-formed case and disagreed on malformed ones. Go rejected an
unknown field at any nesting depth; the reference parser only checked the top level and silently
dropped anything extra inside `policy`, `redemption` or `prior`. So an input Go refused outright was
accepted and decided by TypeScript, and none of the 62 frozen fixtures could have caught it, because
every fixture is well formed.

Both parsers now reject unknown fields at every level and exit 1 rather than emitting a decision. A
malformed input is not a refusal: a refusal is a statement about a real obligation, and an input
that will not parse does not identify one, so answering it would attribute a decision to an
obligation nobody named. The run holds them to it:

```text
ok   malformed input unknown top-level field is rejected identically   go exit 1, reference exit 1
ok   malformed input unknown nested field is rejected identically      go exit 1, reference exit 1
ok   malformed input unknown field inside prior is rejected identically go exit 1, reference exit 1
```

## 8. Two expectations I had wrong

Both were corrected by making the test right, not by changing the system.

- Expiring only `lastUnderlyingTimestamp` trips `S008_INSUFFICIENT_SAFETY_MARGIN`, not
  `S007_EXPIRED_WINDOW`. The margin check is upstream of hard expiry, which is correct: the point is
  to stop before the deadline, not at it. Both halves of the window must be in the past for S007.
- A `null` binding is `S017_STATE_UNAVAILABLE`, not `S003_UNBOUND_AGENT`. "I could not read my own
  state" is a different claim from "this agent is not bound", and the extension was right to
  distinguish them.

## 9. Determinism

The fork follows the live Coston2 head rather than a fixed block. A fixed block looked more
reproducible and was not: the obligation carries an XRP-ledger payment window, and a fork pinned to
yesterday hands out windows that expired hours ago, so the run would refuse for a reason that says
nothing about the code. Following the head keeps the window as fresh as a real agent's and lets the
deadline and margin checks do real work. `SIGNET_FORK_BLOCK` reproduces a specific run, and the
block actually used is recorded in the artifact.

Each run starts its own fork. Reusing one is cheaper and wrong: every run mints a redemption against
a real agent's finite backing, so a later run would see state an earlier one created. A run whose
result depends on how many times it has been run before is not evidence.

## 10. Limitations

- The Flare half is a fork. Coston2 deployment is Phase 10 and remains blocked on C2FLR.
- The extension ran as an ordinary process. There is no TEE, no attestation and no measured boot.
  The code hash the registry approves is `keccak256` of the built binary, which binds the decision to
  a specific build but proves nothing about where it executed.
- XRPL serialization and signing use the `xrpl` library rather than Go. The decision, and therefore
  every field of the payment, is constructed in Go; the library only encodes and signs, and the blob
  is decoded back and compared field by field to catch any change it makes. A Go serializer is a
  hardening item, not a correctness gap.
- The blob round-trip compares `TransactionType`, `Account`, `Destination`, `Amount`, `Fee`,
  `Flags`, `Sequence`, `LastLedgerSequence`, the memo and `SigningPubKey`. `Flags` is on that list
  because FR-031 is about it: the deciders pin it to 0 so partial payment can never be set, and a
  library that defaulted it would otherwise slip through. `NetworkID`, `DestinationTag` and
  `TicketSequence` are absent from this transaction entirely, because the network id is below the
  threshold that requires the field and this obligation used neither a tag nor a ticket. Tag mode
  and ticket mode are covered by fixtures, not end to end here.
- Signing happens in the orchestrator process, which stands in for the coordinator, an explicitly
  untrusted component. It holds both the decision and the signing key. The round-trip check proves
  this honest orchestrator signed what it claims to have signed; it does nothing to stop an
  adversarial one, because no code enforces that binding yet.
- The coordinator's Postgres layer is not in this run. Phase 08 proves it separately, and joining
  them is Phase 10 work.
- `pnpm audit` reports two `ws` advisories reaching us through `viem`, which is imported by exactly
  one access-probe script and never by the payment path. A `pnpm` override does not bind because
  `isows` resolves `ws` as a peer. Dependency posture belongs to Phase 13; the vitest advisory found
  at the same time was fixed by bumping to 3.2.6.
