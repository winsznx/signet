# Gate A — attested execution, as a stretch

Status: **not attempted.** Downgraded from a submission blocker to a stretch proof on 2026-08-14.

Gate A is the one thing that would let Signet say the signing key is protected from the host by
hardware. Nothing in this deliverable claims that, anywhere, and the submission is built so that its
absence costs nothing. This file exists so the work can be picked up without rediscovering the
constraints.

## Why it is not in the submission

The blocker is billing, not engineering. The Google Cloud billing account is in prepayment mode and
was not open in time. That is an account state, not a technical obstacle, and waiting on it would
have delayed a package that does not depend on it.

PRD section 29.2 admits a clearly labelled simulated TEE for the Coston2 integration environment, and
section 7.1 admits it for V0. Section 29.3 is the environment gate that requires real attestation,
and this deliverable does not claim to have reached it.

## The hard constraint nobody should rediscover

**Flare's FTDC accepts GCP Confidential Space attestation and nothing else.**

The pinned deployment docs state the expected platform value twice:

- `upstream/fce-sign/DEPLOYMENT_STEPS.md:287` — `platform` must start with `0x4743505f414d445f534556…`
- `upstream/fce-sign/TESTNET_DEPLOYMENT.md:419` — same value, annotated `GCP_AMD_SEV (NOT TEST_PLATFORM)`

That hex is ASCII for `GCP_AMD_SEV`. The consequences:

| substitute | outcome |
|---|---|
| Azure confidential VM (AMD SEV-SNP) | genuine hardware attestation, rejected by FTDC |
| AWS Nitro Enclaves | genuine attestation document, rejected |
| Intel SGX, Phala/dstack, Marlin, Super Protocol | rejected |
| GCP Confidential Space on **Intel TDX** (`c3-standard-*`) | attests fine to Google, **rejected by FTDC**, wrong platform string |

So the machine must be GCP Confidential Space on **AMD SEV-SNP**: `n2d-standard-*` or `c3d-standard-*`
with `--confidential-compute-type=SEV_SNP`. Any setup guide recommending `c3-standard` with Intel TDX
for this purpose is wrong for Flare specifically.

`SIMULATED_TEE=true` yields code hash `0x194844cf…` and platform `TEST_PLATFORM`. FTDC rejects both.
There is no configuration that makes a simulated machine registrable.

## The indexer: use Flare's, do not build one

Phase 00 recorded the extension proxy's indexer database as `SELF_SERVICE_PATH_IDENTIFIED`, on the
reasoning that `flare-system-c-chain-indexer` is public and could be run against the public Coston2
RPC. **Do not do that.** It was a workaround for a problem the current official guide does not have.

The pinned official Flare documentation gives the supported path directly
(`upstream/developer-hub/docs/fcc/guides/00-getting-started.mdx:314`, and the same block in
`01-sign.mdx` and `02-weather-insurance.mdx`):

```toml
[db]
host     = "34.38.42.208"
port     = 3306
database = "indexer"
username = "<your-indexer-db-username>"
password = "<your-indexer-db-password>"
log_queries = false
```

Chain id `114` and the Coston2 system contract addresses are already filled in by the shipped example
files. Credentials are read-only and are obtained by contacting
[Flare support](https://flare.network/resources/technical-support) or
[@FlareDevs](https://x.com/FlareDevs) and saying what you are building.

So the indexer is one support request, not an afternoon of running MySQL and syncing a chain.
`docs/run/ACCESS_STATUS.md` section 3 is corrected accordingly.

## Blocker to clear before any of this

**Fix open finding 1 first.** `SignetFccInstructionSender.authorizeRedemption` gates on
`action.state != NONE` instead of `== REQUESTED`, so an action already moved to `AUTHORIZED` can be
instructed a second time, and the extension cannot catch it because `Prior` is hardcoded to nil.

It is harmless today only because no TEE machine exists: `getRandomTeeIds(66248, 1)` reverts
`0xd65ac61e` before an instruction is sent. **Registering a TEE machine is exactly what arms it.**
Doing gate A without fixing this first would take a latent defect and make it live.

- [ ] Tighten the guard to `!= REQUESTED` with a typed error.
- [ ] Add a Foundry test calling the state-changing `authorizeRedemption` and asserting the revert.
      No current test calls it; the five gate B tests exercise the read-only preview and the selector.
- [ ] Wire `Prior` from durable state and the registry's on-chain action state, per
      `docs/evidence/phase-07.md`. This needs either a schema extension or a registry client in the
      extension, so it is not a one-line change.
- [ ] Redeploy and re-register, which mints a new extension id again.

Full write-up: `docs/threat-model.md`, "Open after gate B".

## Checklist

Prerequisites, in the order they block each other:

- [ ] GCP billing account open. Currently blocked on a $30 prepayment; the credit is applied to the
      account rather than consumed as a fee, and it also releases the $300 trial credit.
- [ ] Read-only Coston2 indexer credentials from Flare support, for `34.38.42.208:3306`.
- [ ] `gcloud` project with `compute`, `confidentialcomputing`, `artifactregistry` and
      `iamcredentials` enabled.

Then the deployment, following `upstream/fce-sign/DEPLOYMENT_STEPS.md`:

- [ ] Build the reproducible extension image with `MODE=0` and `SIMULATED_TEE=false`.
- [ ] Push it to Artifact Registry.
- [ ] Launch a Confidential Space VM, **AMD SEV-SNP machine type**, with a service account holding
      `roles/confidentialcomputing.workloadUser` and Artifact Registry Reader.
- [ ] Pass `INITIAL_OWNER`, `CHAIN_URL`, `EXTENSION_ID`, `PROXY_URL` as workload-launch env. These are
      in the image's `tee.launch_policy.allow_env_override` label, so changing `EXTENSION_ID` needs no
      rebuild.
- [ ] Run `ext-proxy` with the indexer `[db]` block above, publicly reachable on port `6664`. The
      scaffold ships a Cloudflare tunnel path that needs no account, which also satisfies Signet's
      Cloudflare-only hosting rule.
- [ ] Confirm `/info` reports `platform` starting `0x4743505f414d445f534556…`, a real measured
      `codeHash` that is **not** `0x194844cf…`, and the correct `extensionId`.
- [ ] Whitelist the measured code hash and register the TEE machine with FTDC (`post-build.sh`, which
      invokes `register-tee -command rRap`; the capital `R` is load-bearing for re-runs).
- [ ] `getActiveTeeMachines(66248)` returns non-empty.

A second route exists and needs no GCP account: hand the image to Flare devops, who run the
Confidential Space VM themselves (`upstream/fce-sign/TESTNET_DEPLOYMENT.md:349`). It requires a human
at Flare and was not pursued for this deliverable.

## What would change if it lands

Only these, and each is a single edit rather than a rewrite:

| artifact | change |
|---|---|
| `evidence/claim-ledger.json` | `claim-tee-hardware-attested` moves from `unavailable` to `verified` with the measured code hash and the attestation JWT's platform value |
| `deployments/coston2.json` | `fcc.teeMachineRegistered` becomes `true`; `teeMachineNote` replaced by the machine id |
| lifecycle receipts | `attestation` stops reading `"none: the extension ran as a local process"` |
| proof page | the simulated-execution banner is replaced by the measured code hash |
| `docs/threat-model.md` | the gate B residual, currently medium, closes |

Nothing else in the submission depends on it. That separation is deliberate: it is why the package
could be finished today.
