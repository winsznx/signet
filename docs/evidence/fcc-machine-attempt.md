# The zero-GCP FCC machine attempt

Date: 2026-08-14
Result: **the extension proxy ran successfully against the shared Coston2 indexer. Machine
registration is blocked by an owner allowlist on the live `MachineManager`, evidenced by an on-chain
revert.** No hardware attestation is claimed. Nothing was left registered.

This was attempted once, retried once cleanly after a credential-variable error, and then stopped,
per the run instruction not to loop on provider infrastructure.

## What worked, and it is worth stating plainly

The self-hosted-indexer question is closed. **No indexer needs to be built.** The shared Coston2
indexer named in the current official guide works, and the proxy synced against it:

| preflight | result |
|---|---|
| Coston2 chain id | `114`, head 34060384 |
| live `FlareTeeManager` | `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`, 184 bytes |
| extension `66248` registered | `getTeeExtensionInstructionsSender(66248)` → `0x7e2dd9078c7d741e0cF81904264A79e70212963a` |
| sender is the gate B + single-dispatch build | selectors `authorizeRedemption(uint256,uint32)`, `canonicalInstructionFor`, `instructionDispatched(bytes32)` all present in deployed runtime |
| `setExtensionId()` binding | sender's own `extensionId()` returns `66248`, agreeing with the registry |
| shared indexer authentication | **OK**, MySQL `8.0.44-google`, database `indexer`, tables `blocks, logs, states, transactions` |
| indexer freshness | head block 34060384, **3 seconds** behind wall clock |
| proxy `/ready` | **healthy** after the TEE node attached |
| proxy `/info` | **healthy**, full `teeInfo` served |
| `lastSigningPolicyId` | **5939** (initial 5937), current |
| governance hash | present in `machineData.governanceHash` |
| code/version hash | present, see below |
| public HTTPS endpoint | **reachable**, Cloudflare quick tunnel, HTTP 200 on `/info` |
| stale Signet TEE machines | **none.** `getActiveTeeMachines` is empty for `66163`, `66164`, `66244` and `66248` |
| routing to an older extension | **none possible**, all superseded extensions have empty active sets |

Credentials live only in `.runtime/fcc/config/proxy/extension_proxy.coston2.docker.toml`, which was
confirmed gitignored with `git check-ignore` **before** it was written. No credential appears in any
tracked file, in evidence, or on the proof site.

## Two boundaries, and they are different

### 1. Machine registration is owner-permissioned — the actual blocker

```text
[FATAL] Error: register() reverted: OwnerNotAllowed
  fccutils.PreRegistration  tools/pkg/fccutils/registration.go:230
  computed TEE ID 3e6e0768795bdc0d12ecf51e06b0a63d283659c0
```

`MachineManager.register()` reverts `OwnerNotAllowed` for deployer
`0x88f61BcDC3C0Cfe4E12dc0576960bcF3ECa88F7d`. Machine registration on the live Coston2 FTDC is gated
on an owner allowlist that Flare maintains. This is not an attestation failure and not a
misconfiguration on our side: every preflight above passed first, and the revert happens at
pre-registration, before attestation is ever evaluated.

A first attempt reverted `OnlyOwner` because the tool reads `DEPLOYMENT_PRIVATE_KEY` and had silently
fallen back to a hardcoded Hardhat dev key. That was a credential-variable error on our side, fixed,
and the clean retry produced `OwnerNotAllowed` from the correct owner address. Both are recorded
because the first one would otherwise look like the same finding and is not.

**Classification: external infrastructure boundary.** Resolving it needs Flare to allow the owner
address, which is not something this deliverable can do or should work around.

### 2. The attestation this machine would have presented is simulated

Untested against FTDC, because boundary 1 stops earlier. Recorded because it is the boundary that
would apply next, and it is measured rather than assumed. Live `/info` from the running node:

| field | observed | what the pinned docs require |
|---|---|---|
| `platform` | `0x544553545f504c4154464f524d…` = **`TEST_PLATFORM`** | must be `0x4743505f414d445f534556…` (`GCP_AMD_SEV`) |
| `codeHash` | `0x194844cf417dde867073e5ab7199fa4d21fd82b5dbe2bdea8b3d7fc18d10fdc2` | must **not** be `0x194844cf…`, which is the documented simulated value |
| `attestation` | `magic_pass` | must be a real GCP Confidential Space JWT |

Sources: `upstream/fce-sign/DEPLOYMENT_STEPS.md:287`, `upstream/fce-sign/TESTNET_DEPLOYMENT.md:419`
and `:471`.

So even with an allowlisted owner, promotion would require a real GCP Confidential Space VM on AMD
SEV-SNP. That remains the gate A stretch: [`../run/GATE_A_STRETCH.md`](../run/GATE_A_STRETCH.md).

## A third boundary, local rather than protocol

The Cloudflare quick tunnel could not establish its default QUIC connection from this network:

```text
ERR Failed to dial a quic connection: timeout: handshake did not complete in time
INF precheck component="TCP Connectivity" details="HTTP/2 connection is blocked or unreachable"
    status=fail target=region1.v2.argotunnel.com
ERROR: Allow outbound TCP on port 7844.
```

Forcing `--protocol http2` produced a working public endpoint on the first try. Recorded because
anyone reproducing this on a restricted network will hit it, and the fix is one flag rather than a
different tunnel.

## What was left behind

**Nothing.** `getActiveTeeMachines(66248)` returns `[]`, every superseded extension is still empty,
and `make doctor` reports the same state as before the attempt. The compose stack and the tunnel were
torn down. The pre-registration write never landed, because it reverted.

## What this does and does not license

| | |
|---|---|
| may say | the extension proxy runs against the current shared Coston2 indexer, synced, with `/ready` and `/info` healthy and `lastSigningPolicyId` current |
| may say | machine registration was attempted on the live chain and refused by an owner allowlist, with the revert recorded |
| may **not** say | that a TEE machine is registered, active, or in production status |
| may **not** say | anything about hardware attestation |
| may **not** say | that an FCC instruction round trip completed |
