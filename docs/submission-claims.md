# Submission-safe and prohibited claims

Written so that anyone drafting public copy has one page to check against. Every safe claim below is
backed by an entry in `evidence/claim-ledger.json`; every prohibited one is prohibited because it is
either false or unproven.

## Safe

- Given a valid FAssets redemption obligation, Signet derives the exact required XRP payment through
  its FCC policy path.
- Signet will authorize no altered, expired, replayed, stale, already-observed or
  independently-disagreed payment.
- An authorized transaction is executed on XRPL Testnet and independently provable through FDC on
  Coston2.
- Signet's extension is registered on live Coston2 with extension id `66244`.
- The only payment-bearing entry point on the deployed FCC instruction sender is
  `authorizeRedemption(uint256 requestId, uint32 generation)`. It exposes no parameter through which
  a caller could supply a payment field, and every field is read from FAssets by the contract.
- The Signet registry and instruction sender are deployed on live Coston2.
- A Coston2 FAssets redemption obligation was created through the ordinary minter path and read back
  through `redemptionRequestInfoExt`.
- An FDC attestation of a Signet payment was verified on chain by `FdcVerification`.
- An independent verifier, run from a fresh clone with no credentials, recomputes the authorization
  commitment and re-observes the XRP ledger.
- Signet found a real duplicate-payment defect in its own design, corrected it at the protocol layer
  in schema V2, and keeps the incident as a permanent regression test.

## Safe only with the qualifier attached

| Claim | Required qualifier |
|---|---|
| "derived inside FCC" | the extension ran as a local process; no TEE machine is registered and nothing is hardware-attested |
| "at most one payment per obligation" | for an obligation whose only legitimate payment authority is Signet, which this deployment does not instantiate |
| "the positive path uses a real FAssets obligation" | created on a Coston2 fork running deployed FAssets bytecode and state; the live Coston2 obligation is the incident, not the demo |
| "payment fields come from the FAssets obligation" | true as of gate B, at the protocol layer: the contract resolves every field from FAssets and the caller supplies only a request id and a generation. The qualifier is about *scope*, not truth: this constrains what the contract will instruct, and does not stop an operator with host access from running its own binary against its own key. Say "no caller-supplied payment fields", never "the key cannot be misused" |
| "exactly once" | never say this unqualified. Signet enforces at-most-once by itself; an independent racer is not excluded |

## Prohibited

- **Any claim that Signet settled, completed or fulfilled a FAssets redemption.** It has not.
- **Any claim that Signet operates, replaces or is an FAssets agent.** Flare declined to approve new
  agents and Signet holds no agent authority.
- **Any claim of hardware attestation, TEE-protected keys, Confidential Space execution, or a
  measured/attested runtime.** There is no TEE in this deployment.
- **Any claim that a TEE machine is registered, or that an on-chain FCC instruction round trip has
  completed.** `getActiveTeeMachines(66244)` returns empty.
- **Any claim of exactly-once payment against an independent actor.**
- **Any presentation of request 44928272 as a successful demonstration.** It is the double-payment
  incident.
- **Any claim that the whitelist is pending, or that own-agent settlement is a next step awaiting
  access.** It is closed by organizer decision.
- **Any claim that the production exclusive-signing-authority model has been demonstrated.** It is
  architecture, and it is unproven here.
- **Any claim that gate B protects the signing key from the host.** It constrains what the contract
  will instruct. A process with host access needs no instruction, and the extension has no
  attestation. Gate B closes a protocol path, not an isolation gap.
- Mainnet, production-readiness, audited, or user claims of any kind. Test wallets are not users.
