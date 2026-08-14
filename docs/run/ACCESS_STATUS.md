# Signet access status

Recorded at Phase 00. Every row is a live-verified finding, not a documentation summary.
Re-verify before any phase that depends on it.

Legend for status:

- `OPEN` — self-service, verified reachable from this machine
- `SELF_SERVICE_PATH_IDENTIFIED` — no credential needed, but the path has not been executed yet
- `EXTERNAL` — cannot be resolved without a third party
- `NOT_REQUIRED_V0` — gated for the production candidate only

## 1. Flare Coston2 chain access

| Item | Status | Evidence |
|---|---|---|
| Coston2 JSON-RPC | OPEN | `eth_chainId` = `0x72` (114), `eth_blockNumber` = 33,920,927 at 2026-08-11T12:20Z via `https://coston2-api.flare.network/ext/C/rpc` |
| ContractRegistry resolution | OPEN | `getAllContracts()` returned 69 entries; recorded in `docs/source-lock.json` |
| C2FLR gas for the deployer account | **EXTERNAL** | `https://faucet.flare.network/coston2` returns HTTP 200 but is a captcha-gated Next.js UI with no documented API. No automated path exists. See `docs/run/FUNDING_REQUEST.md` |

The deployer account was generated locally as a testnet-only key. Its private key lives in
`.runtime/secrets/coston2-deployer.json` (gitignored, mode 600) and has never been printed.

Public address: `0x88f61BcDC3C0Cfe4E12dc0576960bcF3ECa88F7d`
Balance at Phase 00: 0 wei.

## 2. FAssets on Coston2

| Item | Status | Evidence |
|---|---|---|
| `AssetManagerFXRP` deployed and live | OPEN | `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA`, 15 Signet-relevant selectors proven reachable through the live diamond |
| Redemption settings readable | OPEN | `docs/protocol-seams/fassets-access-probe.json`: lot size 10,000,000 AMG at 6 minting decimals, `underlyingBlocksForPayment` 500, `underlyingSecondsForPayment` 900, `redemptionFeeBIPS` 50, chainId `testXRP` |
| Destination-tag redemption mode live | OPEN | `redeemWithTag`, `confirmXRPRedemptionPayment`, `xrpRedemptionPaymentDefault`, `redemptionRequestInfoExt` all resolve to live facets |
| Agents available to mint against | OPEN | 4 available agents, 1,664 free collateral lots |
| **Signet operating as a registered FAssets agent** | **EXTERNAL** | `AgentOwnerRegistry` at `0xAF21eE9C49030e2dE9e8c2Ab7618082cc3d70b42`: `whitelistAndDescribeAgent` is `onlyGovernanceOrManager`, `manager()` is the zero address, `productionMode()` is `true`, governance is `0xC83Ec6a4aFf2099942836860A28C7e248Fabc32C`. Official docs state agents must be whitelisted by Flare Foundation |

### Why the agent gate matters

Signet's dominant mechanism requires a redemption **assigned to an agent whose XRPL account
Signet controls**. Redeeming FXRP as an ordinary user creates an obligation for somebody else's
agent, which Signet cannot lawfully pay. So the agent whitelist is on the critical path for the
official-FXRP variant of the Phase 10 target-chain lifecycle.

Two fallbacks exist and neither has been chosen yet. Both are recorded here so the decision is
explicit rather than accidental:

- **F1 — own AssetManager instance.** `flare-foundation/fassets` is pinned and open source. Signet
  can deploy its own `AssetManager` on Coston2 with Signet as the agent, against the real FDC and
  the real XRPL Testnet. This keeps every protocol seam real and only relaxes "Flare-operated FXRP
  instance". It requires an ADR and a narrowed claim, and it needs C2FLR.
- **F2 — narrowed claim.** Run the complete lifecycle against a pinned local FAssets deployment and
  claim only the seams that were genuinely executed on the target chain (XRPL Testnet payment, FDC
  proof, Coston2 FCC result verification), explicitly not claiming an official FXRP redemption.

PRD section 36.1 admits F2 ("use a pinned local protocol proof without claiming full target-chain
completion"). F1 is stronger and is the preferred fallback if C2FLR arrives.

## 3. Flare Confidential Compute

| Item | Status | Evidence |
|---|---|---|
| FCC contracts live on Coston2 | OPEN | `FlareTeeManager` diamond `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`; `sendInstructions` routes to `InstructionsFacet` `0xe0958…62Ff`, matching the pinned scaffold manifest |
| Official normal/FTDC proxy | OPEN (unauthenticated read) | `https://tee-proxy-coston2-1.flare.rocks` named in the pinned scaffold `.env.example` |
| Public reachability for our extension proxy | OPEN | The scaffold ships a Cloudflare tunnel path (`docker-compose.cloudflared.yaml`, `--tunnel`) that needs no account. This also satisfies Signet's Cloudflare-only hosting rule |
| **C-chain indexer database for the extension proxy** | EXTERNAL, one support request | **Corrected 2026-08-14.** The current official Coston2 guide names Flare's read-only indexer directly: `34.38.42.208:3306`, database `indexer`, credentials from Flare support. See `upstream/developer-hub/docs/fcc/guides/00-getting-started.mdx:314`, repeated in `01-sign.mdx` and `02-weather-insurance.mdx`. Chain id 114 and the Coston2 system addresses are pre-filled in the shipped examples |
| Real hardware attestation (GCP Confidential Space) | NOT_REQUIRED_V0 | PRD section 7.1 admits a clearly labelled simulated TEE for V0. `SIMULATED_TEE=true` yields code hash `0x194844cf…` and platform `TEST_PLATFORM`, which must be labelled everywhere it is shown. FTDC accepts only `GCP_AMD_SEV`; see `docs/run/GATE_A_STRETCH.md` |

> **This row previously read `SELF_SERVICE_PATH_IDENTIFIED`**, on the reasoning that
> `flare-system-c-chain-indexer` is public and could be run against the public Coston2 RPC, and it
> cited an older host (`35.241.249.150`) from the scaffold docs. That was a workaround for a problem
> the current official guide does not have, and acting on it would have meant running MySQL and
> syncing a chain to replace one support email. Self-hosting is not required and should not be
> attempted. The indexer is needed only for the FCC extension proxy, which is gate A work.

## 4. XRPL Testnet

| Item | Status | Evidence |
|---|---|---|
| Primary RPC | OPEN | `https://testnet.xrpl-labs.com/` `server_info` OK, `network_id` 1, rippled 3.3.0 |
| Second independent RPC | OPEN | `https://s.altnet.rippletest.net:51234/` `server_info` HTTP 200 |
| Faucet | OPEN | `POST https://faucet.altnet.rippletest.net/accounts` HTTP 200 |

Two independent endpoints are required by the reconciliation rules, and both answer.

Sandbox note: both `*.rippletest.net` hosts need the sandbox CA bundle
(`curl --cacert "$NIX_SSL_CERT_FILE"`). This is an artifact of the local egress proxy, not an
XRPL-side restriction, and it does not apply to a fresh clone outside the sandbox.

## 5. Open external requests

Exactly one external action is currently required. It is batched in
`docs/run/FUNDING_REQUEST.md`.
