# The organizer-accepted proof boundary

Date: 2026-08-11
Status: this is the final acceptance boundary for the hackathon deliverable.

## What the Flare team said

Signet had an open request for an FAssets agent whitelist entry on Coston2
([`docs/requests/fassets-agent-whitelist.md`](../requests/fassets-agent-whitelist.md)). The answer
closed it.

**Kristaps Grinbergs:**

> We don't approve any new agents. Please find a workaround or slightly change the idea.

**Quantic, giving explicit guidance for Signet:**

> operating an FAssets agent isn't really part of the developer onboarding flow or something builders
> are generally expected to spin up for application testing. Agents are protocol operators with their
> own collateral and operational requirements.
>
> For Signet, I'd focus the test on the execution layer itself: taking a valid redemption obligation,
> deriving the required XRPL payment inside FCC, signing/executing it, and proving the resulting
> payment back through FDC

## The scope decision

The whitelist is no longer an unresolved blocker. It is a closed door, and the organizers have said
which door to use instead.

**Signet is not pivoting.** The product is unchanged: an attested external execution layer for
FAssets agents, whose whole point is that payment fields come from a FAssets obligation and nowhere
else. What changes is the acceptance boundary. The deliverable is the execution layer, tested exactly
as specified, and it stops short of settling a redemption on an agent Signet does not control.

Three things follow, and they are constraints rather than preferences:

- **No attempt to bypass `AgentOwnerRegistry` governance.** The gate is governance's to open.
- **No new live redemption created to race an existing agent.** Signet did that once by accident and
  it produced a duplicate payment (see below). Doing it deliberately to manufacture an apparent
  settlement would be worse: it would be paying an obligation somebody else is responsible for, in
  order to take a screenshot.
- **No claim that Signet completed an assigned agent's settlement.** It has not, and cannot without
  that agent's underlying signing authority.

## The four organizer-specified steps, and the evidence for each

Classification is exact. "Live Coston2" and "Coston2 fork" are different words on purpose.

### 1. Taking a valid FAssets redemption obligation

| | |
|---|---|
| **Strongest evidence** | Coston2 redemption request **44928272**, created by us acting as a *minter*, which is not gated |
| **Classification** | **live Coston2** |
| Reference | `docs/evidence/phase-10.md`, `.runtime/fassets-mint.json`, tx `0x402837d46283117df24e70d6669a04d2c12a336eb1b06065c4785357991a53ee` |
| Also | request **44993990** on a **Coston2 fork using deployed FAssets bytecode and state**, used as the clean positive path |

The full minter path ran on the live chain: `reserveCollateral` → pay the agent in underlying XRP →
FDC `Payment` attestation verified on chain → `executeMinting` → `redeem`. That produced a genuine
obligation assigned to a real agent, readable by anyone through `redemptionRequestInfoExt`.

**44928272 is not used as the successful demonstration.** It is the live double-payment incident, and
it stays that way: see the bottom of this document.

### 2. Deriving the required XRPL payment inside FCC

| | |
|---|---|
| **Extension registration** | **live Coston2** — extension id `66163` on the real `FlareTeeManager` |
| **Extension execution** | **simulated FCC** — the extension ran as a local process, not in a Confidential Space VM |
| **TEE machine** | **not registered.** `getActiveTeeMachines(66163)` returns `[]` |

This is the part that was genuinely missing until now, and the organizer named it precisely. Before
this work Signet's decision ran as a CLI reading stdin, which is not FCC in any sense the protocol
means. What exists now:

