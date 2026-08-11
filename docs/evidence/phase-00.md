# Phase 00 — Source lock and environment

Result: **PASS**
Date: 2026-08-11
Branch: `build/signet-autonomous`
Networks touched: Flare Coston2 (read-only), XRPL Testnet (read-only)

## 1. Objective

Create the monorepo, pin every official upstream source by commit and content hash, record the
toolchain, resolve every Coston2 address Signet depends on from an authoritative source and prove
it by RPC, and mark access blockers explicitly. No product logic.

## 2. Pinned upstream sources

`make bootstrap` fetches each repository at its locked commit into `upstream/<id>/` and hashes the
extracted tree. The hash is computed over sorted `path\0sha256(content)` records, so it is
independent of tar and gzip framing and survives GitHub re-encoding an archive.

| id | commit | files | contentSha256 | license |
|---|---|---|---|---|
| fce-extension-scaffold | `ffb6c4ca7c160c49be59e00fe537e24d2477b000` | 208 | `47f0b162e3c3aa212459a465fb9ce72104788c8f88019b86ad8bd3f44c1bd538` | undeclared |
| flare-foundry-periphery-package | `ca264d6a31ddfb53d1bef7cb7bd1942aa89d323a` | 747 | `62ec4c7430b7005906b985747fd419a91bcfc6c05441bf96463c9f66a8a131f4` | undeclared |
| flare-npm-periphery-package | `5eb805d2e92c6a56be07a09377c1278d7e937b6e` | 753 | `be46fe59f5296c887b49cfb12dc4fd9dff81fac027a632cdef2fdd9cce9807d9` | MIT |
| fassets | `6d5c103e4342f0fc7d3683a433a90349d544f774` | 670 | `69bd367e36b818a28b438becf3ce3446a210bbb3677d4fe497b019b859e99a25` | undeclared |
| fdc-client | `06fb20ed19740c848e30724cc920816dd1ed6c7b` | 105 | `76b968843700830bdbf4c59911a66c1fad4f119afc7c71b973b16cdf5a5583b9` | MIT |
| tee-proxy | `d9c2c0ff5f07ed8895823d9485f08bec375bb842` | 132 | `822dfd9507f1f53db022e743671bce0da620c3e59ee4569737f211213f76ef02` | undeclared |
| fce-sign | `6df972c64d34efe1d4497f0eafe6792d1f0862dd` | 135 | `9c60cc7847a63ed44cd77f774ddd4c8553f3f01133e6e00b1c41949fe9fe11cc` | undeclared |
| developer-hub | `d2e11788187325e651792431b24c19b56b181ba7` | 901 | `a1a183a5500d247df9108d326f679dd8635617cba5ba240c5da1d5080a6a15cd` | undeclared |
| openzeppelin-contracts | `f78e4455519b33284d053b4d1af9a35e0fe48db3` (tag v5.2.0-rc.1) | 693 | `948748cd4104ebc1a9aa9db259fe3e9944c7b5c95299c2afb372063c79777969` | MIT |

OpenZeppelin was added because `flare-foundry-periphery-package` declares
`@openzeppelin-contracts = 5.2.0-rc.1` through soldeer, and the periphery interfaces do not compile
without it. Pinning it keeps the whole compile graph under source control.

## 3. Coston2 resolution and RPC verification

Chain id observed: `0x72` (114). Verified at block 33,921,235.

Registry-managed contracts come from a live `FlareContractRegistry.getAllContracts()` call, which
returned 69 entries. FCC contracts are not in the registry and come from the pinned scaffold
manifest instead. Nothing is copied from a document.

| id | address | resolved from | runtime code |
|---|---|---|---|
| flare-contract-registry | `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` | pinned periphery `ContractRegistry.sol` constant | 3,197 B |
| asset-manager-fxrp | `0xc1ca88b937d0b528842f95d5731ffb586f4fbdfa` | registry `AssetManagerFXRP` | 217 B (diamond) |
| asset-manager-controller | `0x1c772f700308af4c13897cc7b9c41effb82c50c0` | registry `AssetManagerController` | 177 B (EIP-1967 proxy) |
| fdc-hub | `0x48ac463d7975828989331f4de43341627b9c5f1d` | registry `FdcHub` | 10,065 B |
| fdc-verification | `0x906507e0b64bcd494db73bd0459d1c667e14b933` | registry `FdcVerification` | 170 B (EIP-1967 proxy) |
| fdc-request-fee-configurations | `0x191a1282ac700ede65c5b0aaf313bacc3ea7fc7e` | registry `FdcRequestFeeConfigurations` | 6,173 B |
| relay | `0xa10b672d1c62e5457b17af63d4302add6a99d7de` | registry `Relay` | 12,676 B |
| fcc-flare-tee-manager | `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` | pinned scaffold `config/coston2/deployed-addresses.json` | 184 B (diamond) |

