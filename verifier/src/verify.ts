/**
 * The independent verifier.
 *
 * Its job is to be the party that does not trust us. It reads a receipt from this repository and
 * then goes and checks it against sources this repository does not control: the XRP ledger, the
 * Coston2 AssetManager, and the canonical encoding as implemented by the reference model.
 *
 * Two rules shape everything below.
 *
 * The first is that nothing in the bundle is evidence for itself. A receipt claiming a commitment
 * proves nothing; the commitment is recomputed from the obligation and the payment, and the
 * recomputed value is what gets compared. A receipt claiming the payment reached the ledger proves
 * nothing either; the ledger is asked.
 *
 * The second is that "cannot check" is a distinct outcome from "checked and passed". A receipt
 * whose obligation lives on a local fork is not publicly readable, and the verifier says so instead
 * of quietly counting the checks it could do and calling the bundle verified. A verifier that
 * rounds unverifiable up to verified is worse than no verifier, because it launders the gap.
 *
 * No private credentials. Everything here works from a fresh clone against public endpoints.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import {
  authorizationCommitment,
  obligationHash,
  redemptionPaymentReference,
  toHex,
  type AuthorizationCommitmentFields,
  type ObligationCommitmentFields,
} from "@signet/reference";

export type Outcome = "PASS" | "FAIL" | "UNVERIFIABLE" | "NOT_CLAIMED";

export interface Finding {
  readonly name: string;
  readonly outcome: Outcome;
  readonly expected?: string;
  readonly observed?: string;
  readonly why?: string;
}

export interface VerificationResult {
  readonly receipt: string;
  readonly findings: readonly Finding[];
  readonly verdict: Outcome;
}

const pass = (name: string, observed?: string): Finding =>
  observed === undefined ? { name, outcome: "PASS" } : { name, outcome: "PASS", observed };
const fail = (name: string, expected: string, observed: string): Finding => ({
  name,
  outcome: "FAIL",
  expected,
  observed,
});
const unverifiable = (name: string, why: string): Finding => ({ name, outcome: "UNVERIFIABLE", why });

/**
 * A check the receipt never claimed to satisfy.
 *
 * Some receipts prove a seam rather than a settlement: they borrow a real obligation's payment
 * reference to exercise the XRPL path, and pay an amount and destination of their own choosing. The
 * comparison against FAssets still runs and the difference is still printed, because a reader must
 * be able to see exactly what does not match. What changes is only whether the mismatch condemns
 * the bundle.
 *
 * A receipt has to say so explicitly, with `settles: false`. Silence means it claims settlement, so
 * a receipt can never buy leniency by omitting a field.
 */
const notClaimed = (name: string, expected: string, observed: string): Finding => ({
  name,
  outcome: "NOT_CLAIMED",
  expected,
  observed,
});

/** A single FAIL condemns the bundle; otherwise any UNVERIFIABLE keeps it out of PASS. NOT_CLAIMED
 *  never changes the verdict, because it records something the receipt never asserted. */
export function verdictOf(findings: readonly Finding[]): Outcome {
  if (findings.some((f) => f.outcome === "FAIL")) return "FAIL";
  if (findings.some((f) => f.outcome === "UNVERIFIABLE")) return "UNVERIFIABLE";
  return "PASS";
}

const hexEq = (a?: string, b?: string) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase().replace(/^0x/, "") === b.toLowerCase().replace(/^0x/, "");

export interface XrplTransaction {
  readonly Account: string;
  readonly Destination: string;
  readonly Amount: string;
  readonly Fee: string;
  readonly Flags?: number;
  readonly Sequence?: number;
  readonly TicketSequence?: number;
  readonly DestinationTag?: number;
  readonly LastLedgerSequence?: number;
  readonly Memos?: readonly { readonly Memo: { readonly MemoData?: string } }[];
  readonly validated?: boolean;
  readonly ledger_index?: number;
  readonly meta?: { readonly TransactionResult?: string };
}

/**
 * Asks every endpoint rather than the first one that answers.
 *
 * A single endpoint is a single party. Requiring agreement across independently operated endpoints
 * is the difference between "the ledger says" and "someone told us".
 */
