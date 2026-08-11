# FDC protocol seam

Status: **request construction and response proven; on-chain submission and proof retrieval blocked
on C2FLR.**
Verified: 2026-08-11 against the live testnet FDC verifier and a real XRPL Testnet payment.

## What this seam has to establish

FAssets will only confirm a redemption if an FDC proof says the right payment happened. So the
question is not "can we get a proof" in the abstract, it is: for the payment Signet actually sent,
does FDC report exactly the fields FAssets will check?

That question is answerable without gas, and it is answered.

## Attestation type and source

| Field | Value | Derivation |
|---|---|---|
| `attestationType` | `0x5852505061796d656e7400…00` | UTF-8 `"XRPPayment"`, zero-padded to 32 bytes |
| `sourceId` | `0x746573745852500000…00` | UTF-8 `"testXRP"`, zero-padded to 32 bytes |

`XRPPayment` is attestation id `0x08` in the pinned periphery. It is the XRPL-specific type, and it
is the one that matters: Phase 00 found that FAssets calls
`fdcVerification.verifyXRPPayment`, not the chain-agnostic `verifyPayment`. `XRPPayment` exposes
`firstMemoData`, `destinationTag` and a `proofOwner` request field that the generic type does not.

The testnet verifiers authenticate with the API key `00000000-0000-0000-0000-000000000000`, which is
published in Flare's own walkthrough. There is no credential gate here.

## The request

For the payment validated in Phase 04
(`7500DA52CAB254DBD1B64BC88975B2D01C4DFDF309A6C78398C57142493759AF`), the verifier returned
`status: VALID` and:

```text
abiEncodedRequest
  0x5852505061796d656e74…  attestationType  XRPPayment
    7465737458525000…      sourceId         testXRP
    dc482b4e998d90f2…      messageIntegrityCode
    7500da52cab254db…      transactionId
    00…88f61bcdc3c0cf…     proofOwner
```

The message integrity code is computed by the verifier from the expected response, which is why the
request cannot be constructed offline: it commits to what the answer will be.

## What FDC says about the payment, and why it matters

```json
{
  "blockNumber": "19822204",
  "sourceAddress": "rPvarExLQuuqtkMBfDHp3pNnESZ5HByXta",
  "sourceAddressHash": "0x5e6346bfd7d81593bdf1770b7569162fb25e7dedf71ebb74560ab8076d4d2d7e",
  "intendedReceivingAddressHash": "0x02eca6de356614981c07ee65e70ab8fdbffc669253215268a6687473ae533c44",
  "spentAmount": "1990010",
  "receivedAmount": "1990000",
  "intendedReceivedAmount": "1990000",
  "hasMemoData": true,
  "firstMemoData": "0x4642505266410002000000000000000000000000000000000000000002ac612a",
  "hasDestinationTag": false,
  "status": "0"
}
```

Every field FAssets checks in `RedemptionConfirmationsFacet._confirmRedemptionPayment` and
`._validatePayment` was cross-checked against this response. Ten checks, all passing:

| Check | FAssets rule |
|---|---|
| found in a validated ledger at 19,822,204 | the transaction exists |
| status 0 | not `PAYMENT_FAILED` |
| `sourceAddressHash` matches the bound account | `sourceAddressHash == agent.underlyingAddressHash` |
| `intendedReceivingAddressHash` matches the destination | `== request.redeemerUnderlyingAddressHash` |
| `firstMemoData` is exactly the payment reference | `paymentReference == PaymentReference.redemption(requestId)` |
| `intendedReceivedAmount >= 1990000` | `>= valueUBA - feeUBA` |
| `receivedAmount == 1990000` exactly | Signet's own stricter rule: pay exact, not merely enough |
| `spentAmount == 1990010` | payment plus its fee and nothing else |
| `hasDestinationTag` false | memo mode carries no tag |
| the encoded request commits to this transaction and proof owner | replay of another payment is impossible |

The memo is the FAssets payment reference for the real Coston2 obligation 44851498 decoded in
Phase 02. So the chain is closed end to end at the data level:

```text
real Coston2 obligation 44851498
  -> payment reference 0x46425052664100020…02ac612a
    -> XRPL Testnet payment 7500DA52…, memo carries that reference
      -> FDC reports that memo, that source, that destination and that amount
```

The distinction between `receivedAmount` and `intendedReceivedAmount` is worth noting: FAssets
validates against `intendedReceivedAmount`, which is what the destination would have received had
the transaction succeeded. For a successful payment they are equal, and both were checked.

## What is still blocked

| Step | State |
|---|---|
| Build the request for a real payment | Done |
| Verifier confirms the payment and its fields | Done |
| Cross-check against every FAssets confirmation rule | Done, 10/10 |
| `FdcHub.requestAttestation(bytes)` | **Blocked: payable, needs C2FLR** |
| Wait for the voting round and retrieve the Merkle proof | **Blocked: follows submission** |
| `FdcVerification.verifyXRPPayment(proof)` on Coston2 | **Blocked: needs a proof** |
| Feed the proof to `confirmXRPRedemptionPayment` | Phase 10, and needs an agent |

`requestAttestation` is payable and its fee is read from `FdcRequestFeeConfigurations`, both of
which were selector-verified in Phase 00. There is no gasless path.

## Open items

- The proof, once retrievable, must be decoded and matched against the obligation locally before
  the completion interface is called (FR-052). That code does not exist yet.
- Proof replay and proof-owner mismatch are listed as required Phase 05 tests and cannot be run
  without a proof.
- The nonexistence path (`XRPPaymentNonexistence`) is selector-verified but not exercised. It is
  what authorizes a replacement after a genuine expiry, so it matters more than its position in the
  happy path suggests.

## Reproduce

```bash
node --experimental-strip-types scripts/fdc/prepare-and-crosscheck.mjs \
  evidence/receipts/xrpl-payment-7500DA52CAB254DBD1B64BC88975B2D01C4DFDF309A6C78398C57142493759AF.json
```
