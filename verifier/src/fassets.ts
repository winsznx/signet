/**
 * Reads a redemption obligation from the Coston2 AssetManager over plain JSON-RPC.
 *
 * Plain `eth_call` rather than a chain library, because this file is the part of the system a
 * skeptic runs, and every dependency it pulls in is something they have to trust. Encoding one
 * function selector and decoding one struct by hand is a smaller ask than auditing a client.
 *
 * Every endpoint is asked and their answers must agree. One endpoint is one party.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import type { ObligationSource } from "./verify.ts";

/** `redemptionRequestInfoExt(uint256)` */
const SELECTOR = `0x${Buffer.from(keccak_256(new TextEncoder().encode("redemptionRequestInfoExt(uint256)")))
  .toString("hex")
  .slice(0, 8)}`;

const STATUS = ["ACTIVE", "DEFAULTED_UNCONFIRMED", "SUCCESSFUL", "DEFAULTED_FAILED", "BLOCKED", "REJECTED"] as const;

function word(data: string, index: number): bigint {
  return BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
}

function address(data: string, index: number): string {
  return `0x${data.slice(2 + index * 64 + 24, 2 + (index + 1) * 64)}`;
}

function stringAt(data: string, wordIndex: number): string {
  const offset = Number(word(data, wordIndex)) / 32;
  const length = Number(word(data, offset));
  const hex = data.slice(2 + (offset + 1) * 64, 2 + (offset + 1) * 64 + length * 2);
  return Buffer.from(hex, "hex").toString("utf8");
}

async function ethCall(endpoint: string, to: string, data: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { result?: string; error?: unknown };
    if (body.error || typeof body.result !== "string" || body.result === "0x") return null;
    return body.result;
  } catch {
    return null;
  }
}

/**
 * The layout of `RedemptionRequestInfo.DataExt`, read positionally.
 *
 * Field indices are asserted against the pinned interface by the verifier's tests rather than being
 * trusted here, because a struct that gains a field would otherwise shift every value silently and
 * the verifier would compare the wrong numbers while reporting success.
 */
export const DATA_EXT_LAYOUT = {
  redemptionRequestId: 0,
  status: 1,
  agentVault: 2,
  redeemer: 3,
  paymentAddress: 4,
  paymentReference: 5,
  valueUBA: 6,
  feeUBA: 7,
} as const;

export function coston2Obligations(
  endpoints: readonly string[],
  assetManager: string,
  fetchImpl: typeof fetch = fetch,
): ObligationSource {
  return {
    async readCanonicalRedemption(requestId: bigint) {
      const data = `${SELECTOR}${requestId.toString(16).padStart(64, "0")}`;
      const answers: string[] = [];
      for (const endpoint of endpoints) {
        const result = await ethCall(endpoint, assetManager, data, fetchImpl);
        if (result) answers.push(result);
      }
      if (answers.length === 0) return null;
      if (answers.some((a) => a !== answers[0])) return null;

      // The returned struct is itself behind an offset word.
      const outer = answers[0]!;
      const structStart = Number(word(outer, 0)) / 32;
      const body = `0x${outer.slice(2 + structStart * 64)}`;

      const statusIndex = Number(word(body, DATA_EXT_LAYOUT.status));
      return {
        status: STATUS[statusIndex] ?? `UNKNOWN_${statusIndex}`,
        agentVault: address(body, DATA_EXT_LAYOUT.agentVault),
        paymentAddress: stringAt(body, DATA_EXT_LAYOUT.paymentAddress),
        valueUBA: word(body, DATA_EXT_LAYOUT.valueUBA),
        feeUBA: word(body, DATA_EXT_LAYOUT.feeUBA),
      };
    },
  };
}
