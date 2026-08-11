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
- Signet's extension is registered on live Coston2 with extension id `66163`.
- The Signet registry and instruction sender are deployed on live Coston2.
- A Coston2 FAssets redemption obligation was created through the ordinary minter path and read back
  through `redemptionRequestInfoExt`.
- An FDC attestation of a Signet payment was verified on chain by `FdcVerification`.
- Payment fields are derived from the FAssets obligation and cannot be supplied by the caller.
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
| "exactly once" | never say this unqualified. Signet enforces at-most-once by itself; an independent racer is not excluded |

## Prohibited

- **Any claim that Signet settled, completed or fulfilled a FAssets redemption.** It has not.
- **Any claim that Signet operates, replaces or is an FAssets agent.** Flare declined to approve new
  agents and Signet holds no agent authority.
- **Any claim of hardware attestation, TEE-protected keys, Confidential Space execution, or a
  measured/attested runtime.** There is no TEE in this deployment.
- **Any claim that a TEE machine is registered, or that an on-chain FCC instruction round trip has
  completed.** `getActiveTeeMachines(66163)` returns empty.
- **Any claim of exactly-once payment against an independent actor.**
- **Any presentation of request 44928272 as a successful demonstration.** It is the double-payment
  incident.
- **Any claim that the whitelist is pending, or that own-agent settlement is a next step awaiting
  access.** It is closed by organizer decision.
- **Any claim that the production exclusive-signing-authority model has been demonstrated.** It is
  architecture, and it is unproven here.
- Mainnet, production-readiness, audited, or user claims of any kind. Test wallets are not users.
