# Phase 14 — Submission

Result: **PASS.** The package is assembled. **Nothing has been submitted externally.**
Date: 2026-08-14
Completion gate: every submission claim maps to evidence; no feature work.

## 1. Scope decision taken at the start

GCP Confidential Space was downgraded from a submission blocker to a stretch proof. The billing
account is in prepayment mode and did not open in time, which is an account state rather than a
technical obstacle.

Nothing in the submission depends on it, because no hardware-attestation claim is made anywhere. The
checklist for doing it later is [`../run/GATE_A_STRETCH.md`](../run/GATE_A_STRETCH.md), and the one
thing that must be fixed before attempting it is recorded there as a blocker.

## 2. Gate B was deployed, because it was not on chain

The headline invariant, "the caller supplies a request id and nothing else", was implemented and
tested but **not deployed**. Checking rather than assuming is what surfaced it: the sender at
`0xDd8aA7A4f43f01258A426a30d02032821De9bc6e`, registered 2026-08-11T23:11:16Z, does not contain the
selector `0x064267dd`, and gate B was committed 2026-08-12T01:53.

So the strongest claim in the package was proof level 1 while its documentation implied level 3.

It is now deployed and verified by RPC:

| | |
|---|---|
| sender | `0x3FFA63a3bf21a626c1B391D2577b1800e67F5Be0` |
| extension id | `66244` |
| binding | `getTeeExtensionInstructionsSender(66244)` returns that address |
| selectors present | `authorizeRedemption(uint256,uint32)`, `canonicalInstructionFor(uint256,uint32)`, `SCHEMA_VERSION()` |
| retired | `66163`, `66164` |

Full evidence: [`gate-b.md`](gate-b.md).

The composed lifecycle was rerun through that path: **76/76 checks pass**, with a live XRPL Testnet
payment (`A10C7C3C…399D`, `tesSUCCESS`, replay `tefPAST_SEQ`) and FDC `VALID`. The XRPL source account
needed topping up from the public testnet faucet first; the previous run had failed
`tecUNFUNDED_PAYMENT`, which was recorded rather than hidden.

## 3. A false statement was found in the deployment record

The registration script hardcoded extension 66163's retirement reason and wrote it verbatim over
66164's. The record therefore claimed 66164 "relayed the decision input unmodified", which is exactly
what 66164 fixed.

Both are corrected: the record now states the true reason, and the script refuses to invent one. It
takes `SIGNET_FCC_SUPERSEDE_REASON` and otherwise writes an obvious `UNRECORDED:` placeholder with a
warning, because a plausible lie in an evidence file is worse than a visible gap.

## 4. Adversarial review, and what it cost

A security review of the gate B boundary confirmed the central claim and found five defects. Every
attempt to influence destination, amount, fee, reference, tag mode, tag value, either window bound or
the agent vault through the FCC path failed.

Two of the findings were defects in **documents written earlier this phase**, and both are corrected
in place:

- "The JSON path is gone rather than deprecated" was true of the FCC-reachable path and false of the
  repository. `internal/wire` still decodes a fully caller-authored obligation for
  `cmd/signet-extension`. It reaches no key, and it is now scoped precisely wherever it appears.
- The Go test list credited a trailing-bytes assertion. `fccinput.Decode` does not reject trailing
  bytes despite a doc comment saying it does, and the test was written to accept either outcome.

The five findings are recorded in [`../threat-model.md`](../threat-model.md) under "Open after gate
B", with severity, reachability and the live checks. **They are documented rather than fixed**, for
two reasons: this phase forbids feature work, and the contract half is deployed, so changing the
source without redeploying would put the repository and the chain out of agreement.

Finding 1 deserves naming here. `authorizeRedemption` gates on `state != NONE` rather than
`== REQUESTED`, so an already-authorized action can be instructed again. It is unreachable today
because no TEE machine exists and `getRandomTeeIds(66244, 1)` reverts `0xd65ac61e` first. **It arms
itself the moment a TEE machine is registered**, which is precisely what gate A does, so it is a
blocker there rather than a note.

## 5. Evidence audit, and the bug it found in the proof page

An evidence audit ran over the assembled package and found six issues. All six are fixed.

The one worth naming is a repeat of this repository's oldest failure mode. `web/src/build.mjs`
parsed the phase table with `/^\| \d\d \|/`, which requires a two-digit phase number, so the **gate
B row was silently dropped from the deployed page** — the newest and most important row. The
regression test written specifically to catch this class of bug counted rows with the same
two-digit pattern, so it could not detect the omission it existed to prevent.

Both are fixed. The parser is scoped to the "Phase index" section, matches any row label, and now
**throws if the row count and the parse disagree** rather than quietly returning fewer rows. That
guard immediately caught a second table in the same file, which is what a guard is for. The test
names the gate B row and the deployed extension id instead of counting.

