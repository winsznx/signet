---
name: signet-protocol
description: Current project rules for Signet FAssets, FCC, XRPL and FDC integration
---

# Signet protocol skill

Read `PRD.md`, `CLAUDE.md` and `docs/source-lock.json`.

Use only pinned official interfaces. Never invent or copy stale addresses.

```text
FAssets obligation
  -> canonical FCC instruction
    -> exact XRP payment signature
      -> validated XRPL result
        -> FDC proof
          -> FAssets completion
```

The extension accepts a request ID and canonical obligation, never arbitrary payment fields.

A provisional XRPL response is not final. Persist before submit. Use `LastLedgerSequence`. Reconcile validated ledgers. Replacement requires authoritative non-success.

Every public claim requires claim-ledger evidence. Simulated TEE execution is not hardware attestation.
