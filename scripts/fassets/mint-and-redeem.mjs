#!/usr/bin/env node
/**
 * Creates a real Coston2 FAssets redemption, without being an agent.
 *
 * The agent whitelist is a governance gate we cannot pass. Minting is not gated: anyone holding
 * C2FLR can reserve collateral against an existing agent, pay that agent in underlying XRP, prove
 * the payment through FDC, and receive FXRP. Holding FXRP is all `redeem` requires.
 *
 * So this walks the whole minter path on the real chain:
 *
 *   reserveCollateral -> pay the agent on XRPL Testnet -> FDC proof -> executeMinting -> redeem
 *
 * and the redemption that falls out is a genuine Coston2 obligation: publicly readable by anyone,
 * assigned to a real agent, with a payment window FAssets chose. That is the thing phase 09 could
 * only simulate on a fork, and the thing the independent verifier could previously only report as
 * UNVERIFIABLE.
 *
 * It stops short of completing the redemption. Confirming a redemption payment requires the payment
 * to come from the agent's own underlying address, which is precisely what the whitelist guards.
 * That step is left undone rather than faked.
 *
 * Every step is checkpointed to `.runtime/fassets-mint.json`. The XRPL payment in the middle costs
 * real testnet XRP, and a crash after it that restarted from the top would pay twice.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "xrpl";
import { REPO_ROOT, readSourceLock } from "../lib/source-lock.mjs";
import { accountInfo, currentFeeDrops, validatedLedger } from "../xrpl/client.mjs";
import { persistBeforeSubmit, reconcile, submitPersisted } from "../xrpl/submit.mjs";
import { proveOnChain } from "../fdc/prove.mjs";

const FOUNDRY = `${process.env.HOME}/.foundry/bin`;
const lock = readSourceLock();
const RPC = process.env.COSTON2_RPC_URL ?? lock.networks.coston2.rpc[0];
const ASSET_MANAGER = lock.contracts.find((c) => c.id === "asset-manager-fxrp").address;
const STATE_PATH = join(REPO_ROOT, ".runtime", "fassets-mint.json");

/** keccak256("CollateralReserved(address,address,uint256,uint256,uint256,uint256,uint256,uint256,string,bytes32,address,uint256)") */
const COLLATERAL_RESERVED = "0xd6b6b1ce0b7c1e8d3f2d0e4c5a9b8f7e6d5c4b3a291807f6e5d4c3b2a1908070";

const SECRET_PATH = join(REPO_ROOT, ".runtime", "secrets", "coston2-deployer.json");
function loadKey() {
  if (!existsSync(SECRET_PATH)) throw new Error(`no deployer key at ${SECRET_PATH.replace(REPO_ROOT, ".")}`);
  const parsed = JSON.parse(readFileSync(SECRET_PATH, "utf8"));
  const holder = Array.isArray(parsed) ? parsed[0] : parsed;
  const key = holder?.private_key ?? holder?.privateKey;
  if (typeof key !== "string") throw new Error("no private key field in the deployer secret");
  return key.startsWith("0x") ? key : `0x${key}`;
}
const PRIVATE_KEY = loadKey();

function cast(args) {
  try {
    return execFileSync("cast", [...args, "--rpc-url", RPC], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` },
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const text = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`.split(PRIVATE_KEY).join("<redacted>");
    throw new Error(text);
  }
}

const send = (to, sig, args, value = null) =>
  JSON.parse(
    cast([
      "send",
      to,
      sig,
      ...args.map(String),
      ...(value ? ["--value", String(value)] : []),
      "--private-key",
      PRIVATE_KEY,
      "--json",
    ]),
  );

const word = (data, i) => BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
function stringAt(data, i) {
  const offset = Number(word(data, i)) / 32;
  const length = Number(word(data, offset));
  return Buffer.from(data.slice(2 + (offset + 1) * 64, 2 + (offset + 1) * 64 + length * 2), "hex").toString("utf8");
}

const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : {};
const save = () => writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);

