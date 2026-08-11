# Phase 11 — Independent verifier and claim ledger

Result: **PASS.** 17 verifier tests, and the verifier's central check runs green against the real
composed-lifecycle receipt.
Date: 2026-08-11
Command: `pnpm --filter @signet/verifier verify:receipt 28B48DC36ACFDA1C22E97C033941355E4680B8F28964DB78F68AA44B41FBEFF4`, `make test-verifier`
Schema: [`../evidence-schema.md`](../evidence-schema.md)

## 1. What this phase is for

Phase 09 ended with a stated gap. A coordinator that reports a real obligation but names a
destination of its choosing gets a real signature, and nothing at the signing boundary stops it. The
defence was described as detection after the fact by recomputing the authorization commitment from
an independent FAssets read.

That defence did not exist yet. It does now, and it runs:

```text
ok   the authorization commitment matches the payment
```

against the live composed-lifecycle receipt, recomputed from the transaction the XRP ledger holds
plus the binding and policy values in force at decision time. A payment moved to another destination
keeps its obligation hash and produces a different commitment, so the recomputation catches it. That
is proven by `verifier/test/corruption.test.ts`, which moves the destination and requires a FAIL.

The gap is now detectable rather than merely describable. It is still detection rather than
prevention, and Phase 09's limitation stands unchanged in that respect.

## 2. Two rules

**A receipt is never evidence for itself.** It records what happened; the verifier asks the sources.
A receipt saying a payment was validated proves nothing, so the ledger is asked. A receipt naming a
commitment proves nothing, so it is recomputed.

**"Cannot check" is not "checked and passed."** `UNVERIFIABLE` is a distinct outcome with its own
exit code, 3. A verifier that rounds it up to verified launders the gap it should be reporting.

## 3. Running it on the real receipts

Against the composed lifecycle:

```text
ok   independent xrpl endpoints agree
ok   the payment is validated, not provisional
ok   the ledger accepted the payment
ok   the receipt names the ledger the payment is actually in
ok   partial payment was not enabled
ok   the payment carries the reference fassets derives from this request id
??   the obligation exists in fassets
       this request id is not readable on the public chain, so the payment cannot be tied to an
       obligation anyone else can inspect
ok   the authorization commitment matches the payment

UNVERIFIABLE: 7 passed, 0 failed, 1 unverifiable, 0 not claimed
```

The `UNVERIFIABLE` line is correct and is the point. That obligation was created on a local fork,
so no third party can read it, and the verifier says so rather than counting seven passes and
calling the bundle verified. It will turn green when Phase 10's obligation exists on Coston2.

## 4. A finding in an earlier phase's receipt

Run against the Phase 04 XRPL payment receipt, the verifier reported that the payment did not go
where FAssets said and the amount was not value minus fee.

Both are true. That payment borrowed a real Coston2 obligation's payment reference to exercise the
XRPL path and paid an amount and destination of its own choosing. The claim ledger already recorded
this in its limitations, so the claim was not overstated. The receipt did not say it, though, and a
verifier reading only receipts had no way to know.

Receipts that prove a seam rather than a settlement now say `settles: false`. The FAssets
comparison still runs and the difference is still printed, so a reader sees exactly what does not
match; only the verdict changes. **Silence means the receipt claims settlement**, so a receipt can
never buy leniency by omitting a field.

## 5. Reading FAssets without a chain library

The obligation is read over plain `eth_call` with a hand-encoded selector and a positionally
decoded struct. A skeptic running this has to trust every dependency it pulls in, and decoding one
struct by hand is a smaller ask than auditing a client.

The cost is real: a field added upstream would shift every value while the decode still appears to
succeed. `verifier/test/layout.test.ts` reads the field order out of the pinned Solidity source and
asserts the indices against it. My first attempt at that layout was wrong, and this test is what
caught it.

## 6. Corruption detection

The phase gate asks for one deliberately corrupted bundle. There are ten, one per field the verifier
reads, each requiring a FAIL: commitment, destination, amount, memo, ledger number, validation flag,
engine result, partial-payment flag, agent, and endpoint disagreement.

Two more tests matter as much. One proves the honest receipt passes, because a verifier that fails
everything catches corruption for the wrong reason. The other proves a receipt cannot escape a check
by omitting the field that triggers it.

They run against stubbed sources rather than the network, because a test that needs the internet is
a test that gets skipped, and a skipped verifier test is how a verifier quietly stops verifying.

## 7. Limitations

- The obligation half is `UNVERIFIABLE` for every receipt this run produced, because every
  obligation was created on a fork. Nothing here proves the FAssets comparison works against a real
  public obligation; it proves the verifier refuses to claim it did.
- The verifier checks a receipt against public sources. It does not verify an FDC Merkle proof or
  FAssets completion, because neither exists yet without C2FLR.
- `decisionContext` is supplied by the receipt. The verifier recomputes the commitment from it, so
  a receipt that lied about, say, `extensionCodeHash` would produce a self-consistent commitment.
  Binding it to the registry's on-chain record requires the registry to be deployed, which is
  Phase 10.
- The evidence bundle is the receipts directory rather than a signed, content-addressed archive.
