/**
 * The Flare half of the composed lifecycle.
 *
 * Everything here runs against a fork of Coston2, so the FAssets code executing is the real
 * deployed bytecode rather than a mock. That matters more than it sounds: the obligation Signet
 * signs for is whatever FAssets says it is, and a mock would let a mistake in our reading of
 * FAssets pass unnoticed because the mock would share the mistake.
 *
 * The redemption is created by impersonating a genuine FXRP holder and calling the real `redeem`,
 * with our own XRPL testnet account as the destination. Using our own destination is what makes the
 * XRPL half executable without moving someone else's money.
 */
import { execFileSync } from "node:child_process";

export const COSTON2_CHAIN_ID = 114n;
export const ASSET_MANAGER = "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA";
export const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7";
/**
 * The fork follows the live Coston2 head rather than a fixed block.
 *
 * A fixed block looked more reproducible and is not: the FAssets obligation carries an XRP-ledger
 * payment window, and a fork pinned to yesterday hands out windows that expired hours ago, so the
 * run would refuse for a reason that says nothing about the code. Following the head means the
 * window is as fresh as a real agent's, and the deadline and safety-margin checks do real work.
 * Set SIGNET_FORK_BLOCK to reproduce one specific run; the block actually used is recorded in the
 * run artifact either way.
 */
export function resolveForkBlock(rpc) {
  if (process.env.SIGNET_FORK_BLOCK) return Number(process.env.SIGNET_FORK_BLOCK);
  return Number(cast(["block-number"], { rpc })) - 5;
}

const REDEMPTION_REQUESTED_TOPIC = "0x8cbbd73a8d1b8b02a53c4c3b0ee34b472fe3099cc19bcfb57f1aae09e8a9847e";

export function cast(args, { rpc }) {
  return execFileSync("cast", [...args, "--rpc-url", rpc], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` },
  }).trim();
}

function forge(args) {
  return execFileSync("forge", args, {
    encoding: "utf8",
    env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` },
  });
}

/** `forge create` prints its result as text; the address is the only field we need from it. */
function deploy(contract, args, { rpc, from }) {
  const out = forge([
    "create",
    contract,
    "--rpc-url",
    rpc,
    "--from",
    from,
    "--unlocked",
    "--broadcast",
    ...(args.length ? ["--constructor-args", ...args] : []),
  ]);
  const match = out.match(/Deployed to: (0x[0-9a-fA-F]{40})/);
  if (!match) throw new Error(`could not read deployed address from forge output:\n${out}`);
  return match[1];
}

function send(to, sig, args, { rpc, from }) {
  return cast(["send", to, sig, ...args, "--from", from, "--unlocked"], { rpc });
}

function word(data, index) {
  return BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
}

/**
 * Decodes RedemptionRequested. The string tail is read from its own offset rather than assumed to
 * start at a fixed word, because a fixed offset would silently break the day FAssets adds a field.
 */
function decodeRedemptionRequested(log) {
  const data = log.data;
  const stringOffset = Number(word(data, 0)) / 32;
  const strLen = Number(word(data, stringOffset));
  const strHex = data.slice(2 + (stringOffset + 1) * 64, 2 + (stringOffset + 1) * 64 + strLen * 2);
  return {
    agentVault: `0x${log.topics[1].slice(26)}`,
    redeemer: `0x${log.topics[2].slice(26)}`,
    requestId: BigInt(log.topics[3]),
    paymentAddress: Buffer.from(strHex, "hex").toString("utf8"),
    valueUBA: word(data, 1),
    feeUBA: word(data, 2),
    firstUnderlyingBlock: word(data, 3),
    lastUnderlyingBlock: word(data, 4),
    lastUnderlyingTimestamp: word(data, 5),
    paymentReference: `0x${data.slice(2 + 6 * 64, 2 + 7 * 64)}`,
  };
}

export function anvilAccounts(rpc) {
  return JSON.parse(cast(["rpc", "eth_accounts"], { rpc }));
}

export function impersonate(address, rpc) {
  cast(["rpc", "anvil_impersonateAccount", address], { rpc });
  cast(["rpc", "anvil_setBalance", address, "0x21e19e0c9bab2400000"], { rpc });
}