The other five:

| | fix |
|---|---|
| `threat-model.md` and `gate-b.md` said "four defects" above a five-row table | corrected to five |
| `claim-hardening` said "thirteen threats are closed"; the table has 18. The handoff said fourteen | both corrected to eighteen, counted from the table |
| `claim-hardening` said "6.2 million fuzz executions"; the two targets sum to 6,271,288 | states the exact total and both targets |
| `SUBMISSION_PACKAGE.md` said "one of which is high severity"; two are | states two, and which is reachable |
| the proof page's meta description led with "Attested external execution", which a share preview would show stripped of its qualifier | replaced with a summary that states the no-TEE position in the description itself |

The audit separately confirmed clean: no document claims hardware attestation, a registered TEE
machine, a completed FCC round trip, a settled redemption, whitelisted-agent operation or universal
exactly-once payment; every reference to extensions 66163 and 66164 is marked superseded; the
evidence graph regenerates byte-identically; and the fixture, test and check counts trace to
generated artefacts rather than being typed.

The page was rebuilt and redeployed to production. `https://signet-proof.pages.dev/` now carries
extension `66244` and the gate B phase row, and the strict CSP survives the hop:

```text
content-security-policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self';
                         base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

## 6. The evidence graph

`evidence/evidence-graph.json`, generated by `scripts/build-evidence-graph.mjs` and wired into
`make verify`.

The claim ledger says what is claimed and what backs it. It does not say how the artefacts relate, so
"which live transaction is this claim ultimately resting on" meant reading four files and holding the
joins in your head. The graph emits those joins: 145 nodes, 198 edges across 29 claims, 12 receipts,
the deployed contracts and their transactions.

Everything is derived from `claim-ledger.json`, `deployments/coston2.json` and
`evidence/receipts/*.json`. It fails the build on a dangling edge or a cited artefact that does not
exist, and it caught a real gap on first run: receipts referencing retired senders that were not
nodes.

## 7. Claim ledger

29 claims, 25 verified. `claim-canonical-requestid-derivation` is new at proof level 3 with eight
limitations, four of which record the review findings above.

Four stale limitations were corrected:

| claim | was | now |
|---|---|---|
| `claim-contracts-cannot-authorize-arbitrary-fields` | "Nothing is deployed; deployment needs C2FLR" | false since phase 10; points at the deployment claim |
| `claim-composed-lifecycle` | the arbitrary-signature gap | superseded by gate B; residual restated as isolation |
| `claim-execution-layer` | same | same |
| `claim-tee-hardware-attested` | referenced extension 66163 | 66244, plus the `GCP_AMD_SEV`-only constraint |

## 8. The indexer correction

`ACCESS_STATUS.md` recorded the FCC extension proxy's indexer database as
`SELF_SERVICE_PATH_IDENTIFIED`, on the reasoning that `flare-system-c-chain-indexer` is public and
could be run against the public Coston2 RPC, citing host `35.241.249.150` from the scaffold docs.

The current pinned official guide gives the supported path directly:
`34.38.42.208:3306`, database `indexer`, read-only credentials from Flare support
(`upstream/developer-hub/docs/fcc/guides/00-getting-started.mdx:314`, repeated in two sibling
guides). Chain id and Coston2 addresses are pre-filled in the shipped examples.

Acting on the old note would have meant running MySQL and syncing a chain to replace one support
email. The row is corrected and self-hosting is recorded as explicitly not required.

## 9. Deliverables

| | |
|---|---|
| submission copy and links | [`../run/SUBMISSION_PACKAGE.md`](../run/SUBMISSION_PACKAGE.md) |
| demo script and storyboard | [`../run/DEMO_SCRIPT.md`](../run/DEMO_SCRIPT.md) |
| gate A stretch checklist | [`../run/GATE_A_STRETCH.md`](../run/GATE_A_STRETCH.md) |
| judge path | [`../run/FINAL_REVIEW_HANDOFF.md`](../run/FINAL_REVIEW_HANDOFF.md) |
| gate B evidence | [`gate-b.md`](gate-b.md) |
| evidence graph | `evidence/evidence-graph.json` |

## 10. No feature work

No protocol behaviour changed in this phase. The changes are: a deployment of already-written and
already-tested code, corrections to false or stale statements, one script defect fixed so it stops
producing false statements, and new documentation.

## 11. Not done

- Nothing submitted externally. That is the operator's call and the package is staged for it.
- The demo has not been recorded. The script and shot list exist; the recording does not.
- The five open findings are not fixed.
- No real TEE, no attestation, no registered TEE machine.
