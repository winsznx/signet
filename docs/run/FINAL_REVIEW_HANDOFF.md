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
| local | the Flare chain the lifecycle runs on. A fork, because Coston2 deployment needs C2FLR |
| local | the extension's execution environment. A process. **No TEE, no attestation, nothing hardware-backed, and nothing claims otherwise.** |

## Phase status

| phase | status |
|---|---|
| 00 Foundations and access probe | PASS |
| 01 Reference model | PASS |
| 02 Protocol seams | PASS |
| 03 FCC extension scaffold | PARTIAL, deployment half needs C2FLR |
| 04 XRPL seam | PASS |
| 05 FDC seam | PARTIAL, on-chain half needs C2FLR |
| 06 Signet contracts | PASS |
| 07 Go extension | PARTIAL, deployment half needs C2FLR |
| 08 Durable coordinator | PARTIAL, durability proven; observer loops need deployed contracts |
| 09 Composed lifecycle | PASS, 59/59 |
| 10 Target-chain lifecycle | **DEFERRED**, every step needs C2FLR |
| 11 Independent verifier | PASS |
| 12 Operator and proof UI | PASS, not deployed |
| 13 Hardening | PASS, one high risk open and accepted |

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
5. **design.md's Fog fails contrast on Paper** at 4.40:1. Section notes use Steel instead, and the
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

## Blocked on external input

Everything below was attempted through the documented self-service route and failed there. Details,
including what was tried and when, are in the request at the end of the run log.

1. **C2FLR for `0x88f61BcDC3C0Cfe4E12dc0576960bcF3ECa88F7d` on Coston2.** Balance is zero. The
   faucet is captcha-gated and exposes no API on any documented path. This blocks Phase 10 entirely
   and the deployment halves of 03, 05 and 07.
2. **An FAssets agent whitelist entry.** `AgentOwnerRegistry` is governance-gated, `manager()` is the
   zero address and `productionMode()` is true, so it cannot be self-served.
3. **Cloudflare credentials.** Phase 12 builds and checks but is not deployed.

## What I would not sign off on

- Any claim that this is TEE-attested. It is not, anywhere.
- Any claim that a FAssets redemption has been settled. None has.
- Any claim that the coordinator cannot obtain an arbitrary signature. It can.
