/**
 * The Signet authorization decision. This function is the specification.
 *
 * It is pure: no network, no clock, no filesystem, no randomness. Every input is a snapshot the
 * caller has already read from an authoritative source, and the same input always yields the same
 * decision and the same transaction template (FR-025).
 *
 * The evaluation order is fixed and documented in docs/adr/0002-policy-semantics.md. It matters:
 * a caller must be able to predict which reason code a given bad input produces, and reordering
 * checks changes the observable protocol surface.
 *
 * Every path either authorizes or refuses. There is no path that returns a signature-shaped result
 * on unexpected input, and no exception escapes: an internal failure is a refusal with
 * S020_INTERNAL_FAIL_CLOSED (NFR-001, default deny).
 */
import { obligationAmountDrops } from "./amount.ts";
import { toHex } from "./bytes.ts";
import { authorizationCommitment, keccakOfUtf8, obligationHash, observationRoot } from "./encoding.ts";
import { hexToBytes } from "./bytes.ts";
import { isValidRedemptionReference, redemptionPaymentReference } from "./payment-reference.ts";
import { errorClassOf, type ReasonCode } from "./reason-codes.ts";
import { decodeClassicAddress, isCanonicalClassicAddress } from "./xrpl-address.ts";
import {
  SIGNET_SCHEMA_VERSION,
  type CanonicalXrplPayment,
  type ReferenceDecision,
  type ReferenceInput,
} from "./types.ts";

const UINT32_MAX = 0xffff_ffff;
const UINT8_MAX = 0xff;

/**
 * XRPL requires the NetworkID field only on networks whose id is 1025 or greater; including it on
 * a lower-id network makes the transaction invalid. Testnet is network 1, so the field is omitted
 * there. Verified against live rippled behaviour in phase 04.
 */
export const NETWORK_ID_REQUIRED_FROM = 1025;