Runtime code hashes and the full per-selector record are in `docs/source-lock.json#contracts` and
`deployments/coston2.json`.

### Selector proof method

Selectors are never transcribed by hand. `contracts/src/interfaces/PinnedProtocol.sol` imports the
pinned interfaces, `forge build` produces their ABIs, and `scripts/lib/abi.mjs` derives the
canonical signature and 4-byte selector from those ABIs. A missing or overloaded function name is a
hard error, so an upstream interface change surfaces at the gate.

Each selector is then proven reachable on the live deployment by at least one of:

- a `PUSH4 <selector>` in the contract's own runtime dispatcher;
- a `PUSH4 <selector>` in the EIP-1967 implementation behind a proxy;
- a non-zero `DiamondLoupe.facetAddress(selector)` result;
- a successful behavioural `eth_call` for zero-argument view functions.

35 selectors were proven across 8 contracts. Examples:

| contract | signature | selector | proof |
|---|---|---|---|
| asset-manager-fxrp | `redemptionRequestInfo(uint256)` | `0xb5bd20ee` | facet `0xd9db97ae…c1f6` |
| asset-manager-fxrp | `confirmRedemptionPayment((bytes32[],(bytes32,bytes32,uint64,uint64,(bytes32,uint256,uint256),(uint64,uint64,bytes32,bytes32,bytes32,bytes32,int256,int256,int256,int256,bytes32,bool,uint8))),uint256)` | `0xbf9a2438` | facet `0x2a761784…25d1` |
| asset-manager-fxrp | `redeemWithTag(...)` | see source lock | live facet |
| asset-manager-fxrp | `confirmXRPRedemptionPayment(...)` | see source lock | live facet |
| asset-manager-fxrp | `lotSize()` | `0x4942f65f` | facet `0xcb4ee2fa…a306` and successful `eth_call` |
| fdc-verification | `verifyPayment(...)` | `0xa7a37975` | present in implementation `0x6e332052…18a7` |
| fdc-verification | `verifyReferencedPaymentNonexistence(...)` | `0xd5772751` | present in implementation `0x6e332052…18a7` |
| fdc-verification | `verifyXRPPayment(...)` | see source lock | present in implementation `0x6e332052…18a7` |
| fdc-verification | `verifyXRPPaymentNonexistence(...)` | see source lock | present in implementation `0x6e332052…18a7` |
| fdc-hub | `requestAttestation(bytes)` | `0x6238f354` | own runtime dispatcher |
| fcc-flare-tee-manager | `sendInstructions(address[],(bytes32,bytes32,bytes,address[],uint64,address))` | `0xf731df53` | facet `0xe0958de9…62ff` |

### Finding: FAssets confirms XRP redemptions through the XRPL-specific attestation type

`upstream/fassets/contracts/assetManager/library/TransactionAttestation.sol` calls
`fdcVerification.verifyXRPPayment` and `verifyXRPPaymentNonexistence`, not the chain-agnostic
`verifyPayment`. `IXRPPayment` (attestation id `0x08`) exposes `firstMemoData`, `destinationTag`
and a `proofOwner` request field, which the generic `Payment` type does not.

Both XRPL-specific verification selectors are proven present in the live `FdcVerification`
implementation. This is why the source lock now records 35 selectors rather than 33: the two
XRP-specific verifiers were added once the pinned FAssets source showed they are the ones on the
critical path. The generic `verifyPayment` and `verifyReferencedPaymentNonexistence` are retained
because they remain the proof types for the memo-mode confirmation entry points.

### Finding: FCC facet drift against the pinned manifest

The live diamond routes `getRandomTeeIds(uint256,uint256)` to `0xb7defecfe34f378652ca5dceb2bf1c01604dea09`,
which is **not** any address in the pinned scaffold `deployed-addresses.json` (that manifest names
`MachineManagerFacet` as `0xF40B9a2e70EE96042217F10D94A4B1eDf13096a8`). The other three FCC
selectors do match the manifest.

This is recorded, not tolerated silently. It is the concrete justification for the PRD rule that no
production code may rely on an address copied from a document: the pinned manifest is already stale
against the live deployment on at least one facet. `scripts/resolve-coston2.mjs` now records
`facetInScaffoldManifest` for every diamond-routed selector so the drift is machine-detected on
every re-resolution.

## 4. Access status

Full detail in `docs/run/ACCESS_STATUS.md`. Summary of the gates the PRD calls day-zero:

