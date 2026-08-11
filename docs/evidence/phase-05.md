# Phase 05 — FDC seam

Result: **PARTIAL.** Request construction and response verification are proven against a real
payment. Submission, proof retrieval and on-chain verification are blocked on C2FLR.
Date: 2026-08-11
Branch: `build/signet-autonomous`

## 1. Objective

Construct the current FDC request for the validated test payment, obtain a proof, and verify it
locally and on Coston2. The stop boundary is that no full lifecycle may be attempted until proof
construction is stable.

## 2. What was proven

Detail in `docs/protocol-seams/fdc.md`.

The FDC testnet verifier was given the XRPL payment validated in Phase 04
(`7500DA52CAB254DBD1B64BC88975B2D01C4DFDF309A6C78398C57142493759AF`) and returned `status: VALID`
with an ABI-encoded attestation request whose message integrity code commits to the expected
response.

Ten cross-checks then compared FDC's view of that payment against every rule
`RedemptionConfirmationsFacet` applies when confirming a redemption, read from pinned source. All
ten pass: the source address hash matches the bound account, the intended receiving address hash
matches the destination, the memo is exactly the FAssets payment reference for the real Coston2
obligation 44851498, the received amount meets the protocol floor and equals it exactly, the spent
amount is the payment plus its fee and nothing else, and no destination tag is present on a
memo-mode obligation.

The data-level chain is therefore closed:

```text
Coston2 obligation 44851498 -> payment reference 0x4642505266410002…02ac612a
  -> XRPL payment 7500DA52…, memo carries that reference
    -> FDC reports that memo, source, destination and amount
```

There is no credential gate: the testnet verifiers use the API key published in Flare's own
walkthrough.

## 3. What is blocked

`FdcHub.requestAttestation(bytes)` is payable. Without it there is no voting round, no Merkle proof,
and nothing to pass to `FdcVerification.verifyXRPPayment` or to `confirmXRPRedemptionPayment`.

| Required by the phase | State |
|---|---|
| request bytes | done |
| voting round | blocked |
| Merkle proof | blocked |
| verification transaction | blocked |
| wrong memo, wrong tag, wrong amount, wrong proof owner, proof replay, nonexistence fixture | blocked: every one needs a proof to mutate |

## 4. Completion gate

**Not met.** The gate is "real testXRP payment proof accepted by current FDC verifier", which
requires a proof. Everything up to the proof is proven; the proof itself needs gas.

The stop boundary is respected: no full lifecycle has been attempted.

## 5. Limitations

- Read-only. No attestation request submitted, no proof obtained, nothing verified on chain.
- The cross-checks compare FDC's response against FAssets rules read from source. That is strong
  evidence that a proof would be accepted, and it is not the same as FAssets accepting one.
- The obligation whose payment reference this payment carries belongs to a third-party agent.
- The nonexistence path, which is what authorizes a replacement after a genuine expiry, is
  selector-verified but unexercised.
