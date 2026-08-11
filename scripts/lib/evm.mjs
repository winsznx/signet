import { keccak_256 } from "@noble/hashes/sha3";

export function keccak256Hex(bytes) {
  return `0x${Buffer.from(keccak_256(bytes)).toString("hex")}`;
}

export function selectorOf(signature) {
  return keccak256Hex(Buffer.from(signature, "utf8")).slice(0, 10);
}

export function hexToBytes(hex) {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

let rpcId = 0;

export async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

export async function ethCall(url, to, data) {
  return rpc(url, "eth_call", [{ to, data }, "latest"]);
}

/**
 * Scans runtime bytecode for a PUSH4 <selector> immediate.
 * Solidity dispatchers emit exactly that, so a hit is strong evidence the function is
 * implemented by this contract. A miss is expected for proxies, which is why callers
 * must also record a behavioral eth_call result.
 */
export function selectorInRuntimeCode(runtimeHex, selector) {
  const code = runtimeHex.replace(/^0x/, "").toLowerCase();
  return code.includes(`63${selector.replace(/^0x/, "").toLowerCase()}`);
}

export function decodeAddress(word) {
  if (!word || word === "0x") return null;
  const hex = word.replace(/^0x/, "");
  const tail = hex.slice(-40);
  return `0x${tail}`;
}

export function encodeString(value) {
  const bytes = Buffer.from(value, "utf8");
  const padded = Buffer.alloc(Math.ceil(bytes.length / 32) * 32);
  bytes.copy(padded);
  const length = Buffer.alloc(32);
  length.writeUInt32BE(bytes.length, 28);
  return Buffer.concat([length, padded]);
}

export function encodeUint(value) {
  const buf = Buffer.alloc(32);
  const hex = BigInt(value).toString(16).padStart(64, "0");
  Buffer.from(hex, "hex").copy(buf);
  return buf;
}

export function decodeStringArray(returnData) {
  const data = hexToBytes(returnData);
  const offset = Number(BigInt(`0x${data.subarray(0, 32).toString("hex")}`));
  const count = Number(BigInt(`0x${data.subarray(offset, offset + 32).toString("hex")}`));
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const head = offset + 32 + i * 32;
    const itemOffset = offset + 32 + Number(BigInt(`0x${data.subarray(head, head + 32).toString("hex")}`));
    const len = Number(BigInt(`0x${data.subarray(itemOffset, itemOffset + 32).toString("hex")}`));
    out.push(data.subarray(itemOffset + 32, itemOffset + 32 + len).toString("utf8"));
  }
  return out;
}

export function decodeAddressArray(returnData) {
  const data = hexToBytes(returnData);
  const offset = Number(BigInt(`0x${data.subarray(0, 32).toString("hex")}`));
  const count = Number(BigInt(`0x${data.subarray(offset, offset + 32).toString("hex")}`));
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const head = offset + 32 + i * 32;
    out.push(`0x${data.subarray(head + 12, head + 32).toString("hex")}`);
  }
  return out;
}

/**
 * Decodes `(string[], address[])` as returned by IFlareContractRegistry.getAllContracts().
 */
export function decodeNamesAndAddresses(returnData) {
  const data = hexToBytes(returnData);
  const namesOffset = Number(BigInt(`0x${data.subarray(0, 32).toString("hex")}`));
  const addrsOffset = Number(BigInt(`0x${data.subarray(32, 64).toString("hex")}`));

  const nameCount = Number(BigInt(`0x${data.subarray(namesOffset, namesOffset + 32).toString("hex")}`));
  const names = [];
  for (let i = 0; i < nameCount; i += 1) {
    const head = namesOffset + 32 + i * 32;
    const itemOffset = namesOffset + 32 + Number(BigInt(`0x${data.subarray(head, head + 32).toString("hex")}`));
    const len = Number(BigInt(`0x${data.subarray(itemOffset, itemOffset + 32).toString("hex")}`));
    names.push(data.subarray(itemOffset + 32, itemOffset + 32 + len).toString("utf8"));
  }

  const addrCount = Number(BigInt(`0x${data.subarray(addrsOffset, addrsOffset + 32).toString("hex")}`));
  const addresses = [];
  for (let i = 0; i < addrCount; i += 1) {
    const head = addrsOffset + 32 + i * 32;
    addresses.push(`0x${data.subarray(head + 12, head + 32).toString("hex")}`);
  }

  return { names, addresses };
}
