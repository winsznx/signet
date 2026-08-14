# DoraHacks submission package

Status: **assembled, not submitted.** Nothing has been sent externally. This is the copy and the
links, ready for the operator's final review.

Every claim below is governed by [`../submission-claims.md`](../submission-claims.md) and traceable to
[`../../evidence/claim-ledger.json`](../../evidence/claim-ledger.json). If a sentence here cannot be
found in the ledger, it does not go in the form.

---

## Project name

**Signet**

## One-line description

An attested external execution layer for FAssets agents: a FAssets obligation constrains an XRP
signature through Flare Confidential Compute, and FDC proves the payment back on chain.

## Bounty tracks

- Primary: **Confidential Compute Apps**
- Secondary: **Interoperable Asset Products**

## Elevator description

FAssets agents have to make exact XRP payments against redemption obligations. Today the thing that
decides what to pay and the thing that holds the key are the same process, so an operator error or a
compromised coordinator is a wrong payment.

Signet splits them. The payment is derived from the obligation by a contract, inside the FCC policy
path, and the caller supplies nothing but a request identifier. The signing boundary refuses anything
altered, expired, replayed, stale, already observed on the XRP ledger, or disagreed between
independent observers. The executed payment is then proven back to Flare through FDC.

The interesting part is not the happy path. It is that Signet ran against the live chain, **double-paid
a real Coston2 redemption**, and the correction is a protocol change rather than a patch.

---

## Boundary, stated first

This is the part most submissions bury. Putting it at the top is deliberate.

### Real

| | |
|---|---|
| Coston2 FAssets obligation | request **44928272**, created through the ordinary minter path on live Coston2 |
| Coston2 contracts | `SignetRegistry` `0x381bdE5961695914B28B16f405d51E8acB877f6e`, `SignetInstructionSender` `0xd6cF30B6411DB8465147FfDcF0e0418030B4b9CA` |
| FCC extension registration | extension **66244**, sender `0x3FFA63a3bf21a626c1B391D2577b1800e67F5Be0`, on the live `FlareTeeManager` |
| Canonical requestId-only derivation | `authorizeRedemption(uint256,uint32)`, deployed and verifiable on chain |
| XRPL Testnet payment | signed, persisted before submission, validated, reconciled across independent endpoints, refused on replay by the ledger |
| Coston2 FDC verification | request paid to `FdcHub`, round finalized, Merkle proof, `verifyXRPPayment` accepted on chain |

### Simulated, and labelled simulated everywhere

| | |
|---|---|
| the FCC execution environment | the extension ran as a local process, not in a Confidential Space VM |

### Not claimed

- Hardware TEE attestation. There is none, anywhere.
- Whitelisted-agent operation. Flare declined to approve new agents.
- Own-agent FAssets settlement. Out of scope by organizer guidance, not pending access.
- Universal exactly-once payment. Signet enforces at-most-once by itself; an independent racer is
  not excluded.

---

## The claim, exactly as it may be stated

> Given a valid FAssets redemption obligation, Signet derives the exact required XRP payment through
> its FCC policy path and will authorize no altered, expired, replayed, stale, already-observed or
> independently-disagreed payment. An authorized transaction is executed on XRPL Testnet and
> independently provable through FDC on Coston2. This hackathon deployment demonstrates the execution
> layer; it does not claim to operate or replace a whitelisted FAssets agent.

The production claim, which is **architecture and not demonstrated**:

> When Signet is installed as the exclusive legitimate signing authority for an agent-controlled
> underlying account, the same mechanism can enforce the agent-side payment boundary.

---

## Links

| | |
|---|---|
| Proof page | https://signet-proof.pages.dev/ |
| Repository | branch `build/signet-autonomous` |
| Judge path | [`FINAL_REVIEW_HANDOFF.md`](FINAL_REVIEW_HANDOFF.md) |
| Every claim, with limitations | [`evidence/claim-ledger.json`](../../evidence/claim-ledger.json) |
| Evidence graph | [`evidence/evidence-graph.json`](../../evidence/evidence-graph.json) |
| What is guaranteed | [`docs/guarantee.md`](../guarantee.md) |
| Threats, closed and open | [`docs/threat-model.md`](../threat-model.md) |
| Gate B | [`docs/evidence/gate-b.md`](../evidence/gate-b.md) |
| Acceptance boundary | [`docs/evidence/organizer-accepted-proof-boundary.md`](../evidence/organizer-accepted-proof-boundary.md) |