export async function lookupOnEveryEndpoint(
  txHash: string,
  endpoints: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ agreed: XrplTransaction | null; answers: number; disagreement: string | null }> {
  const answers: XrplTransaction[] = [];
  for (const endpoint of endpoints) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "tx", params: [{ transaction: txHash, binary: false }] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) continue;
      const body = (await response.json()) as { result?: XrplTransaction & { error?: string } };
      if (!body.result || body.result.error) continue;
      answers.push(body.result);
    } catch {
      // An endpoint that cannot answer is not evidence either way.
    }
  }
  if (answers.length === 0) return { agreed: null, answers: 0, disagreement: null };

  const first = answers[0]!;
  for (const other of answers.slice(1)) {
    for (const field of ["Account", "Destination", "Amount", "ledger_index"] as const) {
      if (String(first[field]) !== String(other[field])) {
        return { agreed: null, answers: answers.length, disagreement: field };
      }
    }
  }
  return { agreed: first, answers: answers.length, disagreement: null };
}

export interface Receipt {
  readonly seam?: string;
  /** Absent means the receipt claims to settle its obligation. Only an explicit false relaxes that. */
  readonly settles?: boolean;
  readonly network?: string;
  readonly flareChain?: string;
  readonly requestId?: string;
  readonly agentVault?: string;
  readonly obligationHash?: string;
  readonly authorizationCommitment?: string;
  readonly extensionCodeHash?: string;
  readonly txHash?: string;
  readonly validatedLedger?: number | null;
  readonly template?: Record<string, unknown>;
}

export interface ObligationSource {
  /** Reads the obligation from FAssets. Returns null when this obligation is not publicly readable. */
  readCanonicalRedemption(
    requestId: bigint,
  ): Promise<null | {
    readonly agentVault: string;
    readonly paymentAddress: string;
    readonly valueUBA: bigint;
    readonly feeUBA: bigint;
    readonly status: string;
  }>;
}

