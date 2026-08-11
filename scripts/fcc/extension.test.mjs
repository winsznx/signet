#!/usr/bin/env node
/**
 * Signet's FCC extension, against the extension contract and against itself.
 *
 * An organizer asked for the XRPL payment to be derived "inside FCC". Before this existed, Signet's
 * decision ran as a CLI reading stdin, which is not FCC in any sense the protocol means. This tests
 * the thing that actually satisfies the contract: an HTTP extension a tee-node can drive, returning
 * an ActionResult the node signs.
 *
 * Two kinds of assertion, and the second matters more.
 *
 * **Contract compliance.** 200 with an ActionResult whenever a handler ran, including when it
 * failed; 501 for an unregistered op-type or command; 400 for a malformed body. Failure is signalled
 * by `ActionResult.status`, never by the HTTP status.
 *
 * **One decision, two transports.** The FCC path and the CLI path must produce byte-identical
 * decisions for the same input. If they can differ then the 76 frozen fixtures cover the CLI and not
 * the thing FCC runs, and the fixture set would be measuring the wrong binary.
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/source-lock.mjs";

const PORT = Number(process.env.SIGNET_FCC_PORT ?? 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const FCC = join(REPO_ROOT, ".runtime", "lifecycle", "signet-fcc-extension");
const CLI = join(REPO_ROOT, ".runtime", "lifecycle", "signet-extension");

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

/** The same decision through the CLI, for comparison. */
function viaCli(inputJson) {
  try {
    return JSON.parse(execFileSync(CLI, [], { input: inputJson, encoding: "utf8" }));
  } catch (error) {
    if (error.status === 2) return JSON.parse(error.stdout);
    throw error;
  }
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

// ---------------------------------------------------------------- one decision, two transports

const fixtures = JSON.parse(
  readFileSync(join(REPO_ROOT, "reference", "test-vectors", "decision-fixtures-v2.json"), "utf8"),
);

const cases = [
  "valid-standard-memo",
  "refuse-payment-already-observed-incident-44928272",
  "refuse-underlying-sources-disagree",
  "refuse-underlying-observation-stale",
  "refuse-expired-window",
  "refuse-wrong-agent",
];

for (const id of cases) {
  const fixture = fixtures.fixtures.find((f) => f.id === id);
  if (!fixture) {
    check(`fixture ${id} exists`, false);
    continue;
  }
  const inputJson = JSON.stringify(fixture.input);
  const { status, text } = await post(action(OP_TYPE, COMMAND_AUTHORIZE, inputJson));
  const result = JSON.parse(text);
  const data = JSON.parse(Buffer.from(result.data.replace(/^0x/, ""), "hex").toString("utf8"));
  const cli = viaCli(inputJson);

  check(`${id}: FCC returns 200 with an ActionResult`, status === 200 && result.status === 1, result.log);
  check(
    `${id}: the FCC decision equals the CLI decision`,
    data.kind === cli.kind &&
      data.obligationHash === cli.obligationHash &&
      (data.authorizationCommitment ?? "") === (cli.authorizationCommitment ?? "") &&
      (data.reason ?? "") === (cli.reason ?? ""),
    `${data.kind}${data.reason ? ` ${data.reason}` : ""}`,
  );
  check(
    `${id}: the FCC decision equals the frozen fixture`,
    data.kind === fixture.expected.kind && (data.reason ?? "") === (fixture.expected.reason ?? ""),
    `expected ${fixture.expected.kind}${fixture.expected.reason ? ` ${fixture.expected.reason}` : ""}`,
  );
  if (data.kind === "authorize") {
    check(
      `${id}: the payment derived inside FCC is the obligation's`,
      data.payment.Destination === fixture.input.redemption.paymentAddress &&
        String(BigInt(data.payment.Amount)) ===
          String(BigInt(fixture.input.redemption.valueUBA) - BigInt(fixture.input.redemption.feeUBA)),
      `${data.payment.Amount} drops to ${data.payment.Destination}`,
    );
  }
}

// ---------------------------------------------------------------- the incident, through FCC

{
  const fixture = fixtures.fixtures.find((f) => f.id === "refuse-payment-already-observed-incident-44928272");
  const { text } = await post(action(OP_TYPE, COMMAND_AUTHORIZE, JSON.stringify(fixture.input)));
  const result = JSON.parse(text);
  const data = JSON.parse(Buffer.from(result.data.replace(/^0x/, ""), "hex").toString("utf8"));
  check(
    "incident 44928272 is refused inside the FCC extension, not only in the CLI",
    data.kind === "refuse" && data.reason === "S021_PAYMENT_ALREADY_OBSERVED",
    data.reason,
  );
  check("a refusal through FCC carries no authorization commitment", !data.authorizationCommitment);
  check(
    "a refusal is a successful handler run, not a handler failure",
    result.status === 1 && result.log === "ok",
    `status=${result.status} log=${result.log}`,
  );
}

server.kill();
console.log(`\n${failures === 0 ? "the FCC extension satisfies its contract and agrees with the audited decision" : `${failures} FCC checks failed`}`);
process.exit(failures === 0 ? 0 : 1);