| Gate | Finding |
|---|---|
| Coston2 RPC | Open |
| C2FLR gas | **External.** Faucet is captcha-gated with no API. `docs/run/FUNDING_REQUEST.md` |
| FAssets FXRP live | Open, read-only proven; 4 agents, 1,664 free lots |
| FAssets agent whitelisting for Signet | **External**, with two documented fallbacks |
| FCC contracts live | Open |
| FCC indexer DB credentials | Not requested. Self-service path identified: run the public `flare-system-c-chain-indexer` against the public Coston2 RPC |
| FCC proxy public reachability | Open via the scaffold's account-free Cloudflare tunnel |
| Real hardware attestation | Not required for V0; simulated must be labelled |
| XRPL Testnet RPC and faucet | Open, two independent endpoints answer |

## 5. Commands run

```text
$ make verify-bootstrap
node scripts/verify-toolchain.mjs
toolchain OK: 7 tools match toolchain.lock
node scripts/fetch-upstream.mjs
verify fce-extension-scaffold contentSha256=47f0b162…d538 files=208 OK
verify flare-foundry-periphery-package contentSha256=62ec4c74…a131f4 files=747 OK
verify flare-npm-periphery-package contentSha256=be46fe59…9807d9 files=753 OK
verify fassets contentSha256=69bd367e…e99a25 files=670 OK
verify fdc-client contentSha256=76b96884…5583b9 files=105 OK
verify tee-proxy contentSha256=822dfd95…76ef02 files=132 OK
verify fce-sign contentSha256=9c60cc78…9fe11cc files=135 OK
verify developer-hub contentSha256=a1a183a5…6a15cd files=901 OK
verify openzeppelin-contracts contentSha256=948748cd…77969 files=693 OK
node scripts/verify-source-lock.mjs
source-lock OK: 9 pinned upstream sources, 8 verified contracts, 35 proven selectors
forge build --sizes
Compiler run successful!
verify-bootstrap OK

$ bash scripts/secret-scan.sh
secret scan OK: no key material in tracked files

$ node scripts/resolve-coston2.mjs
ok flare-contract-registry          0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019 code=3197B  selectors=2
ok asset-manager-fxrp               0xc1ca88b937d0b528842f95d5731ffb586f4fbdfa code=217B   selectors=15
ok asset-manager-controller         0x1c772f700308af4c13897cc7b9c41effb82c50c0 code=177B   selectors=2
ok fdc-hub                          0x48ac463d7975828989331f4de43341627b9c5f1d code=10065B selectors=3
ok fdc-verification                 0x906507e0b64bcd494db73bd0459d1c667e14b933 code=170B   selectors=6
ok fdc-request-fee-configurations   0x191a1282ac700ede65c5b0aaf313bacc3ea7fc7e code=6173B  selectors=1
ok relay                            0xa10b672d1c62e5457b17af63d4302add6a99d7de code=12676B selectors=2
ok fcc-flare-tee-manager            0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE code=184B   selectors=4
resolved 8 contracts on coston2 at block 33921235

$ node scripts/probe-fassets-access.mjs
(full output at docs/protocol-seams/fassets-access-probe.json)
lotSizeAMG 10000000, assetMintingDecimals 6, underlyingBlocksForPayment 500,
underlyingSecondsForPayment 900, redemptionFeeBIPS 50, chainId testXRP,
availableAgents 4, totalFreeCollateralLots 1664,
agentOwnerRegistry 0xAF21eE9C49030e2dE9e8c2Ab7618082cc3d70b42

$ make verify-phase PHASE=00
--- make verify-bootstrap ---
toolchain OK: 7 tools match toolchain.lock
sandbox config OK: secret paths are deny-read in every settings file
source-lock OK: 9 pinned upstream sources, 8 verified contracts, 35 proven selectors
claim-ledger OK: 6 claims, 3 verified, all evidence present and consistent
verify-bootstrap OK
--- bash scripts/secret-scan.test.sh ---
secret-scan regression fixtures
ok    camelCase privateKey assignment
ok    bare 64-hex under an unrelated field name
ok    XRPL family seed on a line containing the token signet-
ok    PEM private key block in a non-pem file
ok    aws access key id
ok    allowlisted upstream content digest
ok    placeholder assignment
secret-scan regression OK
--- bash scripts/secret-scan.sh ---
secret scan OK: 25 tracked files, 11 allowlisted digests, no key material
phase 00 gate PASS (evidence: docs/evidence/phase-00.md)
```

Negative control: `make verify-phase PHASE=00` was run before this file existed and failed with
`MISSING EVIDENCE: docs/evidence/phase-00.md`. The gate is not decorative.

