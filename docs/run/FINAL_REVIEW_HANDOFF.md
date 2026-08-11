# Final review handoff

Branch: `build/signet-autonomous`
Run status: `ready_for_review`
Date: 2026-08-11

Phases 00 through 13 have run. Phase 14 submission and Phase 15 production expansion were out of
scope for this run and were not executed.

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

Thirteen threats are closed with a stated mechanism and a proof for each. **One is not.** A
coordinator that reports a genuine, active FAssets obligation while naming a destination of its own
choosing receives a real signature over a real transaction paying that destination. `decide()` trusts
the redemption snapshot it is handed, and the obligation hash covers only the obligation's identity,
so nothing catches the substitution before signing.

PRD section 22.3 lists "coordinator cannot obtain arbitrary signature" as the mitigation for exactly
this adversary. **It is not implemented.** What exists is attributability, and it works: the
authorization commitment covers every payment field, phase 11's verifier recomputes it from public
data, and the corruption tests prove a moved destination is caught. That is detection after a
signature exists, not prevention.

If you read one thing and disagree with one thing, let it be this.

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
| 10 Target-chain lifecycle | PARTIAL, Signet's leg verified on chain; settlement needs the whitelist |
| 11 Independent verifier | PASS |
| 12 Operator and proof UI | PASS, deployed |
| 13 Hardening | PASS, one high risk open and accepted |

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

[ADR 0003](../adr/0003-underlying-payment-precheck.md) has the analysis and proposes the fix: a new
decision input carrying validated underlying payments the signing boundary observed, plus a reason
code. It is proposed and not done, because changing the decision inputs changes the canonical
encoding and invalidates the 62 frozen fixtures, and that is a protocol version bump rather than
something to do unreviewed at the end of a run. The operational mitigation is implemented one layer
out and, replayed against the incident, refuses to sign.

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
| Coston2 redemption | request 44928272 |
| proof page | https://signet-proof.pages.dev/ |

## Blocked on external input

One thing, and it is genuinely governance-gated.

**An FAssets agent whitelist entry.** `AgentOwnerRegistry` at
`0x94e33f519e256149752711245eab2e1abb8c34a4` gates `whitelistAndDescribeAgent` behind
`onlyGovernanceOrManager`, `productionMode()` is `true`, and Flare's own documentation says agents
are whitelisted through governance and cannot be registered for a test or a demo. There is no fee,
no form and no permissionless fallback.

[`docs/requests/fassets-agent-whitelist.md`](../requests/fassets-agent-whitelist.md) has the verified
gate state and a ready-to-send message with the exact address and agent details Flare needs.

Cloudflare needed no new credentials: the existing local Wrangler OAuth login already carried
`pages (write)`, which was confirmed by listing projects before anything was created.

## What I would not sign off on

- Any claim that this is TEE-attested. It is not, anywhere.
- Any claim that Signet has settled a FAssets redemption. One redemption it participated in did
  complete, but the agent's payment settled it and Signet's was a duplicate.
- Any claim that the coordinator cannot obtain an arbitrary signature. It can.
