# FCC protocol seam

Status: **partially proven.** The off-chain half is proven end to end. The on-chain half is blocked
on Coston2 gas.
Verified: 2026-08-11.
Pinned source: `flare-foundation/fce-extension-scaffold` @ `ffb6c4ca7c160c49be59e00fe537e24d2477b000`,
`flare-foundation/tee-proxy` @ `d9c2c0ff5f07ed8895823d9485f08bec375bb842`,
`flare-foundation/flare-system-c-chain-indexer` @ `65a3b809eda8930e185d443c82dfcbc35cb14c99`.

## The credential gate does not apply

Both the scaffold README and `docs/deployment-steps.md` say the extension proxy needs a Flare
indexer database, that you should "ask the Flare team for credentials", and that deployment
prerequisites include "VPN access to Flare's indexer DB (`35.241.249.150:3306`)". The shipped
example config carries placeholders only. PRD section 2.1 records this as a day-zero access gate and
section 36.1 says indexer credentials being unavailable stops FCC target-chain work.

That gate is avoidable, and Signet avoids it. The proxy does not need *Flare's* indexer; it needs
*an* indexer database with C-chain signing-policy data. `flare-system-c-chain-indexer` is public and
MIT licensed, resolves contract addresses by name through `ContractRegistry` at startup, runs in
`fsp` mode against any C-chain RPC, and ships the MySQL schema itself.

### Proven, not asserted

Run against the public Coston2 endpoint with no credential of any kind:

```text
FSP startup plan: catchup_from=33922069, latest_confirmed=33924783,
                  backfill_events=true, event_start=33895710
FSP event range filter: 14 entries
  fsp_event_filter: contract=FlareSystemsManager, topic=0xf21722db…
  fsp_event_filter: contract=VoterRegistry,       topic=0x824bc2cc…
  fsp_event_filter: contract=Relay,               topic=0x91d0280e…
  fsp_event_filter: contract=FdcHub,              topic=0xedcf03ee…
  … 14 filters, all resolved by contract name through ContractRegistry
FSP event indexing started: from=33895710, to=33922068
```

and the database it populated:

```text
log_rows  from_block  to_block   contracts
      29    33895710  33899599          7

address                                   block_number  topic0
a90db6d10f856799b10ef2a77ebcbf460ac71e52      33899599  5506337d1266599f8b64…
a90db6d10f856799b10ef2a77ebcbf460ac71e52      33899598  5506337d1266599f8b64…
a90db6d10f856799b10ef2a77ebcbf460ac71e52      33899595  235cef7d085c1e595456…
```

`0xa90db6d1…` is `FlareSystemsManager`, the same address resolved from the registry in Phase 00.

### Reproduce

```bash
cp -R upstream/flare-system-c-chain-indexer .runtime/workspace/c-chain-indexer
cd .runtime/workspace/c-chain-indexer/internal/database/docker && docker compose up -d
cd ../../../ && GOWORK=off go build -o ./flare-cchain-indexer ./cmd/indexer
./flare-cchain-indexer --config config.toml
```

Two things that are not obvious:

- **`log_range` must be 30.** The public Coston2 endpoint caps `eth_getLogs` at 30 blocks. A larger
  value makes every log request fail. Catch-up is correspondingly slow, which is the real cost of
  not having a dedicated node.
- **`GOWORK=off` is required.** The repository root carries a `go.work` with no members yet, and Go
  refuses to build a module outside it without this.

The copy into `.runtime/workspace/` is deliberate: building inside `upstream/` would write artefacts
into a pinned checkout and break its content hash.

## The extension contract

From the scaffold's normative `docs/extension-contract.md`. Signet's extension must satisfy this
exactly, because the node signs `keccak256(ActionResult.data)` and a serialisation difference is
silent until verification fails later.

### HTTP surface

| Endpoint | Contract |
|---|---|
| `POST /action` | 200 with an `ActionResult` whenever the action reached a handler, **including when the handler fails**. Handler failure is signalled by `ActionResult.status`, never by the HTTP status |
| `GET /state` | 200 with a `StateResponse` |
| unregistered `(opType, opCommand)` | 501 |
| malformed body or message | 400 |

### Encoding rules that bite

- `ActionData.message` is **double encoded**: hex-decode it, then parse the result as JSON to get a
  `DataFixed`.
- `opType` and `opCommand` are UTF-8 strings right-padded with zero bytes to 32 bytes. The empty
  bytes32 is meaningful: it registers a wildcard handler for every command under an op-type.
- `ActionResult.version` is a **plain string** (`"0.1.0"`), while `StateResponse.stateVersion` is
  bytes32. The asymmetry is deliberate and the scaffold explicitly warns that the `sign` repo's
  Python and TypeScript ports get it wrong.
- No field is omitted. `data` and `additionalResultStatus` marshal as `"0x"`, never absent or null.
- `data` must be byte-exact across implementations: compact JSON, no whitespace, field declaration
  order preserved.

### Status codes

| `status` | Meaning | Required `log` |
|---|---|---|
| 0 | handler failed | `"error: <message>"` |
| 1 | handler succeeded | `"ok"` |
| other | in progress | `"pending"` |

## What Signet's extension will and will not expose

The scaffold's example registers `SAY_HELLO` and `SAY_GOODBYE` under a `GREETING` op-type. Signet
registers exactly one op-type with the commands PRD section 20.1 fixes:

```text
AUTHORIZE_REDEMPTION
HEALTH_CHECK
PUBLIC_KEY
ROTATION_PREPARE
ROTATION_CONFIRM
```

There is no `SIGN_ARBITRARY` command, and no wildcard handler will be registered: a wildcard under
Signet's op-type would accept any command name, which is the shape of an arbitrary signing endpoint
even if no current caller uses it.

`originalMessage` carries Signet's canonical instruction. Its interpretation is entirely up to the
extension, which is exactly why the canonical binary schema frozen in ADR 0001 matters: the
scaffold imposes no structure, so the structure has to come from us and be identical in all three
languages.

## On-chain half, blocked

| Step | State |
|---|---|
| `FlareTeeManager` diamond resolved and selectors proven | Done in Phase 00 |
| Deploy `SignetActionVerifier` and a minimal instruction sender | **Blocked: needs C2FLR** |
| Register the extension and its code hash | **Blocked: needs C2FLR** |
| Register the TEE machine | **Blocked: needs C2FLR** |
| Send one instruction and retrieve a signed `ActionResult` | **Blocked: needs C2FLR** |
| Verify the result domain on chain | **Blocked: needs C2FLR** |

Every one of these is a state-changing Coston2 transaction. There is no gasless path, and the
Coston2 faucet is captcha-gated with no API, so this is a genuine external boundary rather than a
self-service step not yet attempted. See `docs/run/FUNDING_REQUEST.md`.

Public reachability for our proxy is **not** blocked: the scaffold ships an account-free Cloudflare
tunnel (`docker-compose.cloudflared.yaml`, `--tunnel`), which also happens to satisfy Signet's
Cloudflare-only hosting rule.

## Open items

- The simulated TEE reports code hash `0x194844cf…` and platform `TEST_PLATFORM`. Everywhere this
  appears it must be labelled simulated; it is not hardware attestation.
- `getRandomTeeIds` resolves to a facet the pinned scaffold manifest does not name. Recorded as a
  dated exception in the source lock and due for review before it is used to select a TEE machine.
- The indexer was run long enough to prove it populates the schema, not long enough to serve a full
  signing-policy rollover. Whether the proxy accepts this database is the next thing to prove, and
  it needs the on-chain half.