/** Creates a genuine redemption through the real AssetManager and returns the obligation FAssets
 *  produced. `destination` is our own XRPL testnet account. */
export function createRedemption({ rpc, holder, destination, lots }) {
  impersonate(holder, rpc);
  const receipt = JSON.parse(
    cast(
      [
        "send",
        ASSET_MANAGER,
        "redeem(uint256,string,address)(uint256)",
        String(lots),
        destination,
        "0x0000000000000000000000000000000000000000",
        "--from",
        holder,
        "--unlocked",
        "--json",
      ],
      { rpc },
    ),
  );
  const log = receipt.logs.find(
    (l) => l.topics[0] === REDEMPTION_REQUESTED_TOPIC && l.address.toLowerCase() === ASSET_MANAGER.toLowerCase(),
  );
  if (!log) {
    throw new Error(
      `redeem produced no RedemptionRequested event; status=${receipt.status} logs=${receipt.logs.map((l) => l.topics[0]).join(",")}`,
    );
  }
  return { ...decodeRedemptionRequested(log), transactionHash: receipt.transactionHash };
}

/** Reads the obligation back through the adapter's own path, which is the read Signet trusts. */
export function readRedemptionInfo(requestId, rpc) {
  const raw = cast(["call", ASSET_MANAGER, "redemptionRequestInfoExt(uint256)", String(requestId)], { rpc });
  return raw;
}

export function deploySignet({ rpc, governance, codeHash, extensionId, policyVersion, signer }) {
  const registry = deploy("contracts/src/SignetRegistry.sol:SignetRegistry", [governance, String(COSTON2_CHAIN_ID)], {
    rpc,
    from: governance,
  });
  const sender = deploy("contracts/src/SignetInstructionSender.sol:SignetInstructionSender", [registry, ASSET_MANAGER], {
    rpc,
    from: governance,
  });
  send(registry, "setInstructionSender(address)", [sender], { rpc, from: governance });
  send(registry, "approveCodeHash(bytes32,uint256,uint32,bool)", [codeHash, String(extensionId), String(policyVersion), "true"], {
    rpc,
    from: governance,
  });
  send(registry, "approveSigner(address,bool)", [signer, "true"], { rpc, from: governance });
  return { registry, sender };
}

export function bindAgent({ rpc, governance, registry, sender, agentVault, xrplSourceAddress, codeHash, extensionId, policyVersion, xrplNetworkId }) {
  const tuple = `(${ASSET_MANAGER},${agentVault},${COSTON2_CHAIN_ID},${sender},${xrplNetworkId},${extensionId},${codeHash},${policyVersion},0,"${xrplSourceAddress}")`;
  send(registry, "bindAgent((address,address,uint256,address,uint32,uint256,bytes32,uint32,uint8,string))", [tuple], {
    rpc,
    from: governance,
  });
  return cast(["call", registry, "bindingIdFor(address,address)(bytes32)", ASSET_MANAGER, agentVault], { rpc });
}

export function requestSignature({ rpc, caller, sender, requestId, agentVault, generation }) {
  const receipt = JSON.parse(
    cast(
      [
        "send",
        sender,
        "requestRedemptionSignature(uint256,address,uint32)(bytes32)",
        String(requestId),
        agentVault,
        String(generation),
        "--from",
        caller,
        "--unlocked",
        "--json",
      ],
      { rpc },
    ),
  );
  if (receipt.status !== "0x1") throw new Error("requestRedemptionSignature reverted");
  const obligationHash = cast(
    ["call", sender, "obligationHashFor(address,uint256,uint32)(bytes32)", agentVault, String(requestId), String(generation)],
    { rpc },
  );
  return { obligationHash, transactionHash: receipt.transactionHash };
}

/** Attempts a call and returns the revert reason instead of throwing, so an attack case can assert
 *  on *why* the chain refused rather than merely that it did. */
export function expectRevert(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    const text = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`;
    const custom = text.match(/custom error '?([A-Za-z0-9_]+)/);
    if (custom) return custom[1];
    const reason = text.match(/revert(?:ed)?:? ?([^\n"]*)/);
    return reason ? reason[1].trim() : text.split("\n")[0];
  }
}
