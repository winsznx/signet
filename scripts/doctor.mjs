#!/usr/bin/env node
/**
 * Signet FCC doctor. Reads, never mutates.
 *
 * The Flare builder group surfaced the same production failures repeatedly: stale TEE identities,
 * several active machines on one extension, old machines still receiving routing, a registered URL
 * that no longer matches the live identity, a dead tunnel, signing-policy lag, an old extension id,
 * stale availability, and identity changes caused by a restart. Every one of those is visible from
 * public state before it causes a wrong payment, and none of them is visible from any single view.
 *
 * So this asks all of them at once and prints a severity per line.
 *
 * Deliberately absent: any write. There is no --pause, no --deregister, no --fix. An operator
 * command that can both diagnose and mutate gets run reflexively during an incident, which is when
 * mutating is most dangerous. The recovery actions live in docs/runbooks/recovery.md and are run
 * deliberately, by hand.
 *
 *   node scripts/doctor.mjs           human output
 *   node scripts/doctor.mjs --json    machine-readable, same checks
 *
 * Exit codes: 0 if no FAIL, 1 if any FAIL. WARN and UNAVAILABLE do not fail the command, because a
 * diagnostic that exits non-zero for "I could not reach an endpoint" trains people to ignore it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/source-lock.mjs";

export const SEVERITY = { PASS: "PASS", WARN: "WARN", FAIL: "FAIL", UNAVAILABLE: "UNAVAILABLE" };

const deployments = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", "coston2.json"), "utf8"));
const JSON_OUT = process.argv.includes("--json");
const RPC = process.env.COSTON2_RPC_URL ?? deployments.rpc;
const XRPL_ENDPOINTS = (process.env.SIGNET_XRPL_ENDPOINTS ?? "https://testnet.xrpl-labs.com/,https://s.altnet.rippletest.net:51234/")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const results = [];
const record = (area, check, severity, detail) => {
  results.push({ area, check, severity, detail });
  return severity;
};

// ---------------------------------------------------------------- transport

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "rpc error");
  return body.result;
}

/** eth_call with a 4-byte selector and pre-encoded args. Kept dependency-free on purpose: the
 *  doctor has to run from a fresh clone with nothing installed. */
const selectorCache = new Map();
async function selector(signature) {
  if (selectorCache.has(signature)) return selectorCache.get(signature);
  const { createHash } = await import("node:crypto");
  // keccak256 is not in node:crypto, so use the one dependency the repo already pins for it.
  const { keccak_256 } = await import("@noble/hashes/sha3");
  const hex = `0x${Buffer.from(keccak_256(new TextEncoder().encode(signature))).toString("hex").slice(0, 8)}`;
  selectorCache.set(signature, hex);
  return hex;
}
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const addressFromWord = (w) => `0x${w.slice(-40)}`;

async function call(to, signature, args = []) {
  const data = `${await selector(signature)}${args.map(word).join("")}`;
  return rpc("eth_call", [{ to, data }, "latest"]);
}

