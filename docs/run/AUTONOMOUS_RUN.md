# Signet autonomous run

Branch: `build/signet-autonomous`
Started: 2026-08-11
Mode: one-approval build. Phases 00-05 are the validation block; Phases 06-13 continue
automatically only if `docs/run/VALIDATION_DECISION.md` says `PASS`.
Phases 14 and 15 are explicitly out of scope for this run.

Live state: `docs/run/run-state.json`.
Outstanding external requests: `docs/run/FUNDING_REQUEST.md`.
Access gates: `docs/run/ACCESS_STATUS.md`.

## Phase index

| Phase | Title | Result | Evidence | Summary | Commit |
|---|---|---|---|---|---|
| 00 | Source lock and environment | PASS | [phase-00.md](../evidence/phase-00.md) | [phase-00-summary.md](phase-00-summary.md) | `a3a986a` |
| 01 | Executable reference model | PASS | [phase-01.md](../evidence/phase-01.md) | [phase-01-summary.md](phase-01-summary.md) | `da0a56b` |
| 02 | FAssets protocol seam | pending | | | |
| 03 | FCC scaffold seam | pending | | | |
| 04 | XRPL transaction seam | pending | | | |
| 05 | FDC seam | pending | | | |
| — | Validation decision | pending | | | |
| 06 | Minimum Signet contracts | pending | | | |
| 07 | Signet extension policy | pending | | | |
| 08 | Durable coordinator | pending | | | |
| 09 | Full local composed lifecycle | pending | | | |
| 10 | Target-chain lifecycle | pending | | | |
| 11 | Independent verifier and claim ledger | pending | | | |
| 12 | Essential operator and proof UI | pending | | | |
| 13 | Hardening | pending | | | |

## Standing constraints

- The extension has no arbitrary signing endpoint, and the public request API accepts a FAssets
  request identifier only.
- A provisional XRPL response is never a final result, and no replacement is created during an
  unresolved ledger-history gap.
- Simulated TEE execution is labelled simulated everywhere it appears.
- Every public number is generated from `evidence/claim-ledger.json`, never typed in.
- User-owned application hosting is Cloudflare only. Coston2, XRPL Testnet, FDC and the
  officially required FCC environment are protocol-native exceptions.
