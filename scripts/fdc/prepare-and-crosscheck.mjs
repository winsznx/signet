#!/usr/bin/env node
/**
 * Builds the FDC attestation request for a validated XRPL payment and checks that what FDC says
 * about that payment is what FAssets will require when the redemption is confirmed.
 *
 * This closes the loop that the product depends on:
 *
 *   FAssets obligation -> XRPL payment -> FDC response -> FAssets confirmation
 *
 * and it does so without spending gas. Submitting the request to FdcHub and retrieving the Merkle
 * proof are payable operations and are the part of this seam that is still blocked.
 *
 * The checks below are taken from the pinned FAssets source, not from the PRD:
 * `RedemptionConfirmationsFacet._confirmRedemptionPayment` and `._validatePayment`.
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3";
import { REPO_ROOT } from "../lib/source-lock.mjs";
import { redemptionPaymentReference } from "../../reference/src/payment-reference.ts";
import { toHex } from "../../reference/src/bytes.ts";

const VERIFIER = "https://fdc-verifiers-testnet.flare.network/verifier/xrp/XRPPayment";
/** Documented public key for the testnet verifiers, from the official FDC walkthrough. */
const VERIFIER_API_KEY = "00000000-0000-0000-0000-000000000000";

const ATTESTATION_TYPE = `0x${Buffer.from("XRPPayment", "utf8").toString("hex").padEnd(64, "0")}`;
const SOURCE_ID = `0x${Buffer.from("testXRP", "utf8").toString("hex").padEnd(64, "0")}`;

const receiptPath = process.argv[2];
if (!receiptPath) {
  console.error("usage: prepare-and-crosscheck.mjs <evidence/receipts/xrpl-payment-*.json>");
  process.exit(1);
}
const receipt = JSON.parse(readFileSync(join(REPO_ROOT, receiptPath), "utf8"));
const transactionId = `0x${receipt.txHash.toLowerCase()}`;
const proofOwner = "0x88f61BcDC3C0Cfe4E12dc0576960bcF3ECa88F7d";

async function verifier(path, body) {
  const response = await fetch(`${VERIFIER}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": VERIFIER_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

const requestBody = { attestationType: ATTESTATION_TYPE, sourceId: SOURCE_ID, requestBody: { transactionId, proofOwner } };

const prepared = await verifier("prepareRequest", requestBody);
const answered = await verifier("prepareResponse", requestBody);

if (prepared.status !== "VALID" || answered.status !== "VALID") {
  console.error(`verifier did not consider the payment valid: ${prepared.status} / ${answered.status}`);
  process.exit(1);
}

const rb = answered.response.responseBody;

/** FAssets hashes the underlying address string with keccak to compare addresses. */
const standardAddressHash = (address) => toHex(keccak_256(new TextEncoder().encode(address)));

// The obligation this payment was built for.
const requestId = BigInt(receipt.requestId);
const expectedReference = toHex(redemptionPaymentReference(requestId));
const expectedAmountDrops = BigInt(receipt.template.Amount);

const checks = [
  {
    name: "FDC found the payment in a validated ledger",
    expected: `blockNumber ${receipt.validatedLedger}`,
    observed: `blockNumber ${rb.blockNumber}`,
    pass: Number(rb.blockNumber) === Number(receipt.validatedLedger),
  },
  {
    name: "transaction status is success",
    expected: "status 0",
    observed: `status ${rb.status}`,
    pass: rb.status === "0",
  },
  {
    name: "source is the bound agent account (FAssets: sourceAddressHash == agent.underlyingAddressHash)",
    expected: standardAddressHash(receipt.template.Account),
    observed: rb.sourceAddressHash,
    pass: rb.sourceAddressHash.toLowerCase() === standardAddressHash(receipt.template.Account).toLowerCase(),
  },
  {
    name: "destination is the obligation destination (FAssets: intendedReceivingAddressHash == redeemerUnderlyingAddressHash)",
    expected: standardAddressHash(receipt.template.Destination),
    observed: rb.intendedReceivingAddressHash,
    pass:
      rb.intendedReceivingAddressHash.toLowerCase() === standardAddressHash(receipt.template.Destination).toLowerCase(),
  },
  {
    name: "memo carries exactly the FAssets payment reference",
    expected: expectedReference,
    observed: rb.firstMemoData,
    pass: rb.hasMemoData === true && rb.firstMemoData.toLowerCase() === expectedReference.toLowerCase(),
  },
  {
    name: "received amount satisfies the FAssets floor (intendedReceivedAmount >= valueUBA - feeUBA)",
    expected: `>= ${expectedAmountDrops}`,
    observed: rb.intendedReceivedAmount,
    pass: BigInt(rb.intendedReceivedAmount) >= expectedAmountDrops,
  },
  {
    name: "received amount is exact, not merely sufficient",
    expected: `${expectedAmountDrops}`,
    observed: rb.receivedAmount,
    pass: BigInt(rb.receivedAmount) === expectedAmountDrops,
  },
  {
    name: "spent amount is the payment plus its fee and nothing else",
    expected: `${expectedAmountDrops + BigInt(receipt.template.Fee)}`,
    observed: rb.spentAmount,
    pass: BigInt(rb.spentAmount) === expectedAmountDrops + BigInt(receipt.template.Fee),
  },
  {
    name: "no destination tag on a memo-mode obligation",
    expected: "hasDestinationTag false",
    observed: `hasDestinationTag ${rb.hasDestinationTag}`,
    pass: rb.hasDestinationTag === false,
  },
  {
    name: "the encoded request commits to this transaction and this proof owner",
    expected: `${transactionId.slice(2)} + ${proofOwner.slice(2).toLowerCase()}`,
    observed: "present in abiEncodedRequest",
    pass:
      prepared.abiEncodedRequest.toLowerCase().includes(transactionId.slice(2)) &&
      prepared.abiEncodedRequest.toLowerCase().includes(proofOwner.slice(2).toLowerCase()),
  },
];

for (const c of checks) {
  console.log(`${c.pass ? "ok  " : "FAIL"} ${c.name}\n       expected ${c.expected}\n       observed ${c.observed}`);
}

const failed = checks.filter((c) => !c.pass);

mkdirSync(join(REPO_ROOT, "evidence", "receipts"), { recursive: true });
writeFileSync(
  join(REPO_ROOT, "evidence", "receipts", `fdc-request-${receipt.txHash}.json`),
  `${JSON.stringify(
    {
      seam: "fdc",
      network: "coston2 / testXRP",
      preparedAt: new Date().toISOString(),
      attestationType: ATTESTATION_TYPE,
      attestationTypeName: "XRPPayment",
      sourceId: SOURCE_ID,
      sourceIdName: "testXRP",
      transactionId,
      proofOwner,
      abiEncodedRequest: prepared.abiEncodedRequest,
      messageIntegrityCode: `0x${prepared.abiEncodedRequest.slice(2 + 64 + 64, 2 + 64 + 64 + 64)}`,
      fdcResponseBody: rb,
      fassetsCrossChecks: checks,
      notSubmitted: "FdcHub.requestAttestation is payable and needs C2FLR; no request has been submitted and no Merkle proof retrieved",
    },
    null,
    2,
  )}\n`,
);

console.log(`\n${checks.length - failed.length}/${checks.length} cross-checks passed`);
console.log(`receipt evidence/receipts/fdc-request-${receipt.txHash}.json`);
if (failed.length > 0) process.exit(1);
