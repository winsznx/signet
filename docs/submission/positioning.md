# Why Signet is not a generic policy signer

**FAssets decides what is owed. Signet decides whether that exact XRP payment may exist. FDC proves
what happened.**

```text
requestId
  → canonical FAssets obligation
    → Signet/FCC authorization
      → XRPL observation
        → exact XRP payment
          → FDC proof
```

---

## The difference, in two flows

**A generic policy signer:**

```text
operator defines recipient, budget, allowlist
  → TEE evaluates the operator's own policy
    → transaction signs
```

The operator authors the policy. The TEE enforces what the operator wrote. If the operator is
compromised, or wrong, the policy is compromised or wrong with it, and the signature is still valid.

**Signet:**

```text
FAssets creates an external-chain obligation
  → caller supplies only a requestId
    → protocol state determines destination, amount, reference, tag and payment window
      → FCC can authorize only that payment
        → XRPL state is checked for a prior payment
          → FDC proves the outcome back to Flare
```

Nobody authors the policy. The obligation *is* the policy, and it is written by FAssets.

The deployed entry point is the shortest possible statement of this:

```solidity
function authorizeRedemption(uint256 requestId, uint32 generation) external payable returns (bytes32)
```

There is no destination parameter, no amount, no reference, no window, no tag. Not because they are
validated, because **they do not exist**. That is structural rather than statistical: no
misconfiguration can widen it, because there is nothing to configure.

## The removal test

The clearest way to see whether a component is load-bearing is to take it away.

| remove | what breaks |
|---|---|
| **FAssets** | there is no authoritative obligation. Nothing external says what is owed, to whom, by when. Signet would be reduced to enforcing a policy someone typed, which is the generic signer above |
| **FCC** | a compromised host can sign arbitrary XRP. The constraint stops being enforced anywhere the operator cannot reach |
| **XRPL observation** | a payment already made by another party is invisible. This is not hypothetical: it is exactly [incident 44928272](../evidence/incident-44928272.md) |
| **FDC** | completion cannot be independently established on Flare. The operator's word becomes the evidence |

Four components, four distinct failures, none of them substitutable. A product that survives removing
any one of them was not really composing with it.

---

## Who this is for

**Primary initial user: independent or institutional FAssets agent operators who retain control of an
underlying redemption account.**

**The job:** fulfil redemption obligations without leaving an unrestricted XRPL spending key
available to a compromised operator host.

| | |
|---|---|
| **before Signet** | a hot signer can authorize arbitrary XRP. The thing that decides what to pay and the thing that holds the key are the same process, so an operator mistake or a compromised coordinator is a wrong payment |
| **with Signet** | a `requestId` goes in, and a protocol-derived obligation comes out as the only admissible payment |

This is an operator security primitive. It is not a portal, and the dashboard is not the product: the
operator page exists to show what the mechanism did, not to be the thing anyone buys.

## What it is honestly not, yet

- **Not attested.** The extension runs as a local process. No TEE machine is registered and nothing
  is hardware-backed. Five separate FCC statuses are tracked in the claim ledger precisely so this
  cannot be blurred: extension registered, machine registered, machine in production, simulated
  execution, hardware attestation.
- **Not an agent.** Signet holds no FAssets agent authority and has never settled a redemption.
- **Not exactly-once against an independent racer.** At-most-once by itself, with the observe-to-
  validate window stated openly.

The production claim, which is architecture and is **not demonstrated**: when Signet is installed as
the exclusive legitimate signing authority for an agent-controlled underlying account, the same
mechanism enforces the agent-side payment boundary.