export function networkIdRequired(xrplNetworkId: number): boolean {
  return xrplNetworkId >= NETWORK_ID_REQUIRED_FROM;
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * Obligation hash for a refusal, computed from whatever is known. When the obligation itself is
 * unavailable the identifying fields are zeroed, so a refusal is still attributable to a domain
 * without inventing an obligation that was never read.
 */
function refusalObligationHash(input: ReferenceInput): `0x${string}` {
  try {
    return obligationHash({
      flareChainId: input.domain.flareChainId,
      assetManager: input.domain.assetManager,
      agentVault: input.redemption?.agentVault ?? "0x0000000000000000000000000000000000000000",
      requestId: input.redemption?.requestId ?? 0n,
      requestGeneration: input.redemption?.requestGeneration ?? 0,
    });
  } catch {
    return toHex(keccakOfUtf8("SIGNET_UNATTRIBUTABLE_REFUSAL_V1"));
  }
}

export function decide(input: ReferenceInput): ReferenceDecision {
  try {
    return evaluate(input);
  } catch {
    // An unexpected internal failure must never look like anything other than a refusal.
    return {
      kind: "refuse",
      obligationHash: refusalObligationHash(input),
      reason: "S020_INTERNAL_FAIL_CLOSED",
      errorClass: errorClassOf("S020_INTERNAL_FAIL_CLOSED"),
    };
  }
}

function evaluate(input: ReferenceInput): ReferenceDecision {
  const refuse = (reason: ReasonCode): ReferenceDecision => ({
    kind: "refuse",
    obligationHash: refusalObligationHash(input),
    reason,
    errorClass: errorClassOf(reason),
  });

  const { domain, binding, redemption, xrpl, policy, prior, underlying } = input;

  // 1. Schema. An unsupported version fails closed rather than being interpreted (I-020).
  if (domain.schemaVersion !== SIGNET_SCHEMA_VERSION) return refuse("S001_UNKNOWN_SCHEMA");

  // 2. Emergency pause stops new authorizations before anything else is considered (I-012).
  if (policy.paused) return refuse("S016_PAUSED");

  // 3. Missing state is transient, never a permanent policy denial (FR-024).
  if (binding === null || redemption === null || xrpl === null) return refuse("S017_STATE_UNAVAILABLE");

  // 4. Domain. A result valid for another chain, sender, asset manager or XRPL network is a
  //    cross-domain replay (I-011). Every element is compared against the value the binding was
  //    created for, not merely checked for shape: a well-formed value from the wrong network is
  //    exactly the input this check exists to reject.
  if (domain.flareChainId <= 0n) return refuse("S002_WRONG_DOMAIN");
  if (!/^0x[0-9a-fA-F]{40}$/.test(domain.instructionSender)) return refuse("S002_WRONG_DOMAIN");
  if (!Number.isInteger(domain.xrplNetworkId) || domain.xrplNetworkId < 0) return refuse("S002_WRONG_DOMAIN");
  if (!sameAddress(binding.assetManager, domain.assetManager)) return refuse("S002_WRONG_DOMAIN");
  if (binding.flareChainId !== domain.flareChainId) return refuse("S002_WRONG_DOMAIN");
  if (!sameAddress(binding.instructionSender, domain.instructionSender)) return refuse("S002_WRONG_DOMAIN");
  if (binding.xrplNetworkId !== domain.xrplNetworkId) return refuse("S002_WRONG_DOMAIN");

  // 5. Binding lifecycle.
  if (binding.status === "RETIRED") return refuse("S003_UNBOUND_AGENT");
  if (binding.status === "PAUSED") return refuse("S016_PAUSED");

  // 6. The obligation must belong to the bound agent.
  if (!sameAddress(binding.agentVault, redemption.agentVault)) return refuse("S005_WRONG_AGENT");

  // 7. Code and policy version. A revoked or unapproved version may not produce a result (I-011).
  if (binding.extensionId !== policy.extensionId) return refuse("S015_CODE_VERSION_REVOKED");
  if (binding.policyVersion !== policy.policyVersion) return refuse("S015_CODE_VERSION_REVOKED");
  if (binding.approvedCodeHash.toLowerCase() !== policy.extensionCodeHash.toLowerCase()) {
    return refuse("S015_CODE_VERSION_REVOKED");
  }
  if (policy.revokedCodeHashes.some((hash) => hash.toLowerCase() === policy.extensionCodeHash.toLowerCase())) {
    return refuse("S015_CODE_VERSION_REVOKED");
  }

  // 8. Signing authority must be live.
  if (binding.keyState !== "ACTIVE") return refuse("S019_KEY_NOT_ACTIVE");

  // 9. The obligation must be open.
  if (redemption.status !== "ACTIVE") return refuse("S004_INACTIVE_REDEMPTION");

  // 10. One obligation, at most one validated successful payment (I-009).
  if (prior.some((p) => p.outcome === "SUCCESSFUL")) return refuse("S006_ALREADY_CONSUMED");
  if (prior.some((p) => p.requestGeneration === redemption.requestGeneration)) return refuse("S006_ALREADY_CONSUMED");

  // 11. The history must be complete and internally consistent before it can justify anything.
  //
  //     A pure function cannot detect a caller that fabricates history wholesale, which is why the
  //     trust source for `prior` is constrained normatively on PriorGenerationSnapshot rather than
  //     validated here. What it can and must detect is a record that does not describe generations
  //     0..n-1 exactly once each: a gap, a duplicate or an out-of-range entry means the caller has
  //     lost track of the obligation's history, and a decision built on it would be guesswork.
  if (!Number.isInteger(redemption.requestGeneration) || redemption.requestGeneration < 0) {
    return refuse("S018_REPLACEMENT_NOT_AUTHORIZED");
  }
  if (prior.length !== redemption.requestGeneration) return refuse("S018_REPLACEMENT_NOT_AUTHORIZED");
  const seenGenerations = new Set<number>();
  for (const entry of prior) {
    if (!Number.isInteger(entry.requestGeneration)) return refuse("S018_REPLACEMENT_NOT_AUTHORIZED");
    if (entry.requestGeneration < 0 || entry.requestGeneration >= redemption.requestGeneration) {
      return refuse("S018_REPLACEMENT_NOT_AUTHORIZED");
    }
    if (seenGenerations.has(entry.requestGeneration)) return refuse("S018_REPLACEMENT_NOT_AUTHORIZED");
    seenGenerations.add(entry.requestGeneration);
  }

  // 12. A replacement is authorized only once every earlier generation is proven not successful
  //     (I-010, FR-045). An unresolved earlier attempt is the case that must never be replaced, and
  //     checking every generation rather than only the immediately preceding one means an older
  //     unresolved attempt cannot be buried under a newer resolved one.
  if (redemption.requestGeneration > 0) {
    if (!prior.every((p) => p.outcome === "PROVEN_NOT_SUCCESSFUL")) {
      return refuse("S018_REPLACEMENT_NOT_AUTHORIZED");
    }
  }

  // 13. The allocation must not reuse a sequence or ticket an earlier generation already holds.
  if (
    prior.some(
      (p) => p.sequenceMode === xrpl.sequenceMode && p.sequenceOrTicket === xrpl.sequenceOrTicket,
    )
  ) {
    return refuse("S014_SEQUENCE_CONFLICT");
  }
  if (!Number.isInteger(xrpl.sequenceOrTicket) || xrpl.sequenceOrTicket <= 0 || xrpl.sequenceOrTicket > UINT32_MAX) {
    return refuse("S014_SEQUENCE_CONFLICT");
  }

  // 14. The payment reference must be exactly the one FAssets will require on confirmation.
  const referenceBytes = (() => {
    try {
      return hexToBytes(redemption.paymentReference);
    } catch {
      return null;
    }
  })();
  if (referenceBytes === null || referenceBytes.length !== 32) return refuse("S011_REFERENCE_INVALID");
  if (!isValidRedemptionReference(referenceBytes)) return refuse("S011_REFERENCE_INVALID");
  const expectedReference = redemptionPaymentReference(redemption.requestId);
  if (toHex(referenceBytes) !== toHex(expectedReference)) return refuse("S011_REFERENCE_INVALID");

  // 15. The destination must be a canonical classic address. Signet never repairs or normalises it.
  if (!isCanonicalClassicAddress(redemption.paymentAddress)) return refuse("S009_DESTINATION_INVALID");
  const destinationAccountId = decodeClassicAddress(redemption.paymentAddress);

  // 16. Destination tag. Mode and value are independent, so "no tag" cannot masquerade as "tag 0".
  if (redemption.requiresDestinationTag) {
    if (redemption.destinationTag < 0n || redemption.destinationTag > BigInt(UINT32_MAX)) {
      return refuse("S012_TAG_INVALID");
    }
  } else if (redemption.destinationTag !== 0n) {
    return refuse("S012_TAG_INVALID");
  }

  // 17. Amount. Exact conversion only; a rounding would either underpay or overspend.
  const amount = obligationAmountDrops(redemption.valueUBA, redemption.feeUBA, redemption.assetMintingDecimals);
  if (!amount.ok) return refuse("S010_AMOUNT_INVALID");

  // 18. The obligation must not already have been paid on the underlying chain.
  //
  //     This is the check incident 44928272 was missing, and the reason the schema moved to V2.
  //     FAssets reporting ACTIVE means the payment has not been *confirmed on Flare*, which is not
  //     the same as unpaid: confirmation is a separate transaction the agent submits after its
  //     payment validates and after it obtains an FDC proof. In that window FAssets says the
  //     obligation is open while the money has already moved. Every other duplicate-payment guard
  //     in this system watches Flare or Signet's own state, and none of them can see a payment
  //     made by somebody else.
  //
  //     Every branch below fails closed. The decision must never be able to reach an authorization
  //     by failing to look, by looking badly, or by looking a long time ago.
  if (underlying === null) return refuse("S022_UNDERLYING_STATE_UNAVAILABLE");
  if (!underlying.available) return refuse("S022_UNDERLYING_STATE_UNAVAILABLE");

  //     Contradictory sources are not retried automatically. See reason-codes.ts: a loop that
  //     retries until the endpoints agree is a loop that keeps asking until it gets the answer that
  //     lets it pay.
  if (!underlying.agreed) return refuse("S023_UNDERLYING_STATE_DISAGREEMENT");

  if (!Number.isInteger(policy.minimumUnderlyingSources) || policy.minimumUnderlyingSources < 1) {
    return refuse("S020_INTERNAL_FAIL_CLOSED");
  }
  if (!Number.isInteger(underlying.sourceCount) || underlying.sourceCount < policy.minimumUnderlyingSources) {
    return refuse("S022_UNDERLYING_STATE_UNAVAILABLE");
  }
  if (underlying.sourceCount > UINT8_MAX) return refuse("S020_INTERNAL_FAIL_CLOSED");

  //     Staleness, both directions. An observation older than the policy allows is refused because
  //     the ledger has moved on; an observation from a ledger the caller has not yet seen validated
  //     is refused because it is incoherent, and an incoherent observation is a fabricated one.
  if (!Number.isInteger(policy.maxObservationAgeLedgers) || policy.maxObservationAgeLedgers < 0) {
    return refuse("S020_INTERNAL_FAIL_CLOSED");
  }
  if (!Number.isInteger(underlying.observedAtLedger) || underlying.observedAtLedger <= 0) {
    return refuse("S024_UNDERLYING_OBSERVATION_STALE");
  }
  if (underlying.observedAtLedger > xrpl.currentValidatedLedger) {
    return refuse("S024_UNDERLYING_OBSERVATION_STALE");
  }
  if (xrpl.currentValidatedLedger - underlying.observedAtLedger > policy.maxObservationAgeLedgers) {
    return refuse("S024_UNDERLYING_OBSERVATION_STALE");
  }

  //     The match predicate is deliberately broader than the one FAssets applies on confirmation.
  //     FAssets requires the destination, the reference and an amount at least equal to what is
  //     owed. Signet refuses on destination and reference alone, ignoring the amount, because a
  //     payment carrying this obligation's reference to this destination for the wrong amount is a
  //     state a human needs to look at, not a state to pay over the top of.
  const alreadyObserved = underlying.payments.some(
    (payment) =>
      payment.validated &&
      payment.destinationAddress === redemption.paymentAddress &&
      payment.paymentReference.toLowerCase() === redemption.paymentReference.toLowerCase(),
  );
  if (alreadyObserved) return refuse("S021_PAYMENT_ALREADY_OBSERVED");

  // 19. Fee ceiling and signing-mode floor (FR-034, I-007). A multi-signed XRPL transaction costs
  //     the base fee times one plus the number of signatures, so a fee that is lawful for a single
  //     RegularKey signature is not necessarily lawful for a signer list. Underpaying is not a
  //     safety failure but it guarantees the payment never validates, which near a deadline is
  //     indistinguishable from a default.
  if (xrpl.feeDrops <= 0n) return refuse("S013_FEE_CAP_EXCEEDED");
  if (xrpl.maxFeeDrops <= 0n) return refuse("S013_FEE_CAP_EXCEEDED");
  if (xrpl.baseFeeDrops <= 0n) return refuse("S013_FEE_CAP_EXCEEDED");
  if (xrpl.feeDrops > xrpl.maxFeeDrops) return refuse("S013_FEE_CAP_EXCEEDED");
  if (binding.signingMode === "SIGNER_LIST" && (!Number.isInteger(binding.signerCount) || binding.signerCount < 1)) {
    return refuse("S020_INTERNAL_FAIL_CLOSED");
  }
  const feeMultiplier = binding.signingMode === "SIGNER_LIST" ? 1n + BigInt(binding.signerCount) : 1n;
  if (xrpl.feeDrops < xrpl.baseFeeDrops * feeMultiplier) return refuse("S013_FEE_CAP_EXCEEDED");

  // 20. The obligation must still be payable. FAssets defaults only once BOTH the last underlying
  //     block and the last underlying timestamp have passed, so both must still be open.
  const ledgerPassed = BigInt(xrpl.currentValidatedLedger) > redemption.lastUnderlyingBlock;
  const timePassed = xrpl.currentLedgerCloseTime > redemption.lastUnderlyingTimestamp;
  if (ledgerPassed && timePassed) return refuse("S007_EXPIRED_WINDOW");

  // 21. Safety margin (I-008, FR-034). Signet is deliberately stricter than the protocol minimum:
  //     it requires the transaction to expire before BOTH limits, not just one, so a payment can
  //     never land in the window where FAssets' acceptance depends on which limit passed first.
  if (!Number.isInteger(xrpl.lastLedgerSequence) || xrpl.lastLedgerSequence <= xrpl.currentValidatedLedger) {
    return refuse("S008_INSUFFICIENT_SAFETY_MARGIN");
  }
  if (xrpl.lastLedgerSequence > UINT32_MAX) return refuse("S008_INSUFFICIENT_SAFETY_MARGIN");
  if (policy.safetyMarginLedgers < 0 || policy.safetyMarginSeconds < 0n || policy.ledgerCloseIntervalSeconds <= 0n) {
    return refuse("S020_INTERNAL_FAIL_CLOSED");
  }
  if (BigInt(xrpl.lastLedgerSequence) + BigInt(policy.safetyMarginLedgers) > redemption.lastUnderlyingBlock) {
    return refuse("S008_INSUFFICIENT_SAFETY_MARGIN");
  }
  const ledgersAhead = BigInt(xrpl.lastLedgerSequence - xrpl.currentValidatedLedger);
  const projectedCloseTime = xrpl.currentLedgerCloseTime + ledgersAhead * policy.ledgerCloseIntervalSeconds;
  if (projectedCloseTime + policy.safetyMarginSeconds > redemption.lastUnderlyingTimestamp) {
    return refuse("S008_INSUFFICIENT_SAFETY_MARGIN");
  }

  // 22. The source must be the bound account (FR-036). A malformed bound account is a
  //     configuration failure, not a property of this obligation, so it fails closed internally.
  if (!isCanonicalClassicAddress(binding.xrplSourceAddress)) return refuse("S020_INTERNAL_FAIL_CLOSED");
  const sourceAccountId = decodeClassicAddress(binding.xrplSourceAddress);
  if (redemption.paymentAddress === binding.xrplSourceAddress) return refuse("S009_DESTINATION_INVALID");

  const destinationTagMode = redemption.requiresDestinationTag ? 1 : 0;

  const commitment = authorizationCommitment({
    observedAtLedger: underlying.observedAtLedger,
    observedSourceCount: underlying.sourceCount,
    observationRoot: observationRoot({
      available: underlying.available,
      agreed: underlying.agreed,
      observedAtLedger: underlying.observedAtLedger,
      observedAtTime: underlying.observedAtTime,
      sourceCount: underlying.sourceCount,
      payments: underlying.payments.map((p) => ({
        transactionHash: p.transactionHash,
        amountDrops: p.amountDrops,
      })),
    }),
    flareChainId: domain.flareChainId,
    instructionSender: domain.instructionSender,
    assetManager: domain.assetManager,
    agentVault: binding.agentVault,
    requestId: redemption.requestId,
    requestGeneration: redemption.requestGeneration,
    xrplNetworkId: domain.xrplNetworkId,
    xrplSourceAccountId: sourceAccountId,
    xrplSourceAddressStringHash: keccakOfUtf8(binding.xrplSourceAddress),
    destinationAccountId,
    destinationAddressStringHash: keccakOfUtf8(redemption.paymentAddress),
    destinationTagMode,
    destinationTag: destinationTagMode === 1 ? Number(redemption.destinationTag) : 0,
    amountDrops: amount.drops,
    paymentReference: referenceBytes,
    firstUnderlyingBlock: redemption.firstUnderlyingBlock,
    lastUnderlyingBlock: redemption.lastUnderlyingBlock,
    lastUnderlyingTimestamp: redemption.lastUnderlyingTimestamp,
    sequenceMode: xrpl.sequenceMode === "TICKET" ? 1 : 0,
    sequenceOrTicket: xrpl.sequenceOrTicket,
    lastLedgerSequence: xrpl.lastLedgerSequence,
    feeDrops: xrpl.feeDrops,
    maxFeeDrops: xrpl.maxFeeDrops,
    policyVersion: policy.policyVersion,
    extensionId: policy.extensionId,
    extensionCodeHash: hexToBytes(policy.extensionCodeHash),
  });

  const memoData = Array.from(referenceBytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

  const txTemplate: CanonicalXrplPayment = {
    TransactionType: "Payment",
    Account: binding.xrplSourceAddress,
    Destination: redemption.paymentAddress,
    Amount: amount.drops.toString(10),
    Fee: xrpl.feeDrops.toString(10),
    // Flags is pinned to 0. tfPartialPayment would let the destination receive less than the
    // obligation requires while the transaction still succeeds (FR-031).
    Flags: 0,
    LastLedgerSequence: xrpl.lastLedgerSequence,
    // Exactly one memo whose MemoData is exactly 32 bytes: that is the only shape from which FDC
    // will derive a standardPaymentReference.
    Memos: [{ Memo: { MemoData: memoData } }],
    ...(xrpl.sequenceMode === "TICKET"
      ? { TicketSequence: xrpl.sequenceOrTicket, Sequence: 0 }
      : { Sequence: xrpl.sequenceOrTicket }),
    ...(destinationTagMode === 1 ? { DestinationTag: Number(redemption.destinationTag) } : {}),
    ...(networkIdRequired(domain.xrplNetworkId) ? { NetworkID: domain.xrplNetworkId } : {}),
  };

  return {
    kind: "authorize",
    obligationHash: obligationHash({
      flareChainId: domain.flareChainId,
      assetManager: domain.assetManager,
      agentVault: binding.agentVault,
      requestId: redemption.requestId,
      requestGeneration: redemption.requestGeneration,
    }),
    authorizationCommitment: commitment,
    txTemplate,
  };
}