async function tryCall(to, signature, args = []) {
  try {
    return { ok: true, value: await call(to, signature, args) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** Decode the first dynamic `address[]` in a return blob.
 *
 *  `getActiveTeeMachines` returns two dynamic arrays, not one. An earlier version of this read the
 *  second head word as a length, got 96, and produced 96 empty "machines". Follow the offset in
 *  head word 0 rather than assuming the array starts at a fixed position. */
export function decodeAddressArray(hex) {
  const body = hex.replace(/^0x/, "");
  if (body.length < 128) return [];
  const offset = Number.parseInt(body.slice(0, 64), 16) * 2;
  if (!Number.isFinite(offset) || body.length < offset + 64) return [];
  const count = Number.parseInt(body.slice(offset, offset + 64), 16);
  if (!Number.isFinite(count) || body.length < offset + 64 + count * 64) return [];
  return Array.from({ length: count }, (_, i) =>
    addressFromWord(body.slice(offset + 64 + i * 64, offset + 128 + i * 64)),
  );
}

async function getJson(url, timeoutMs = 8000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, value: await res.json() };
  } catch (error) {
    return { ok: false, error: error.name === "TimeoutError" ? "timeout" : error.message };
  }
}

// ---------------------------------------------------------------- checks

async function checkChain() {
  try {
    const chainId = Number.parseInt(await rpc("eth_chainId"), 16);
    const block = Number.parseInt(await rpc("eth_blockNumber"), 16);
    if (chainId !== deployments.chainId) {
      return record("chain", "chain id", SEVERITY.FAIL, `RPC reports ${chainId}, deployments say ${deployments.chainId}`);
    }
    record("chain", "chain id", SEVERITY.PASS, `${chainId} (${deployments.network}), head ${block}`);
  } catch (error) {
    record("chain", "chain id", SEVERITY.UNAVAILABLE, `RPC unreachable: ${error.message}`);
  }
}

/** A contract address that holds no code is the clearest possible "you are pointed at nothing". */
async function checkContract(area, label, address) {
  if (!address || /^0x0+$/.test(address)) return record(area, label, SEVERITY.WARN, "not set");
  const code = await tryCall(address, "").catch(() => null);
  try {
    const bytecode = await rpc("eth_getCode", [address, "latest"]);
    const bytes = (bytecode.length - 2) / 2;
    if (bytes === 0) return record(area, label, SEVERITY.FAIL, `${address} has no code`);
    return record(area, label, SEVERITY.PASS, `${address} (${bytes} bytes)`);
  } catch (error) {
    void code;
    return record(area, label, SEVERITY.UNAVAILABLE, `${address}: ${error.message}`);
  }
}

async function checkExtensionBinding() {
  const fcc = deployments.fcc ?? {};
  const manager = fcc.flareTeeManager;
  const expected = (fcc.instructionSender ?? "").toLowerCase();
  const extensionId = fcc.extensionId;

  if (!manager || !expected || !extensionId) {
    return record("fcc", "extension binding", SEVERITY.UNAVAILABLE, "deployments/coston2.json has no fcc record");
  }

  const onChain = await tryCall(manager, "getTeeExtensionInstructionsSender(uint256)", [extensionId]);
  if (!onChain.ok) {
    return record("fcc", "extension binding", SEVERITY.UNAVAILABLE, `getTeeExtensionInstructionsSender: ${onChain.error}`);
  }
  const reported = addressFromWord(onChain.value.replace(/^0x/, ""));
  if (reported.toLowerCase() !== expected) {
    return record(
      "fcc",
      "extension binding",
      SEVERITY.FAIL,
      `extension ${extensionId} routes to ${reported}, deployments say ${expected}`,
    );
  }
  record("fcc", "extension binding", SEVERITY.PASS, `extension ${extensionId} -> ${reported}`);

  // The sender's own view must agree, or setExtensionId was never run against this deployment.
  const own = await tryCall(fcc.instructionSender, "extensionId()");
  if (!own.ok) return record("fcc", "InstructionSender extension id", SEVERITY.UNAVAILABLE, own.error);
  const ownId = BigInt(own.value).toString();
  if (ownId !== String(extensionId)) {
    return record(
      "fcc",
      "InstructionSender extension id",
      SEVERITY.FAIL,
      `sender reports ${ownId}, registry says ${extensionId}. setExtensionId was not run, or points at an old extension`,
    );
  }
  record("fcc", "InstructionSender extension id", SEVERITY.PASS, ownId);
}

/** Superseded extensions must not still route anywhere. This is the "old extension id" failure. */
async function checkSupersededExtensions() {
  const fcc = deployments.fcc ?? {};
  const superseded = fcc.superseded ?? [];
  if (superseded.length === 0) return record("fcc", "superseded extensions", SEVERITY.PASS, "none recorded");

  for (const old of superseded) {
    const machines = await tryCall(fcc.flareTeeManager, "getActiveTeeMachines(uint256)", [old.extensionId]);
    if (!machines.ok) {
      record("fcc", `superseded ${old.extensionId}`, SEVERITY.UNAVAILABLE, machines.error);
      continue;
    }
    const active = decodeAddressArray(machines.value);
    if (active.length > 0) {
      record(
        "fcc",
        `superseded ${old.extensionId}`,
        SEVERITY.FAIL,
        `retired extension still has ${active.length} active machine(s): ${active.join(", ")}. It can still receive routing`,
      );
    } else {
      record("fcc", `superseded ${old.extensionId}`, SEVERITY.PASS, "retired, no active machines");
    }
  }
}

/** Decode a returned ABI string, following its offset. Returns "" rather than throwing on anything
 *  malformed, because a diagnostic must not crash on a bad answer from the thing it is diagnosing. */
export function decodeString(hex) {
  const body = (hex ?? "").replace(/^0x/, "");
  if (body.length < 128) return "";
  const offset = Number.parseInt(body.slice(0, 64), 16) * 2;
  if (!Number.isFinite(offset) || body.length < offset + 64) return "";
  const length = Number.parseInt(body.slice(offset, offset + 64), 16);
  if (!Number.isFinite(length) || body.length < offset + 64 + length * 2) return "";
  return Buffer.from(body.slice(offset + 64, offset + 64 + length * 2), "hex").toString("utf8");
}

/** More than one active machine on an extension is the loudest warning this tool has: routing is
 *  non-deterministic and a stale identity can still be selected. */
export function severityOfMachineCount(count, deploymentClaimsMachine) {
  if (count === 0) return deploymentClaimsMachine ? SEVERITY.FAIL : SEVERITY.UNAVAILABLE;
  if (count > 1) return SEVERITY.WARN;
  return SEVERITY.PASS;
}

async function checkMachines() {
  const fcc = deployments.fcc ?? {};
  const machines = await tryCall(fcc.flareTeeManager, "getActiveTeeMachines(uint256)", [fcc.extensionId]);
  if (!machines.ok) {
    return record("machines", "active machine set", SEVERITY.UNAVAILABLE, machines.error);
  }
  const active = decodeAddressArray(machines.value);

  if (active.length === 0) {
    const declared = fcc.teeMachineRegistered === true;
    return record(
      "machines",
      "active machine count",
      declared ? SEVERITY.FAIL : SEVERITY.UNAVAILABLE,
      declared
        ? "deployments claim a registered machine, the chain reports none"
        : "0 machines. No attested execution, and no FCC instruction can be dispatched. This matches deployments/coston2.json",
    );
  }

  // More than one is the single loudest warning this tool has. One extension with several live
  // machines means routing is non-deterministic and an old identity can still answer.
  if (active.length > 1) {
    record(
      "machines",
      "active machine count",
      SEVERITY.WARN,
      `${active.length} ACTIVE MACHINES on extension ${fcc.extensionId}: ${active.join(", ")}. ` +
        "Routing is non-deterministic and a stale identity can still be selected. Pause all but the intended one.",
    );
  } else {
    record("machines", "active machine count", SEVERITY.PASS, `1 machine: ${active[0]}`);
  }

  for (const teeId of active) {
    await checkOneMachine(teeId);
  }
}

/** Per-machine identity, and the URL-versus-live-identity comparison that catches a dead tunnel. */
async function checkOneMachine(teeId) {
  const fcc = deployments.fcc ?? {};
  const url = await tryCall(fcc.flareTeeManager, "getTeeMachineUrl(address)", [BigInt(teeId)]);
  if (!url.ok) {
    return record("machines", `${teeId} url`, SEVERITY.UNAVAILABLE, `no registered URL readable: ${url.error}`);
  }
  const registeredUrl = decodeString(url.value);
  if (!registeredUrl) {
    return record("machines", `${teeId} url`, SEVERITY.FAIL, "registered URL is empty");
  }
  record("machines", `${teeId} url`, SEVERITY.PASS, registeredUrl);

  const info = await getJson(`${registeredUrl.replace(/\/$/, "")}/info`);
  if (!info.ok) {
    return record(
      "machines",
      `${teeId} /info`,
      SEVERITY.FAIL,
      `registered URL is not answering (${info.error}). A dead tunnel leaves an active machine on chain that cannot serve`,
    );
  }
  const machineData = info.value.machineData ?? {};
  record("machines", `${teeId} code hash`, SEVERITY.PASS, machineData.codeHash ?? "not reported");
  record("machines", `${teeId} platform`, SEVERITY.PASS, machineData.platform ?? "not reported");

  const liveIdentity = (machineData.teeId ?? machineData.machineId ?? "").toLowerCase();
  if (!liveIdentity) {
    record("machines", `${teeId} identity match`, SEVERITY.UNAVAILABLE, "/info reports no teeId to compare");
  } else if (liveIdentity !== teeId.toLowerCase()) {
    record(
      "machines",
      `${teeId} identity match`,
      SEVERITY.FAIL,
      `the URL registered for ${teeId} is served by ${liveIdentity}. A restart changed the identity and the registration was not updated`,
    );
  } else {
    record("machines", `${teeId} identity match`, SEVERITY.PASS, "registered URL serves the registered identity");
  }

  const declaredExtension = String(machineData.extensionId ?? "");
  if (declaredExtension && declaredExtension !== String(fcc.extensionId)) {
    record(
      "machines",
      `${teeId} extension id`,
      SEVERITY.FAIL,
      `machine reports extension ${declaredExtension}, deployment is ${fcc.extensionId}`,
    );
  }

  const attestation = info.value.attestation;
  if (!attestation || attestation === "magic_pass") {
    record("machines", `${teeId} attestation`, SEVERITY.WARN, "simulated or absent. Not hardware-attested");
  } else {
    record("machines", `${teeId} attestation`, SEVERITY.PASS, "attestation token present (validity not checked here)");
  }
}

/** Signing-policy freshness.
 *
 *  Relay exposes several accessors and not all of them are present on every deployment, so try the
 *  ones that exist and report UNAVAILABLE rather than guessing. Lag here is what makes an FDC round
 *  fail to finalize, which is why an operator wants it visible next to everything else. */
async function checkSigningPolicy() {
  const relay = deployments.protocol?.relay?.address;
  if (!relay) return record("fsp", "signing policy", SEVERITY.UNAVAILABLE, "no Relay address in deployments");

  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const [signature, args, label] of [
    ["getVotingRoundId(uint256)", [nowSeconds], "current voting round"],
    ["lastInitializedVotingRoundId()", [], "last initialized voting round"],
  ]) {
    const attempt = await tryCall(relay, signature, args);
    if (attempt.ok && attempt.value && attempt.value !== "0x") {
      return record("fsp", label, SEVERITY.PASS, BigInt(attempt.value).toString());
    }
  }
  record(
    "fsp",
    "signing policy",
    SEVERITY.UNAVAILABLE,
    "Relay exposed no readable voting-round accessor; signing-policy lag could not be assessed from here",
  );
}

