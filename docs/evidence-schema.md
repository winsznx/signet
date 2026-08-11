# Evidence schema

Every public Signet claim points at a receipt, and every receipt is meant to be checked by someone
who does not trust us. This document is what they need to do that.

## The rule that shapes everything

**A receipt is never evidence for itself.** It records what happened; the verifier goes and asks the
sources. A receipt saying a payment was validated proves nothing, so the verifier asks the ledger. A
receipt naming a commitment proves nothing, so the verifier recomputes it from what was actually
paid.

The second rule follows from the first: **"cannot check" is not "checked and passed."** A verifier
that rounds unverifiable up to verified launders the gap it should be reporting.

## Outcomes

| outcome | meaning | exit code |
|---|---|---|
| `PASS` | every check the receipt claims ran and succeeded | 0 |
| `FAIL` | a check ran and the receipt is wrong | 1 |
| `UNVERIFIABLE` | a check could not run against public sources | 3 |
| `NOT_CLAIMED` | a difference the receipt explicitly never asserted | does not change the verdict |

`UNVERIFIABLE` has its own exit code because a caller that reads a nonzero status as "not a pass" is
right, and a caller that reads zero as "verified" must never see zero for something unchecked.

## Running it

```bash
pnpm --filter @signet/verifier verify:receipt <transaction hash | filename | path>
```

No credentials. No private RPC. A fresh clone and a network connection is the whole requirement.
Endpoints and the AssetManager address come from `docs/source-lock.json`, never from the receipt: a
receipt that chose its own verifier would be checking itself.

## Receipt fields

| field | required | meaning |
|---|---|---|
| `seam` | yes | which boundary this receipt is about |
| `requestId` | yes | the FAssets redemption request id, decimal |
| `txHash` | yes | the XRPL transaction |
| `validatedLedger` | no | the ledger the receipt claims the payment is in; checked against the ledger |
| `agentVault` | no | checked against the agent FAssets assigned |
| `authorizationCommitment` | no | checked against a recomputation, when `decisionContext` is present |
| `settles` | no | **absent means the receipt claims to settle its obligation** |
| `decisionContext` | no | the commitment inputs the ledger does not hold |

### `settles`

Some receipts prove a seam rather than a settlement. They borrow a real obligation's payment
reference to exercise the XRPL path and pay an amount and destination of their own choosing.

Those must set `settles: false`. The comparison against FAssets still runs and the difference is
still printed, so a reader sees exactly what does not match; only the verdict changes.

Silence means the receipt claims settlement. A receipt can never buy leniency by omitting a field,
which is why the default is the strict one.

### `decisionContext`

The authorization commitment covers every payment field. Most of them are in the transaction the
ledger holds; the rest are the binding and policy values in force when the decision was made:

```json
{
  "flareChainId": "114",
  "assetManager": "0x…",
  "instructionSender": "0x…",
  "agentVault": "0x…",
  "requestGeneration": 0,
  "xrplNetworkId": 1,
  "policyVersion": 1,
  "extensionId": "1",
  "extensionCodeHash": "0x…",
  "firstUnderlyingBlock": "…",
  "lastUnderlyingBlock": "…",
  "lastUnderlyingTimestamp": "…",
  "maxFeeDrops": "…"
}
```

Without it the commitment cannot be recomputed and the verifier reports `UNVERIFIABLE` rather than
guessing. Filling a missing field with a plausible default would produce a commitment matching
whatever the receipt claims, which is the failure mode of a verifier that always agrees.

## What the verifier checks

1. Independently operated XRPL endpoints are all asked, and must agree. One endpoint is one party.
2. The transaction is validated, not provisional.
3. The ledger accepted it (`tesSUCCESS`).
4. The receipt names the ledger the payment is actually in.
5. Partial payment was not enabled. The deciders pin `Flags` to 0 and the ledger is where that is
   confirmed to have survived signing.
6. The memo is the payment reference FAssets derives from this request id, recomputed here.
7. The obligation is read from the Coston2 AssetManager over plain `eth_call`, on every endpoint,
   and their answers must agree.
8. The payment went to the address FAssets named.
9. The amount is exactly value minus fee.
10. The agent named is the one FAssets assigned.
11. The authorization commitment, recomputed from the transaction plus `decisionContext`, matches
    the one recorded.

Check 11 is the one that catches a coordinator lying about the obligation. The commitment covers
every payment field while the obligation hash covers only the obligation's identity, so a payment
moved to another destination keeps its obligation hash and gets a different commitment.

## Reading the FAssets struct

`RedemptionRequestInfo.DataExt` is decoded positionally from raw `eth_call` output rather than
through a chain library, because a skeptic running this has to trust every dependency it pulls in
and decoding one struct by hand is a smaller ask than auditing a client.

The cost is that a field added upstream would shift every value while the decode still appears to
succeed. `verifier/test/layout.test.ts` reads the field order out of the pinned Solidity and asserts
the indices against it, so that fails loudly instead.

## Corrupting a bundle

`verifier/test/corruption.test.ts` corrupts one field at a time and requires a `FAIL` for each:
commitment, destination, amount, memo, ledger number, validation flag, engine result, partial
payment flag, agent, and endpoint disagreement. It also proves the honest receipt passes, because a
verifier that fails everything catches corruption for the wrong reason.
