# FAssets agent whitelist request


> **Superseded, 2026-08-11.** Flare declined to approve new FAssets agents and directed Signet to
> test the execution layer instead. The whitelist is not a pending blocker; it is closed, and own-agent
> settlement is out of scope by organizer guidance. See
> [`docs/evidence/organizer-accepted-proof-boundary.md`](../evidence/organizer-accepted-proof-boundary.md).
The one thing Signet still cannot do is settle a FAssets redemption, and this is why.

## The gate, verified on chain

| | |
|---|---|
| `AgentOwnerRegistry` | `0x94e33f519e256149752711245eab2e1abb8c34a4` (read from `AssetManagerFXRP.getSettings()`, not hardcoded) |
| entrypoint | `whitelistAndDescribeAgent(address,string,string,string,string)` |
| access | `onlyGovernanceOrManager` |
| `governance()` | `0xC83Ec6a4aFf2099942836860A28C7e248Fabc32C` |
| `productionMode()` | `true` |
| `isWhitelisted(us)` | reverts, i.e. not whitelisted |

Flare's own pinned documentation is unambiguous:

> Agents are whitelisted through Flare governance, so you cannot register one for a test or a demo.
> — `upstream/developer-hub/docs/support/faqs.mdx`, line 235

`productionMode() == true` means governance calls are timelocked through the governance settings
contract, so even the holder of the governance key cannot whitelist us immediately. There is no
self-service path, no fee, and no permissionless fallback. This is the one boundary in the whole
build that a better script cannot get around.

## What we did instead

Rather than stall, the run used the fact that **minting is not gated**: reserve collateral against an
existing agent, pay that agent in underlying XRP, prove it through FDC, execute minting, then redeem.
That produced a real Coston2 obligation (request 44928272) and let every part of Signet except
settlement run against the deployed chain.

## What whitelisting would unblock

Only one thing, but it is the headline claim: Signet signing the agent's redemption payment from the
agent's own underlying address, so that `confirmRedemptionPayment` succeeds and FAssets marks the
redemption complete. Everything upstream of that already works on the real chain.

---

## Ready to send

Subject: **FAssets agent whitelist request on Coston2 for a testnet integration (Signet)**

> Hello,
>
> We are building Signet, an attested external execution layer for FAssets agents: a redemption
> obligation read from FAssets constrains what an agent's signer is allowed to sign on XRPL, and the
> resulting payment is proven back through FDC.
>
> We would like to request an agent whitelist entry on **Coston2** so we can complete a redemption
> end to end. We are not asking for mainnet or Songbird access.
>
> **What we need**
>
> `AgentOwnerRegistry.whitelistAndDescribeAgent(...)` on `0x94e33f519e256149752711245eab2e1abb8c34a4`
> for our management address.
>
> | field | value |
> |---|---|
> | management address | `0x88f61BcDC3C0Cfe4E12dc0576960bcF3ECa88F7d` |
> | network | Flare Coston2 (chain id 114) |
> | intended XRPL underlying address | `rPvarExLQuuqtkMBfDHp3pNnESZ5HByXta` (XRPL Testnet) |
> | name | Signet |
> | description | Attested external execution layer for FAssets agents (testnet integration) |
>
> We will set the work address ourselves with `setWorkAddress` once the entry exists.
>
> **What we have already done on Coston2**, in case it is useful for assessing the request:
>
> - Signet registry and instruction sender deployed and exercised:
>   `0x381bdE5961695914B28B16f405d51E8acB877f6e`, `0xd6cF30B6411DB8465147FfDcF0e0418030B4b9CA`
> - A full minting cycle as a minter: collateral reservation 48120984, underlying payment on XRPL
>   Testnet, `Payment` attestation verified on chain, `executeMinting` executed
> - Redemption request 44928272 created and read back through `redemptionRequestInfoExt`
> - An `XRPPayment` attestation of our redemption payment accepted on chain by `FdcVerification` in
>   voting round 1422645
>
> **One thing we should flag**, because it came out of this work and may be useful to you
> independently of our request. While testing against request 44928272 we paid an obligation that the
> assigned agent had already paid 36 XRPL ledgers earlier. FAssets reported the request as `ACTIVE`
> the entire time, because confirmation is a separate transaction the agent submits after its payment
> validates and after it obtains an FDC proof. Any integration that treats `ACTIVE` as "unpaid" has
> the same window. We have written it up and mitigated it on our side; details on request.
>
> Happy to provide anything else that helps, and happy to be pointed at a different process if this
> is not the right channel.
>
> Thanks,
> [your name and contact]

---

## Where to send it

I could not verify a current, official whitelist request channel from the pinned sources, and I am
not going to invent one. The pinned developer-hub documents state the governance requirement but do
not name a request address or form.

In rough order of likelihood, based on how Flare handles other access requests:

1. Flare's Discord, in the FAssets or developer support channel. This is where FAssets agent
   operators are usually directed.
2. The Flare Developer Hub repository on GitHub, as an issue asking for the correct process. Slow,
   but public and citable.
3. Any direct Flare Foundation contact you already have from the hackathon or grant side. For a
   governance-gated action, a named human is worth more than a general channel.

If you tell me which channel you use and what they answer, I can adjust the message.