async function checkSignetBinding() {
  const signet = deployments.signet ?? {};
  await checkContract("signet", "SignetRegistry", signet.registry);
  await checkContract("signet", "SignetInstructionSender", signet.instructionSender);
  await checkContract("fcc", "SignetFccInstructionSender", deployments.fcc?.instructionSender);
  await checkContract("fcc", "FlareTeeManager", deployments.fcc?.flareTeeManager);
}

async function checkFdc() {
  await checkContract("fdc", "FdcHub", deployments.protocol?.["fdc-hub"]?.address);
  await checkContract("fdc", "FdcVerification", deployments.protocol?.["fdc-verification"]?.address);
}

async function checkXrpl() {
  const source = process.env.SIGNET_XRPL_SOURCE ?? null;
  const answers = [];
  for (const endpoint of XRPL_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "server_info", params: [{}] }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json();
      const info = body?.result?.info;
      answers.push({ endpoint, networkId: info?.network_id, ledger: info?.validated_ledger?.seq });
    } catch (error) {
      answers.push({ endpoint, error: error.name === "TimeoutError" ? "timeout" : error.message });
    }
  }

  const live = answers.filter((a) => !a.error);
  if (live.length === 0) {
    return record("xrpl", "endpoint reachability", SEVERITY.UNAVAILABLE, "no XRPL endpoint answered");
  }
  // Reconciliation needs two independent endpoints that agree. One answering is not enough to
  // testify to absence, which is the property the observer depends on.
  if (live.length < 2) {
    record(
      "xrpl",
      "endpoint agreement",
      SEVERITY.WARN,
      `only ${live.length} of ${XRPL_ENDPOINTS.length} endpoints answered. Absence cannot be established from one source`,
    );
  } else {
    const networks = new Set(live.map((a) => a.networkId));
    const ledgers = live.map((a) => a.ledger).filter(Number.isFinite);
    const spread = ledgers.length > 1 ? Math.max(...ledgers) - Math.min(...ledgers) : 0;
    if (networks.size > 1) {
      record("xrpl", "endpoint agreement", SEVERITY.FAIL, `endpoints disagree on network id: ${[...networks].join(", ")}`);
    } else if (spread > 20) {
      record("xrpl", "endpoint agreement", SEVERITY.WARN, `ledger spread of ${spread} between endpoints; one is lagging`);
    } else {
      record("xrpl", "endpoint agreement", SEVERITY.PASS, `${live.length} endpoints, network ${[...networks][0]}, spread ${spread} ledgers`);
    }
  }

  if (!source) {
    return record("xrpl", "source account", SEVERITY.UNAVAILABLE, "set SIGNET_XRPL_SOURCE to check the funding of the signing account");
  }
  const endpoint = live[0].endpoint;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "account_info", params: [{ account: source, ledger_index: "validated" }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json();
    const drops = body?.result?.account_data?.Balance;
    if (!drops) return record("xrpl", "source account", SEVERITY.WARN, `${source}: ${body?.result?.error ?? "not found"}`);
    const xrp = Number(drops) / 1e6;
    record("xrpl", "source account", xrp < 20 ? SEVERITY.WARN : SEVERITY.PASS, `${source}: ${xrp} XRP${xrp < 20 ? " (low; a payment plus reserve may not fit)" : ""}`);
  } catch (error) {
    record("xrpl", "source account", SEVERITY.UNAVAILABLE, error.message);
  }
}