### On-chain

| | |
|---|---|
| SignetRegistry | https://coston2.testnet.flarescan.com/address/0x381bdE5961695914B28B16f405d51E8acB877f6e |
| SignetInstructionSender | https://coston2.testnet.flarescan.com/address/0xd6cF30B6411DB8465147FfDcF0e0418030B4b9CA |
| SignetFccInstructionSender (gate B) | https://coston2.testnet.flarescan.com/address/0x3FFA63a3bf21a626c1B391D2577b1800e67F5Be0 |

---

## Judge path: three commands

```bash
pnpm install --frozen-lockfile
bash scripts/install-go.sh
make verify
```

Then check a claim independently, which is the part that matters:

```bash
pnpm --filter @signet/verifier verify:receipt <transaction hash from evidence/receipts/>
```

`UNVERIFIABLE` exits 3. It is not a pass, and it is used deliberately.

And verify the deployment without trusting this repository at all:

```bash
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeExtensionInstructionsSender(uint256)(address)" 66244 \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc
# 0x3FFA63a3bf21a626c1B391D2577b1800e67F5Be0
```

---

## What is new work, and what is not

**New in this project:**

- The obligation-gated signing policy, its reason codes, and the two independent implementations that
  agree on 76 frozen fixtures.
- Schema V2's underlying-observation requirement, bound into the authorization commitment.
- The canonical requestId-only derivation (gate B) and its contracts.
- The independent verifier, which re-observes the ledger rather than recomputing the receipt's own
  numbers.
- The evidence discipline: claim ledger, evidence graph, and a proof page that cannot show only good
  news.

**Not ours, pinned and unmodified:** FAssets, FDC, the FCC extension scaffold and proxy, the Flare
periphery packages, OpenZeppelin, forge-std. All eleven are content-hashed in
[`docs/source-lock.json`](../source-lock.json) and refetched by `make bootstrap`.

---

## Limitations, stated plainly

1. **No TEE.** The extension ran as a local process. `getActiveTeeMachines(66244)` returns `[]`.
   Nothing is hardware-attested. GCP Confidential Space was a stretch and the billing account did not
   open in time; the checklist is [`GATE_A_STRETCH.md`](GATE_A_STRETCH.md).
2. **The positive path's obligation is on a Coston2 fork** running deployed FAssets bytecode and
   state. The live Coston2 obligation is request 44928272, which is the double-payment incident, not
   the demo.
3. **Signet has never settled a FAssets redemption.** It cannot without an agent's underlying signing
   authority.
4. **Five open defects** are recorded in [`docs/threat-model.md`](../threat-model.md). **Two are high
   severity:** one is unreachable in the deployed configuration and arms itself if a TEE machine is
   ever registered, the other is reachable and fail-closed. They are documented rather than fixed,
   because phase 14 forbids feature work and the contract half is already deployed.
5. **The residual race** between observing the ledger and a payment validating is not closed and
   cannot be.

---

## The incident, which belongs in the submission

On request 44928272 the assigned agent paid from its own underlying address at XRPL ledger 19825006.
Signet paid the same obligation again 36 ledgers later. Coston2 reported the request `ACTIVE`
throughout, because `ACTIVE` means "not yet confirmed on Flare", and confirmation is a separate
transaction the agent submits after its payment validates.

All three of Signet's duplicate-payment guards watched the wrong chain. The registry action state,
the coordinator's unique indexes and the ledger's sequence consumption each stop *Signet* paying
twice. None can see a payment made by somebody else.

No third party lost funds, which is luck about the test setup rather than a property of the system.

It is corrected at the protocol layer as schema V2: the decision now requires the signing boundary's
own XRP ledger observation, bound into the authorization commitment, with reason codes `S021` to
`S024`. `scripts/lifecycle/incident-44928272.test.mjs` asserts no V2 input can reproduce the original
authorization.

That is the strongest thing in this submission, and it is a bug report.
