/**
 * The FDC XRPPayment verifier seam.
 *
 * Extracted so the composed lifecycle and the standalone cross-check ask the verifier the same way.
 * Two callers with two hand-rolled request bodies would eventually differ in some field, and the
 * one that differs is the one that stops being evidence.
 */
export const VERIFIER = "https://fdc-verifiers-testnet.flare.network/verifier/xrp/XRPPayment";
/** Documented public key for the testnet verifiers, from the official FDC walkthrough. */
export const VERIFIER_API_KEY = "00000000-0000-0000-0000-000000000000";

export const ATTESTATION_TYPE = `0x${Buffer.from("XRPPayment", "utf8").toString("hex").padEnd(64, "0")}`;
export const SOURCE_ID = `0x${Buffer.from("testXRP", "utf8").toString("hex").padEnd(64, "0")}`;

export async function verifierCall(path, body) {
  const response = await fetch(`${VERIFIER}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": VERIFIER_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

export function requestBodyFor(txHash, proofOwner) {
  return {
    attestationType: ATTESTATION_TYPE,
    sourceId: SOURCE_ID,
    requestBody: { transactionId: `0x${txHash.toLowerCase().replace(/^0x/, "")}`, proofOwner },
  };
}

/**
 * Asks the verifier to both encode a request and answer it.
 *
 * Both calls matter. `prepareRequest` proves the request is well formed; `prepareResponse` proves
 * the verifier can actually see the payment on the XRP ledger. A request that encodes but cannot be
 * answered would be a request FDC will reject later, at a point where it is much harder to explain.
 */
export async function preparePaymentAttestation(txHash, proofOwner = "0x88f61BcDC3C0Cfe4E12dc0576960bcF3ECa88F7d") {
  const body = requestBodyFor(txHash, proofOwner);
  const [prepared, answered] = await Promise.all([
    verifierCall("prepareRequest", body),
    verifierCall("prepareResponse", body),
  ]);
  return {
    status: prepared.status === "VALID" && answered.status === "VALID" ? "VALID" : `${prepared.status}/${answered.status}`,
    abiEncodedRequest: prepared.abiEncodedRequest ?? null,
    response: answered.response ?? null,
  };
}