// ---------------------------------------------------------------- run

export async function runDoctor() {
  results.length = 0;
  await checkChain();
  await checkSignetBinding();
  await checkExtensionBinding();
  await checkSupersededExtensions();
  await checkMachines();
  await checkSigningPolicy();
  await checkFdc();
  await checkXrpl();
  return results;
}

const COLOURS = { PASS: "[32m", WARN: "[33m", FAIL: "[31m", UNAVAILABLE: "[90m" };
const RESET = "[0m";

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await runDoctor();
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.severity]: (acc[r.severity] ?? 0) + 1 }), {});

  if (JSON_OUT) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), network: deployments.network, counts, results: rows }, null, 2));
  } else {
    let area = "";
    for (const r of rows) {
      if (r.area !== area) {
        area = r.area;
        console.log(`\n${area}`);
      }
      const colour = process.stdout.isTTY ? COLOURS[r.severity] : "";
      const reset = process.stdout.isTTY ? RESET : "";
      console.log(`  ${colour}${r.severity.padEnd(11)}${reset} ${r.check.padEnd(34)} ${r.detail}`);
    }
    console.log(
      `\n${counts.PASS ?? 0} pass, ${counts.WARN ?? 0} warn, ${counts.FAIL ?? 0} fail, ${counts.UNAVAILABLE ?? 0} unavailable`,
    );
    if (counts.FAIL) console.log("\nRecovery procedures: docs/runbooks/recovery.md. This command does not mutate anything.");
  }

  process.exit(counts.FAIL ? 1 : 0);
}