- `extension/cmd/signet-fcc-extension` implements the pinned scaffold's extension contract: `POST
  /action`, `GET /state`, 200-with-ActionResult even on handler failure, 501 for an unregistered
  op-type or command, 400 for a malformed body.
- It registers one op-type, `SIGNET_REDEMPTION`, with `AUTHORIZE_REDEMPTION` and `HEALTH_CHECK`.
  There is no `SIGN_ARBITRARY` and **no wildcard handler**, which the tests assert: a wildcard under
  Signet's op-type accepts any command name and is the shape of an arbitrary signing endpoint even
  when nobody uses it.
- The decision it runs is `policy.Decide`, the same function the 76 frozen fixtures hold to. One
  decision, two transports; the composed lifecycle asserts the FCC and CLI answers match.
- The composed lifecycle now **takes the payment it signs from the FCC ActionResult**, not from the
  CLI. "Derived inside FCC" is a statement about what happened in that run.

### 3. Signing and executing that exact payment

| | |
|---|---|
| **Strongest evidence** | XRPL Testnet tx `A2E16620E86423A4E835B8AB6E9BF43C6B81123E977F5BD42F6EEDD2495C605C`, validated in ledger 19831523 |
| **Classification** | **live XRPL Testnet** |

Signed by a rotatable RegularKey, persisted before first submission, decoded back and compared field
by field against the authorized payment, reconciled across independent endpoints, and refused by the
ledger on replay with `tefPAST_SEQ`.

### 4. Proving the resulting payment back through FDC

| | |
|---|---|
| **Strongest evidence** | attestation request paid to `FdcHub`, voting round **1422868** finalized, Merkle proof retrieved, `FdcVerification.verifyXRPPayment` returned `true` |
| **Classification** | **live Coston2 FDC** |

A proof fetched from a DA Layer API is a claim by that API. A proof `verifyXRPPayment` accepts on
chain has been checked against the Merkle root Flare's validators signed.

## The linkage

The organizer asked for the execution layer, not four demonstrations that happen to sit in the same
repository. One obligation runs through all four steps:

```text
FAssets obligation      request 44993990, from deployed FAssets bytecode on a Coston2 fork
  obligation hash       0xfd65cd5399536f6d2dcd778b585a07fcf61e7e953fc71bc7b5bbe5bd688000e5
        │               agreed by the deployed contract, Go and TypeScript
        ▼
FCC decision            op-type SIGNET_REDEMPTION, command AUTHORIZE_REDEMPTION
                        ActionResult status 1, log "ok", extension version 0.1.0
  commitment            0x0071fedda296f6fea206ab8a530fc2e314d4d8f93893fd34683cc2f59044814c
        │               binds every payment field and the underlying observation
        ▼
XRPL execution          A2E16620E86423A4E835B8AB6E9BF43C6B81123E977F5BD42F6EEDD2495C605C
                        validated ledger 19831523, replay refused tefPAST_SEQ
        │
        ▼
FDC proof               voting round 1422868, verifyXRPPayment -> true on Coston2
```

Receipt: `evidence/receipts/lifecycle-A2E16620E86423A4E835B8AB6E9BF43C6B81123E977F5BD42F6EEDD2495C605C.json`.
The independent verifier recomputes the commitment and re-observes the ledger from a fresh clone with
no credentials.

## What is live and what is not, in one table

| Component | Classification |
|---|---|
| FAssets obligation 44928272, minting cycle, `redeem` | live Coston2 |
| FAssets obligation 44993990 (positive path) | Coston2 fork, deployed FAssets bytecode and state |
| `SignetRegistry`, `SignetInstructionSender` | live Coston2 |
| FCC extension registration, id 66163, instruction sender | live Coston2 |
| FCC extension execution | **simulated FCC**: local process, no attestation |
| FCC TEE machine registration, on-chain instruction round trip | **absent** |
| XRPL payment, signing, submission, reconciliation, replay refusal | live XRPL Testnet |
| FDC attestation request, round finalization, on-chain verification | live Coston2 FDC |
| Decision policy, 76 fixtures, property tests, incident replay | deterministic local, network-free |
| Coordinator durability | local PostgreSQL |

## Why own-agent settlement is not part of the final proof

Because the organizers said not to, and because the alternative is worse.

FAssets settles a redemption only on a payment from the agent's own underlying address. Signet would
have to be that agent, and agent registration is governance-gated with the answer already given. The
only ways to produce an apparent settlement without that are to bypass governance, or to pay an
obligation assigned to somebody else's agent and hope our payment lands first.

Signet already did the second one once, by accident, and it is preserved as the incident it was.

## What stays, unchanged

- **Request 44928272 remains the live double-payment incident.** The agent paid it from its own
  underlying address at XRPL ledger 19825006; Signet paid it again at 19825042 while Coston2 still
  reported `ACTIVE`.
- **It remains the permanent `S021_PAYMENT_ALREADY_OBSERVED` regression.**
  `scripts/lifecycle/incident-44928272.test.mjs` replays it against both implementations on every
  gate run and asserts that no V2 input reproduces the original authorization.
- **It is not the successful demonstration and must never be presented as one.** The positive path is
  the composed lifecycle above.