export interface VerifyOptions {
  readonly xrplEndpoints: readonly string[];
  readonly obligations: ObligationSource;
  readonly recomputeCommitment?: (receipt: Receipt, tx: XrplTransaction) => string | null;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Verifies one receipt.
 *
 * The order is deliberate: structural checks first, then the ledger, then FAssets, then the
 * commitment. Each stage can only run on what the previous one established, and a stage that cannot
 * run reports UNVERIFIABLE rather than being skipped silently.
 */
export async function verifyReceipt(
  name: string,
  receipt: Receipt,
  options: VerifyOptions,
): Promise<VerificationResult> {
  const findings: Finding[] = [];

  if (!receipt.txHash) {
    findings.push(fail("receipt names an xrpl transaction", "a transaction hash", "absent"));
    return { receipt: name, findings, verdict: verdictOf(findings) };
  }
  if (!receipt.requestId) {
    findings.push(fail("receipt names a fassets request", "a request id", "absent"));
    return { receipt: name, findings, verdict: verdictOf(findings) };
  }

  // ---- the ledger, asked directly

  const { agreed, answers, disagreement } = await lookupOnEveryEndpoint(
    receipt.txHash,
    options.xrplEndpoints,
    options.fetchImpl,
  );
  if (disagreement) {
    findings.push(fail("independent xrpl endpoints agree", "identical answers", `differ on ${disagreement}`));
    return { receipt: name, findings, verdict: verdictOf(findings) };
  }
  if (!agreed) {
    findings.push(unverifiable("the payment is on the xrp ledger", "no endpoint could answer for this transaction"));
    return { receipt: name, findings, verdict: verdictOf(findings) };
  }
  findings.push(pass("independent xrpl endpoints agree", `${answers} endpoints`));

  findings.push(
    agreed.validated === true
      ? pass("the payment is validated, not provisional", `ledger ${agreed.ledger_index}`)
      : fail("the payment is validated, not provisional", "validated=true", String(agreed.validated)),
  );
  findings.push(
    agreed.meta?.TransactionResult === "tesSUCCESS"
      ? pass("the ledger accepted the payment", agreed.meta.TransactionResult)
      : fail("the ledger accepted the payment", "tesSUCCESS", String(agreed.meta?.TransactionResult)),
  );
  if (receipt.validatedLedger != null) {
    findings.push(
      Number(receipt.validatedLedger) === Number(agreed.ledger_index)
        ? pass("the receipt names the ledger the payment is actually in", String(agreed.ledger_index))
        : fail(
            "the receipt names the ledger the payment is actually in",
            String(agreed.ledger_index),
            String(receipt.validatedLedger),
          ),
    );
  }

  // Partial payment would let the ledger deliver less than Amount. Both deciders pin Flags to 0, and
  // the ledger is the place to confirm it survived.
  findings.push(
    Number(agreed.Flags ?? 0) === 0
      ? pass("partial payment was not enabled", "Flags=0")
      : fail("partial payment was not enabled", "0", String(agreed.Flags)),
  );

  // ---- the memo has to be the reference FAssets derives from the request id

  const requestId = BigInt(receipt.requestId);
  const expectedReference = toHex(redemptionPaymentReference(requestId));
  const memo = agreed.Memos?.[0]?.Memo?.MemoData;
  findings.push(
    hexEq(memo, expectedReference)
      ? pass("the payment carries the reference fassets derives from this request id", expectedReference)
      : fail(
          "the payment carries the reference fassets derives from this request id",
          expectedReference,
          memo ?? "absent",
        ),
  );

  // ---- fassets, read independently

  const obligation = await options.obligations.readCanonicalRedemption(requestId);
  if (!obligation) {
    findings.push(
      unverifiable(
        "the obligation exists in fassets",
        "this request id is not readable on the public chain, so the payment cannot be tied to an obligation anyone else can inspect",
      ),
    );
  } else {
    const settles = receipt.settles !== false;
    const mismatch = settles ? fail : notClaimed;
    findings.push(
      obligation.paymentAddress === agreed.Destination
        ? pass("the payment went where fassets said", agreed.Destination)
        : mismatch("the payment went where fassets said", obligation.paymentAddress, agreed.Destination),
    );
    const owed = obligation.valueUBA - obligation.feeUBA;
    findings.push(
      BigInt(agreed.Amount) === owed
        ? pass("the amount paid is exactly value minus fee", `${owed} drops`)
        : mismatch("the amount paid is exactly value minus fee", `${owed}`, agreed.Amount),
    );
    if (receipt.agentVault) {
      findings.push(
        hexEq(obligation.agentVault, receipt.agentVault)
          ? pass("the receipt names the agent fassets assigned", obligation.agentVault)
          : mismatch("the receipt names the agent fassets assigned", obligation.agentVault, receipt.agentVault),
      );
    }
    if (!settles) {
      findings.push({
        name: "this receipt does not claim to settle its obligation",
        outcome: "NOT_CLAIMED",
        why: "it proves a seam by borrowing a real obligation's payment reference; the differences above are expected and are not a settlement",
      });
    }
  }

  // ---- the commitment, recomputed rather than believed

  const recomputed = options.recomputeCommitment?.(receipt, agreed) ?? null;
  if (recomputed === null) {
    findings.push(
      unverifiable(
        "the authorization commitment matches the payment",
        "the commitment covers binding and policy fields that are not in this receipt, so it cannot be recomputed from public data alone",
      ),
    );
  } else {
    findings.push(
      hexEq(recomputed, receipt.authorizationCommitment)
        ? pass("the authorization commitment matches the payment", recomputed)
        : fail("the authorization commitment matches the payment", recomputed, receipt.authorizationCommitment ?? "absent"),
    );
  }

  return { receipt: name, findings, verdict: verdictOf(findings) };
}

/** Recomputes the obligation hash from the receipt's own identifying fields. */
export function recomputeObligationHash(fields: Omit<ObligationCommitmentFields, "schemaVersion">): string {
  return obligationHash({ schemaVersion: 1, ...fields });
}

export function recomputeCommitment(fields: AuthorizationCommitmentFields): string {
  return authorizationCommitment(fields);
}

/** keccak256 of a file's bytes, used to check a bundle against its recorded digest. */
export function digestOf(bytes: Uint8Array): string {
  return toHex(keccak_256(bytes));
}
