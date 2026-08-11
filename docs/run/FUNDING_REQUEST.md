# External input required

Two items. Both are testnet-only. Neither is urgent before Phase 02 — the run continues on
Phases 00, 01 and 02 without them and only stalls when Phase 03 needs to send a Coston2
transaction.

---

## 1. C2FLR gas for the Coston2 deployer account

| Field | Value |
|---|---|
| Exact requirement | Coston2 testnet gas token (C2FLR) |
| Network | Flare Coston2, chain id 114 |
| Address to fund | `0x88f61BcDC3C0Cfe4E12dc0576960bcF3ECa88F7d` |
| Minimum amount | 100 C2FLR |
| Comfortable amount | 500 C2FLR |
| Phase blocked | 03 (FCC scaffold seam), then 05, 06, 10 |
| Why required | Deploying `SignetActionVerifier` and `SignetInstructionSender`, registering the extension and its code hash, registering the TEE machine, sending FCC instructions, paying FDC attestation request fees, and submitting redemption completion transactions all cost gas. There is no gasless path |
| Self-service attempted | `https://faucet.flare.network/coston2` returns HTTP 200 but serves a captcha-gated Next.js UI. No public API endpoint is exposed or documented. Verified 2026-08-11 |
| Where you obtain it | Open `https://faucet.flare.network/coston2` in a browser, paste the address above, solve the captcha. The faucet is rate limited, so a second visit after the cooldown may be needed to reach 500 C2FLR |
| Exact value needed back | Nothing. The private key is already generated locally and never leaves `.runtime/secrets/` |
| Safe fallback | None. Every Coston2 write path needs gas |

The key was generated with `cast wallet new` into `.runtime/secrets/coston2-deployer.json`
(mode 600, gitignored). It has never been printed, logged or committed. Do not send mainnet FLR
to this address.

---

## 2. FAssets agent whitelisting on Coston2 — decision, not necessarily a request

| Field | Value |
|---|---|
| Exact requirement | `0x88f61BcDC3C0Cfe4E12dc0576960bcF3ECa88F7d` added to `AgentOwnerRegistry` at `0xAF21eE9C49030e2dE9e8c2Ab7618082cc3d70b42` via `whitelistAndDescribeAgent` |
| Network | Flare Coston2 |
| Phase blocked | 10 (target-chain lifecycle), only for the official-FXRP variant |
| Why required | Signet must be the agent assigned to the redemption, because the mechanism is "the enclave signs only the payment this obligation requires". Redeeming FXRP as an ordinary user creates an obligation for a third-party agent that Signet has no authority to pay |
| Self-service attempted | Verified on chain that `manager()` is the zero address and `productionMode()` is `true`, so only Flare governance (`0xC83Ec6a4aFf2099942836860A28C7e248Fabc32C`) can whitelist. Official docs confirm agents are whitelisted by Flare Foundation |
| Where you obtain it | Flare Foundation / FAssets team, via the Flare Discord developer channels or your hackathon sponsor contact. Ask for Coston2 agent-owner whitelisting for the address above |
| Exact value needed back | Confirmation that the address is whitelisted. Nothing secret |
| Safe fallback | **Yes.** Deploy Signet's own `AssetManager` instance on Coston2 from the pinned `flare-foundation/fassets` source, with Signet as the agent, still using the real FDC and the real XRPL Testnet. This keeps every protocol seam real and narrows only the "Flare-operated FXRP instance" claim. It needs an ADR and item 1 above |

Because a safe fallback exists, this is **not** treated as a hard stop. If you do not obtain
whitelisting, the run proceeds on the fallback and the claim ledger records the narrower claim.

---

## What is not blocked

- XRPL Testnet accounts and funding: the faucet is self-service and reachable.
- FCC C-chain indexer credentials: not requested. Signet will run the public
  `flare-system-c-chain-indexer` against the public Coston2 RPC instead.
- Public reachability for the extension proxy: the scaffold's Cloudflare tunnel needs no account.
- Real hardware attestation: not required for V0, and simulated execution is labelled everywhere.
- Supabase and Cloudflare credentials: not required yet. Phase 08 decides whether durable
  PostgreSQL is genuinely needed, and Phase 12 decides the deployment surface.
