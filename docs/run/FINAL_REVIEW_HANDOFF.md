# Final review handoff

Branch: `build/signet-autonomous`
Run status: `ready_for_submission`
Date: 2026-08-11, revised 2026-08-14 after gate B and phase 14

Phases 00 through 14 have run. Phase 15 production expansion is out of scope and was not executed.

Two things changed after this file was first written, and both are load-bearing:

1. **Gate B** closed the arbitrary-signature gap that the first version of this file led with, and is
   deployed on Coston2 as extension `66244`. The section below is rewritten accordingly.
2. **GCP Confidential Space was downgraded** from a submission blocker to a stretch. It is not
   attempted here and no hardware-attestation claim is made anywhere. The checklist for doing it
   later is [`docs/run/GATE_A_STRETCH.md`](GATE_A_STRETCH.md).

## Start here

```bash
pnpm install --frozen-lockfile
bash scripts/install-go.sh
make verify
```

That is the whole setup. It was run from a clean clone of this branch and passes.

Then check a claim yourself, which is the part that matters:

```bash
pnpm --filter @signet/verifier verify:receipt <transaction hash from evidence/receipts/>
```

`UNVERIFIABLE` exits 3. It is not a pass, and it is used deliberately.

## The single most important thing to read

[`docs/threat-model.md`](../threat-model.md).

Eighteen threats are closed with a stated mechanism and a proof for each. The one that was open when
this file was first written, a coordinator obtaining a signature for a destination it chose, is now
closed by gate B and the closure is structural.

`SignetFccInstructionSender.authorizeRedemption(uint256 requestId, uint32 generation)` takes a
request id and a generation. It resolves the obligation through
`FAssetsAdapter.readCanonicalRedemptionById`, which reads the agent from the request rather than
accepting one, refuses anything FAssets does not report `ACTIVE`, checks the binding and the registry
action, and ABI-encodes the canonical instruction itself. **There is no parameter through which a
caller could express a payment field.** A caller-authored obligation now fails to decode on the FCC
path, and the FCC test asserts it fails as a decode error rather than a policy refusal. The
standalone `cmd/signet-extension` CLI still accepts one from stdin and reaches no key; it is open
finding 3 in the threat model.