const minter = execFileSync("cast", ["wallet", "address", "--private-key", PRIVATE_KEY], {
  encoding: "utf8",
  env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` },
}).trim();

const source = JSON.parse(readFileSync(join(REPO_ROOT, ".runtime", "xrpl", "agent-source.public.json"), "utf8"));
const destination = JSON.parse(
  readFileSync(join(REPO_ROOT, ".runtime", "xrpl", "redeemer-destination.public.json"), "utf8"),
);

console.log(`minter ${minter}`);
console.log(`xrpl   ${source.classicAddress}\n`);

// ---------------------------------------------------------------- 1. reserve collateral

if (!state.reservation) {
  const agentVault = process.env.SIGNET_AGENT_VAULT ?? "0xd5defe2c62d48788bb3889534fbfe7aea0602d64";
  const lots = Number(process.env.SIGNET_LOTS ?? 1);
  const fee = cast(["call", ASSET_MANAGER, "collateralReservationFee(uint256)(uint256)", String(lots)]).split(" ")[0];
  console.log(`reserving ${lots} lot(s) against ${agentVault}, fee ${(Number(fee) / 1e18).toFixed(6)} C2FLR`);

  const receipt = send(
    ASSET_MANAGER,
    "reserveCollateral(address,uint256,uint256,address)",
    [agentVault, lots, "25", "0x0000000000000000000000000000000000000000"],
    fee,
  );
  if (receipt.status !== "0x1") throw new Error("reserveCollateral reverted");

  // The event is found by shape rather than by a hardcoded topic hash: it is the only log from the
  // AssetManager with three indexed fields and a payload long enough to carry the address string.
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === ASSET_MANAGER.toLowerCase() && l.topics.length === 4 && l.data.length > 600,
  );
  if (!log) throw new Error(`reserveCollateral produced no CollateralReserved event in ${receipt.transactionHash}`);

  state.reservation = {
    transactionHash: receipt.transactionHash,
    block: Number(BigInt(receipt.blockNumber)),
    agentVault: `0x${log.topics[1].slice(26)}`,
    minter: `0x${log.topics[2].slice(26)}`,
    collateralReservationId: word(log.topics[3], 0).toString(),
    valueUBA: word(log.data, 0).toString(),
    feeUBA: word(log.data, 1).toString(),
    firstUnderlyingBlock: word(log.data, 2).toString(),
    lastUnderlyingBlock: word(log.data, 3).toString(),
    lastUnderlyingTimestamp: word(log.data, 4).toString(),
    paymentAddress: stringAt(log.data, 5),
    paymentReference: `0x${log.data.slice(2 + 6 * 64, 2 + 7 * 64)}`,
  };
  save();
}

const r = state.reservation;
const owedDrops = BigInt(r.valueUBA) + BigInt(r.feeUBA);
console.log(`reservation ${r.collateralReservationId}`);
console.log(`  pay ${owedDrops} drops to ${r.paymentAddress}`);
console.log(`  reference ${r.paymentReference}`);
console.log(`  window until underlying block ${r.lastUnderlyingBlock}\n`);

// ---------------------------------------------------------------- 2. pay the agent on XRPL

if (!state.underlyingPayment) {
  const regularKey = JSON.parse(
    readFileSync(join(REPO_ROOT, ".runtime", "secrets", "xrpl-signet-regular-key.json"), "utf8"),
  );
  const [info, ledger, fees] = await Promise.all([
    accountInfo(source.classicAddress),
    validatedLedger(),
    currentFeeDrops(),
  ]);
  const feeDrops = fees.openLedgerFeeDrops > fees.baseFeeDrops ? fees.openLedgerFeeDrops : fees.baseFeeDrops;

  const tx = {
    TransactionType: "Payment",
    Account: source.classicAddress,
    Destination: r.paymentAddress,
    Amount: owedDrops.toString(),
    Fee: feeDrops.toString(),
    Flags: 0,
    Sequence: info.account_data.Sequence,
    LastLedgerSequence: ledger.index + 40,
    Memos: [{ Memo: { MemoData: r.paymentReference.slice(2).toUpperCase() } }],
  };

  const wallet = Wallet.fromSeed(regularKey.seed, { algorithm: "ed25519" });
  const signed = wallet.sign(tx);

  persistBeforeSubmit({
    purpose: "FAssetsMintingUnderlyingPayment",
    network: "xrpl-testnet",
    requestId: r.collateralReservationId,
    obligationHash: r.paymentReference,
    authorizationCommitment: r.paymentReference,
    txTemplate: tx,
    txHash: signed.hash,
    txBlob: signed.tx_blob,
    signedBy: "regular-key",
    signerPublicKey: regularKey.publicKey,
    sequence: tx.Sequence,
    lastLedgerSequence: tx.LastLedgerSequence,
    feeDrops: feeDrops.toString(),
    builtAt: new Date().toISOString(),
  });
  state.underlyingPayment = { txHash: signed.hash, amountDrops: owedDrops.toString() };
  save();

  const provisional = await submitPersisted(signed.hash);
  console.log(`paid the agent: ${signed.hash} (${provisional.engineResult}, not a result)`);
  const final = await reconcile(signed.hash);
  if (final.state !== "VALIDATED_SUCCESS") throw new Error(`underlying payment did not validate: ${final.state}`);
  state.underlyingPayment.validatedLedger = final.validatedLedger;
  save();
  console.log(`validated in ledger ${final.validatedLedger}\n`);
}

// ---------------------------------------------------------------- 3. prove it through FDC

if (!state.mintingProof) {
  console.log("proving the underlying payment through FDC…");
  // `Payment`, not `XRPPayment`: executeMinting takes IPayment.Proof, and handing it the XRP-specific
  // response shape would decode to a different struct rather than fail.
  state.mintingProof = await proveOnChain({
    txHash: state.underlyingPayment.txHash,
    attestationTypeName: "Payment",
    verifierPath: "verifier/xrp/Payment",
    proofOwner: minter,
    privateKey: PRIVATE_KEY,
    rpc: RPC,
  });
  save();
}
console.log(`proof accepted on chain in round ${state.mintingProof.votingRoundId}\n`);

// ---------------------------------------------------------------- 4. execute minting

if (!state.minting) {
  const receipt = send(ASSET_MANAGER, "executeMinting((bytes32[],(bytes32,bytes32,uint64,uint64,(bytes32,uint256,uint256),(uint64,uint64,bytes32,bytes32,bytes32,bytes32,int256,int256,int256,int256,bytes32,bool,uint8))),uint256)", [
    state.mintingProof.tuple,
    r.collateralReservationId,
  ]);
  if (receipt.status !== "0x1") throw new Error("executeMinting reverted");
  state.minting = { transactionHash: receipt.transactionHash, block: Number(BigInt(receipt.blockNumber)) };
  save();
}
const fAsset = cast(["call", ASSET_MANAGER, "fAsset()(address)"]);
const balance = cast(["call", fAsset, "balanceOf(address)(uint256)", minter]).split(" ")[0];
console.log(`minted. FXRP balance ${balance} UBA (${state.minting.transactionHash})\n`);

// ---------------------------------------------------------------- 5. redeem

if (!state.redemption) {
  const lots = Number(process.env.SIGNET_LOTS ?? 1);
  console.log(`redeeming ${lots} lot(s) to ${destination.classicAddress}…`);
  const receipt = send(ASSET_MANAGER, "redeem(uint256,string,address)", [
    lots,
    destination.classicAddress,
    "0x0000000000000000000000000000000000000000",
  ]);
  if (receipt.status !== "0x1") throw new Error("redeem reverted");

  const REDEMPTION_REQUESTED = "0x8cbbd73a8d1b8b02a53c4c3b0ee34b472fe3099cc19bcfb57f1aae09e8a9847e";
  const log = receipt.logs.find(
    (l) => l.topics[0] === REDEMPTION_REQUESTED && l.address.toLowerCase() === ASSET_MANAGER.toLowerCase(),
  );
  if (!log) throw new Error("redeem produced no RedemptionRequested event");

  state.redemption = {
    transactionHash: receipt.transactionHash,
    block: Number(BigInt(receipt.blockNumber)),
    agentVault: `0x${log.topics[1].slice(26)}`,
    requestId: word(log.topics[3], 0).toString(),
    paymentAddress: stringAt(log.data, 0),
    valueUBA: word(log.data, 1).toString(),
    feeUBA: word(log.data, 2).toString(),
    firstUnderlyingBlock: word(log.data, 3).toString(),
    lastUnderlyingBlock: word(log.data, 4).toString(),
    lastUnderlyingTimestamp: word(log.data, 5).toString(),
    paymentReference: `0x${log.data.slice(2 + 6 * 64, 2 + 7 * 64)}`,
  };
  save();
}

const red = state.redemption;
console.log("a real Coston2 redemption now exists");
console.log(`  requestId    ${red.requestId}`);
console.log(`  agent        ${red.agentVault}`);
console.log(`  destination  ${red.paymentAddress}`);
console.log(`  value/fee    ${red.valueUBA} / ${red.feeUBA} UBA`);
console.log(`  reference    ${red.paymentReference}`);
console.log(`  tx           https://coston2.testnet.flarescan.com/tx/${red.transactionHash}`);
