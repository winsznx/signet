#!/usr/bin/env node
/**
 * Signet's FCC extension, against the extension contract.
 *
 * NOTE, Gate B: `AUTHORIZE_REDEMPTION` no longer accepts a JSON decision input. It takes the
 * ABI-encoded canonical instruction that `SignetFccInstructionSender` builds from FAssets state, and
 * the extension supplies the XRPL allocation and the underlying observation itself. The
 * decision-equivalence cases that used to live here moved to
 * `extension/internal/fccinput` (payload decoding and the adversarial override set) and to
 * `contracts/test/unit/CanonicalInstruction.t.sol` (the invariant that one request id yields one
 * payload for every caller). What remains here is the wire contract, which is what this file was
 * always for.
 *
 * An organizer asked for the XRPL payment to be derived "inside FCC". Before this existed, Signet's
 * decision ran as a CLI reading stdin, which is not FCC in any sense the protocol means. This tests
 * the thing that actually satisfies the contract: an HTTP extension a tee-node can drive, returning
 * an ActionResult the node signs.
 *
 * What is asserted: 200 with an ActionResult whenever a handler ran, including when it failed; 501
 * for an unregistered op-type or command; 400 for a malformed body; and that a caller-authored
 * obligation no longer decodes at all. Failure is signalled by `ActionResult.status`, never by the
 * HTTP status.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/source-lock.mjs";

const PORT = Number(process.env.SIGNET_FCC_PORT ?? 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const FCC = join(REPO_ROOT, ".runtime", "lifecycle", "signet-fcc-extension");

const OP_TYPE = "SIGNET_REDEMPTION";
const COMMAND_AUTHORIZE = "AUTHORIZE_REDEMPTION";

let failures = 0;
function check(name, ok, note = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${note ? `  ${note}` : ""}`);
}

/** UTF-8, right-padded with zero bytes to 32. The empty bytes32 is a wildcard, so it is never used. */
const toBytes32 = (text) => `0x${Buffer.from(text, "utf8").toString("hex").padEnd(64, "0")}`;

/**
 * Builds an Action. `message` is double encoded by the contract: hex of the JSON DataFixed, whose
 * `originalMessage` is itself the extension's own payload.
 */
function action(opType, opCommand, originalMessage) {
  const fixed = {
    opType: toBytes32(opType),
    opCommand: toBytes32(opCommand),
    originalMessage: `0x${Buffer.from(originalMessage, "utf8").toString("hex")}`,
  };
  return {
    data: {
      id: `0x${"11".repeat(32)}`,
      submissionTag: `0x${"00".repeat(32)}`,
      message: `0x${Buffer.from(JSON.stringify(fixed), "utf8").toString("hex")}`,
    },
  };
}

async function post(body) {
  const response = await fetch(`${BASE}/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  return { status: response.status, text };
}

const server = spawn(FCC, ["-port", String(PORT)], { stdio: "ignore" });
process.on("exit", () => server.kill());
for (let attempt = 0; attempt < 40; attempt += 1) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    const probe = await fetch(`${BASE}/state`, { signal: AbortSignal.timeout(2_000) });
    if (probe.ok) break;
  } catch {
    // still starting
  }
}

// ---------------------------------------------------------------- contract compliance

{
  const response = await fetch(`${BASE}/state`);
  const body = await response.json();
  check("GET /state returns 200", response.status === 200);
  check("stateVersion is a bytes32, not a plain string", /^0x[0-9a-f]{64}$/.test(body.stateVersion), body.stateVersion);
  check("state reports the schema version the policy is on", body.state.schemaVersion === 2, `v${body.state.schemaVersion}`);
}

{
  const { status } = await post(action("WRONG_TYPE", COMMAND_AUTHORIZE, "{}"));
  check("an unregistered op-type is 501", status === 501);
}

{
  const { status } = await post(action(OP_TYPE, "SIGN_ARBITRARY", "{}"));
  check("an unregistered command is 501, so there is no arbitrary signing path", status === 501);
}

{
  // The empty bytes32 registers a wildcard in the scaffold. Signet must not answer it.
  const { status } = await post(action(OP_TYPE, "", "{}"));
  check("the wildcard command is not registered", status === 501);
}

{
  const { status } = await post("not json at all");
  check("a malformed body is 400", status === 400);
}

{
  const { status, text } = await post(action(OP_TYPE, COMMAND_AUTHORIZE, "{ not valid json"));
  const result = JSON.parse(text);
  check("a handler failure is still HTTP 200", status === 200);
  check("a handler failure is signalled by status 0", result.status === 0, `status=${result.status}`);
  check("a failed handler logs the error", result.log.startsWith("error:"), result.log.slice(0, 48));
}

// ---------------------------------------------------------------- the canonical payload is required

{
  // A JSON decision input is what the old, caller-trusting interface took. It must now fail to
  // decode: there is no path left that accepts an obligation somebody else authored.
  const legacy = JSON.stringify({ domain: { schemaVersion: 2 }, redemption: { paymentAddress: "rAttacker" } });
  const { status, text } = await post(action(OP_TYPE, COMMAND_AUTHORIZE, legacy));
  const result = JSON.parse(text);
  check("a caller-authored JSON obligation is rejected", status === 200 && result.status === 0, result.log?.slice(0, 60));
  check(
    "and it is rejected as a decode failure, not as a policy refusal",
    (result.log ?? "").includes("canonical instruction"),
    result.log?.slice(0, 60),
  );
}

server.kill();
console.log(`\n${failures === 0 ? "the FCC extension satisfies its contract and accepts only the canonical payload" : `${failures} FCC checks failed`}`);
process.exit(failures === 0 ? 0 : 1);