Live on Coston2 as sender
[`0x3FFA63a3bf21a626c1B391D2577b1800e67F5Be0`](https://coston2.testnet.flarescan.com/address/0x3FFA63a3bf21a626c1B391D2577b1800e67F5Be0),
extension id `66244`. Check it yourself:

```bash
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeExtensionInstructionsSender(uint256)(address)" 66244 \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc
```

**What this does not buy.** The extension still runs as a local process with no attestation, so an
operator with host access can bypass the contract path by running its own binary against its own key.
Gate B removes the protocol-level path to an arbitrary signature. It does not create isolation
between the decider and the host. That is what a real TEE would buy and this deliverable does not
have one.

If you read one thing and disagree with one thing, let it be the paragraph directly above.

## What is real

| | |
|---|---|
| real | FAssets code producing obligations: deployed Coston2 bytecode, on a fork |
| real | XRPL Testnet payments: signed, persisted before submission, validated, reconciled across independent endpoints, refused on replay by the ledger |
| real | FDC XRPPayment attestation requests, answered `VALID` by the testnet verifier |
| real | 12 fork tests against live Coston2 at pinned blocks |
| real | the Signet contracts, deployed on Coston2 and exercised through their real entry points |
| real | a Coston2 FAssets redemption we created as a minter, and a full minting cycle to get there |
| real | FDC end to end: request paid to FdcHub, round finalized, Merkle proof, `verifyXRPPayment` accepted on chain |
| real | the gate B instruction sender, deployed and registered on the live Coston2 `FlareTeeManager` as extension `66244` |
| local | the extension's execution environment. A process. **No TEE, no attestation, nothing hardware-backed, and nothing claims otherwise.** |

## Phase status

| phase | status |
|---|---|
| 00 Foundations and access probe | PASS |
| 01 Reference model | PASS |
| 02 Protocol seams | PASS |
| 03 FCC extension scaffold | PASS |
| 04 XRPL seam | PASS |
| 05 FDC seam | PASS, proof accepted on chain |
| 06 Signet contracts | PASS |
| 07 Go extension | PASS |
| 08 Durable coordinator | PARTIAL, durability proven; observer loops need deployed contracts |
| 09 Composed lifecycle | PASS, 59/59 |
| 10 Target-chain lifecycle | PARTIAL, Signet's leg verified on chain; own-agent settlement out of scope by organizer guidance, not pending |
| 11 Independent verifier | PASS |
| 12 Operator and proof UI | PASS, deployed |
| 13 Hardening | PASS, the high risk it recorded is now closed by gate B |
| gate B Canonical requestId-only derivation | PASS, deployed on Coston2 as extension `66244` |
| 14 Submission | PASS, package assembled; nothing submitted externally |

## The most important thing this run found

**Signet double-paid a live Coston2 redemption.**

On request 44928272 the assigned agent paid from its own underlying address at XRPL ledger 19825006.
Signet paid the same obligation again at ledger 19825042, 36 ledgers later. Coston2 reported the
request as `ACTIVE` the whole time.

Signet's status check was correct at the moment it ran. `ACTIVE` does not mean unpaid: it means not
yet confirmed on Flare, and confirmation is a separate transaction the agent submits after its
payment validates and after it obtains an FDC proof. Every one of Signet's three duplicate-payment
guards watches the wrong chain for this. The registry action state, the coordinator's unique indexes
and the ledger's sequence consumption all stop Signet paying twice; none can see a payment made by
somebody else.

No third party lost funds, which is luck about the test setup rather than a property of the system.

**This has since been corrected.** [ADR 0003](../adr/0003-underlying-payment-precheck.md) was
accepted and implemented as schema V2. See the section below.

## Schema V2, the correction

The duplicate payment above is fixed at the protocol layer, not worked around.

| | |
|---|---|
| what changed | the decision requires the signing boundary's own XRP ledger observation |
| reason codes | `S021_PAYMENT_ALREADY_OBSERVED`, `S022_UNDERLYING_STATE_UNAVAILABLE`, `S023_UNDERLYING_STATE_DISAGREEMENT`, `S024_UNDERLYING_OBSERVATION_STALE` |
| encoding | authorization preimage 431 → 468 bytes, binding the observed ledger, the source count and a root over what was found |
| obligation encoding | deliberately unchanged, so the deployed Coston2 contract still agrees |
| V1 | refused with `S001_UNKNOWN_SCHEMA`; its 62 fixtures preserved byte-for-byte |
| regression | `scripts/lifecycle/incident-44928272.test.mjs`, which asserts no V2 input reproduces the original authorization |
| what is actually guaranteed | **[`docs/guarantee.md`](../guarantee.md), read this** |

Two independent audits ran against V2 and found five real defects, all now fixed:

1. **Go signed a payment the reference model refused.** A malformed observation hash was silently
   becoming 32 zero bytes in Go while TypeScript threw and refused `S020`. Reproduced on identical
   stdin bytes. Fixed, with a conformance fixture.
2. **Go and TypeScript computed different commitments** for the same authorized decision when two
   observed payments shared a transaction hash: Go's sort is not stable and JavaScript's is. Both
   now use a total order, with two fixtures asserting the root does not depend on input order.
3. **The verifier did not actually check the observation against the ledger.** It recomputed the
   commitment from the receipt's own numbers, which catches arithmetic and nothing else. It now
   re-observes the ledger itself and fails a receipt whose observation does not match.
   `docs/guarantee.md` claimed this before it was true; that is corrected in place and marked.
4. **The observer silently truncated at 400 results**, ignoring `account_tx` pagination. It now
   follows the marker and reports unavailable rather than a partial answer.
5. **This file's own phase table has been empty since phase 02.** A status edit removed the contents
   of `docs/run/AUTONOMOUS_RUN.md` and every later "record status in the run ledger" wrote a string
   replacement into an empty file and silently succeeded. Nothing checked, the deployed operator page
   showed an empty table for the entire run, and an evidence audit is what caught it. Restored, and
   `web/test/check.mjs` now fails the build if the table is empty.

## Things reviews caught, and what happened

These are here because a handoff that lists only successes is not a handoff.

1. **The composed lifecycle fabricated the FAssets payment window.** It replaced
   `firstUnderlyingBlock` and `lastUnderlyingBlock` with values from the live XRP ledger while a
   comment claimed it used them verbatim, so the deadline and safety-margin checks were running
   against a window the harness invented. Fixed, and seven guards now assert field by field that
   every obligation value reaching the decision is the one FAssets emitted.
2. **The two deciders diverged on malformed input.** Go rejected unknown fields at any depth; the
   reference parser checked only the top level. An input Go refused was accepted and decided by
   TypeScript, and no fixture could have caught it because every fixture is well formed. Both now
   reject identically, with three cases in the lifecycle holding them to it.
3. **Reconciliation accepted absence from an endpoint never asked.** Found in phase 04. Every
   endpoint is now asked, and only a "not found" answerer whose history covers the whole span may
   testify to absence.
4. **The verifier flagged an earlier receipt.** The phase 04 payment did not go where FAssets said.
   True: it borrowed a real obligation's reference to exercise the XRPL path. The claim ledger
   already recorded that; the receipt did not. Seam receipts now carry `settles: false`, and silence
   means a receipt claims settlement.
5. **The verifier caught the receipt describing a payment that was never made.** A resumed
   target-chain run recomputed its decision instead of reading the one it had checkpointed, so the
   receipt recorded a template with a fresh account sequence while naming the transaction hash of
   the payment actually signed. Only an independent check noticed. The run now checkpoints the
   decision with the payment.
6. **The deploy script tried to approve governance as a result signer** and the contract rejected it
   with `SignerIsGovernance`. The contract was right.
7. **design.md's Fog fails contrast on Paper** at 4.40:1. Section notes use Steel instead, and the
   failing ratio is asserted as a known fact so a future edit cannot quietly undo it.

## Where to look

| | |
|---|---|
| every public claim, with limitations | `evidence/claim-ledger.json` |
| the composed lifecycle | `scripts/lifecycle/run.mjs`, `docs/evidence/phase-09.md` |
| the verifier | `verifier/`, `docs/evidence-schema.md` |
| threats and accepted risks | `docs/threat-model.md` |
| recovery procedures | `docs/runbooks/recovery.md` |
| per-phase evidence | `docs/evidence/phase-NN.md` |
| the proof pages | `make web`, then open `web/dist/index.html` |

## Deployed and live

| | |
|---|---|
| SignetRegistry | [`0x381bdE5961695914B28B16f405d51E8acB877f6e`](https://coston2.testnet.flarescan.com/address/0x381bdE5961695914B28B16f405d51E8acB877f6e) |
| SignetInstructionSender | [`0xd6cF30B6411DB8465147FfDcF0e0418030B4b9CA`](https://coston2.testnet.flarescan.com/address/0xd6cF30B6411DB8465147FfDcF0e0418030B4b9CA) |
| SignetFccInstructionSender (gate B) | [`0x3FFA63a3bf21a626c1B391D2577b1800e67F5Be0`](https://coston2.testnet.flarescan.com/address/0x3FFA63a3bf21a626c1B391D2577b1800e67F5Be0), extension `66244` |
| Coston2 redemption | request 44928272 |
| proof page | https://signet-proof.pages.dev/ |

## No open external blockers

The whitelist request was answered. Flare declined to approve new agents and directed Signet to test
the execution layer instead, which is now the acceptance boundary:
[`docs/evidence/organizer-accepted-proof-boundary.md`](../evidence/organizer-accepted-proof-boundary.md).

Own-agent settlement is out of scope by that guidance, not pending access. Cloudflare needed no new
credentials.

## The FCC gap, found by the organizer and closed

Quantic asked for the payment to be derived "inside FCC". It was not. The decision ran as a CLI
reading stdin, which is not FCC in the sense the protocol means, and no amount of the surrounding
work made up for it.

| | |
|---|---|
| `extension/cmd/signet-fcc-extension` | implements the pinned scaffold's extension contract |
| op-type | `SIGNET_REDEMPTION`, commands `AUTHORIZE_REDEMPTION` and `HEALTH_CHECK` |
| no wildcard | asserted by test: a wildcard is the shape of an arbitrary signing endpoint |
| extension id | **66244**, registered on the live Coston2 `FlareTeeManager` |
| instruction sender | `0x3FFA63a3bf21a626c1B391D2577b1800e67F5Be0` |
| TEE machine | **none.** `getActiveTeeMachines(66244)` returns empty |
| attestation | **none.** The extension runs as a local process; FTDC rejects simulated attestation |
| positive path | takes the payment it signs **from the FCC ActionResult**, not from the CLI |
| superseded | `66163` and `66164`, both retired and recorded with reasons in `deployments/coston2.json`. Neither ever carried a live TEE machine, so no instruction was ever executed through either |

## Claims

Public copy is governed by [`docs/submission-claims.md`](../submission-claims.md), which separates
safe claims, claims that are safe only with a qualifier attached, and prohibited ones.

The hackathon claim:

> Given a valid FAssets redemption obligation, Signet derives the exact required XRP payment through
> its FCC policy path and will authorize no altered, expired, replayed, stale, already-observed or
> independently-disagreed payment. An authorized transaction is executed on XRPL Testnet and
> independently provable through FDC on Coston2. This hackathon deployment demonstrates the execution
> layer; it does not claim to operate or replace a whitelisted FAssets agent.

The production claim, which is **architecture and not demonstrated**:

> When Signet is installed as the exclusive legitimate signing authority for an agent-controlled
> underlying account, the same mechanism can enforce the agent-side payment boundary.

## What I would not sign off on

- Any claim that this is TEE-attested. It is not, anywhere.
- Any claim that Signet has settled a FAssets redemption. One redemption it participated in did
  complete, but the agent's payment settled it and Signet's was a duplicate.
- Any claim of exactly-once payment against an independent racer. Signet enforces at-most-once by
  itself; the window between observing and validating cannot be closed. `docs/guarantee.md` says so
  in the first paragraph rather than in a footnote.
- Any claim that gate B protects the key from the host. It constrains what the *contract* will
  instruct. A process with host access needs no instruction.