## 6. Tests

| Test | Result |
|---|---|
| Source-lock schema (every PRD section 2 field present, well formed, no dangling refs) | PASS |
| Upstream content-hash verification, 9 repositories | PASS |
| Selector reachability, 35 selectors, hard-fails on any unreachable | PASS |
| Runtime code hash cross-checked against two independent RPC operators, mismatch halts | PASS |
| Manifest-backed diamond facets must match the pin or a dated exception | PASS (negative control below) |
| Toolchain match against `toolchain.lock`, 7 tools | PASS |
| Sandbox config lint: secret paths are deny-read in every settings file | PASS |
| Secret scan over tracked files | PASS |
| Secret-scan regression fixtures, 5 detections and 2 false-positive guards | PASS |
| Claim-ledger schema and proof-consistency gate | PASS |
| Phase gate refuses to pass without its evidence file | PASS (negative control above) |

Four verification bugs were found and fixed while building the gates, all of which would have made
a check pass vacuously:

1. The content hash included the `.signet-pin` stamp file that the fetcher itself writes, so verify
   and record disagreed on every entry.
2. `scripts/fetch-upstream.mjs` rewrote `docs/source-lock.json` on every run, including verification
   runs. That would let a drifting checkout silently overwrite the recorded hash. It now writes only
   when an entry is genuinely being recorded or repinned.
3. The first claim-ledger gate immediately caught two claims whose `verifiedAt` preceded the
   artefacts they cite, which is a ledger asserting it was verified before its own evidence existed.
4. The first version of the facet-pin rule was scoped too widely and failed on the FAssets diamond,
   which has no pinned facet manifest at all. Scoping it to manifest-backed contracts exposed that
   FAssets facet pinning is a genuine gap, now recorded as owned by Phase 02.

Negative controls run for the new gates:

- Rewriting `facetExceptions[0].observedFacet` to a different address made
  `verify-source-lock.mjs` fail on `getRandomTeeIds`, then pass again once restored. The exception
  is bound to the exact facet, so a further diamond cut re-breaks the gate.
- Three synthetic secrets that the previous scanner missed are now staged by
  `scripts/secret-scan.test.sh` on every run and each one fails the scan.

## 6a. Adversarial review results

Both required reviews were run against this phase and both returned CONDITIONAL PASS. Every
condition has been closed in this phase rather than deferred.

### Security review

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | No settings file denied reads of `.runtime/secrets/`, the designated location for generated testnet key material. Enforcement was "the agent chooses not to", which PRD 22.2 explicitly does not accept given prompt injection is a named adversary | `.runtime/secrets` added to `sandbox.filesystem.denyRead` and `permissions.deny` in all three settings files, plus `scripts/verify-sandbox-config.mjs` as a build-time invariant so removing a rule fails the gate. The first, broader rule (`Read(./.runtime/**)`) was narrowed after it also blocked the repo-local Go toolchain |
| HIGH | `scripts/secret-scan.sh` had three live-tested false negatives: case-sensitive keyword matching missed `privateKey`, no rule caught a bare 64-hex value under an unrelated field name, and a line-level exclusion for the token `signet-` suppressed any line containing it | Rewritten as `scripts/secret-scan.mjs`. Keyword matching is case-insensitive; 64-hex tokens are checked against an allowlist derived from the machine-readable digest artefacts, so a private key cannot inherit a hash's cover; XRPL secrets are detected by base58check decoding and type prefix rather than regex; self-exclusion is by path, not by line content. `scripts/secret-scan.test.sh` stages all three previously-missed cases plus two false-positive guards on every gate run |
| MEDIUM | FCC facet drift was recorded but never enforced, so the gate passed identically whether or not a facet matched the pin | `verify-source-lock.mjs` now fails when a manifest-backed diamond selector resolves to an unpinned facet unless a dated, owned `facetExceptions` entry names that exact facet |
| LOW | All Coston2 resolution trusted a single RPC endpoint, contrary to the PRD's malicious-RPC mitigation | Three independent Coston2 endpoints are locked and every runtime code hash is re-read from the others. A disagreement or an unreachable cross-check endpoint halts resolution |

### Evidence audit

The auditor independently reproduced the pins, the eight addresses and their code hashes, the
selector count, the FCC facet drift, the FAssets settings figures, the `AgentOwnerRegistry`
governance state, the zero deployer balance and both XRPL endpoints, by running this repository's
own scripts and by issuing its own RPC calls. It confirmed no claim counts a local run as
public-chain evidence, a deployed address as a completed workflow, a simulated TEE as attestation,
or a read-only call as a state change.

| Finding | Resolution |
|---|---|
| `run-state.json` `lastPassingPhase` still `null` after a PASS | Set to `"00"` on commit of this phase |
| `phase-00-summary.md` and `AUTONOMOUS_RUN.md` carried `PENDING_COMMIT_SHA` | Filled with the real commit SHA |
| Claim ledger used `networks`, PRD section 28 uses `network` | Renamed to `network` |
| Every claim shared one `verifiedAt` that preceded the artefacts it cites | Each claim's `verifiedAt` is now the latest generation time of the evidence it cites, enforced by `scripts/verify-claim-ledger.mjs` |
| `claim-coston2-addresses-verified` said "selectors Signet calls" while nothing calls them yet | Reworded to "selectors Signet depends on" |
| Gate output was quoted with the trailing evidence path truncated | Command transcript above is now verbatim |
| No claim-ledger schema gate existed | `scripts/verify-claim-ledger.mjs` added and wired into `verify-bootstrap` and the phase gate |

The auditor's re-run observed `totalFreeCollateralLots` of 1707 against the 1664 recorded here.
That is live-chain drift between two point-in-time probes, not a discrepancy; the probe artefact is
timestamped for exactly this reason. The auditor reviewed the lock at 33 selectors; the two
XRP-specific verification selectors were added afterwards for the reason given in section 3, taking
the count to 35.

## 7. Deviations from the PRD

| Item | Deviation | Reason |
|---|---|---|
| `docs/architecture.md`, `docs/threat-model.md`, `docs/public-private-boundary.md` | Not created | PRD section 10.1 is the target layout, not a Phase 00 deliverable. Phase 00's file list is source lock, toolchain, CLAUDE.md, `.claude/`, Makefile, lockfiles |
| `go.work` | Created with no `use` directives | Valid Go, and `extension/` does not exist until Phase 03 owns it |
| `upstream/` | Gitignored | Reproduced by `make bootstrap` from pinned commits and verified by content hash, so the bytes do not need to enter this history. Fresh-clone verification exercises the fetch path rather than trusting vendored copies |
| OpenZeppelin pin | Added beyond the PRD's named sources | Hard build dependency of the pinned periphery package |

## 8. Limitations

- All Coston2 evidence in this phase is read-only. Nothing has been deployed and no transaction has
  been sent.
- Selector reachability proves an entry point exists at an address. It does not prove the entry
  point behaves as the pinned interface describes. Behaviour is owned by Phases 02 to 05.
- Content hashes bind a checkout to a commit. They are not an attestation that the upstream commit
  is itself trustworthy.
- Six of the nine pinned repositories (`fce-extension-scaffold`, `flare-foundry-periphery-package`,
  `fassets`, `tee-proxy`, `fce-sign`, `developer-hub`) declare no license file. Recorded as
  `UNDECLARED_IN_REPO` rather than guessed. Only `flare-npm-periphery-package`, `fdc-client` and
  `openzeppelin-contracts` declare MIT.
- The sandbox needs `NODE_USE_ENV_PROXY=1` for Node's fetch and the local CA bundle for
  `*.rippletest.net`. Neither applies to a fresh clone outside the sandbox.
- FAssets diamond facets are resolved live and are not pinned to a baseline, so a diamond cut on
  the FXRP AssetManager between phases would not be detected today. Only FCC facets are
  manifest-backed and enforced. Closing this is owned by Phase 02, which is where FAssets
  behaviour is proven.
- The FCC facet exception for `getRandomTeeIds` is a dated acceptance, not a fix. It must be
  reviewed before Phase 03 consumes that selector to resolve TEE machines.

## 9. Completion gate

| Requirement | Met |
|---|---|
| Every required upstream source pinned | Yes, 9 repositories with commit and content hash |
| Current Coston2 addresses resolved and code-checked | Yes, 8 contracts, 35 selectors, all reachable |
| Access blockers explicitly marked | Yes, `docs/run/ACCESS_STATUS.md` and `docs/run/FUNDING_REQUEST.md` |
| Clean bootstrap | Yes, `make verify-bootstrap` |
| No-secret scan | Yes |

## 10. Stop boundary check

The Phase 00 stop boundary is: do not implement protocol logic if FCC indexer access or a credible
Coston2 redemption path cannot be obtained.

- FCC indexer: a self-service path exists that needs no Flare credential. Not blocked.
- Coston2 redemption path: FXRP is live with agents and free collateral, and both redemption modes
  resolve to live facets. Signet's own agent registration is externally gated, but two fallbacks
  are documented and PRD section 36.1 admits the weaker one.

Neither condition triggers the stop boundary. Phase 01 proceeds.
