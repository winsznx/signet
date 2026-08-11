/**
 * Recomputes the authorization commitment from a receipt and the transaction the ledger holds.
 *
 * This is the check that makes a moved destination or a raised amount visible. The commitment covers
 * every payment field, so recomputing it from what was actually paid and comparing against what was
 * recorded catches any difference between the two.
 *
 * It returns null rather than guessing when the receipt does not carry every field the commitment
 * covers. Filling a missing field with a plausible default would produce a commitment that matches
 * whatever the receipt claims, which is the failure mode of a verifier that always agrees.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { authorizationCommitment, decodeClassicAddress, hexToBytes, observationRoot } from "@signet/reference";
import type { Receipt, XrplTransaction } from "./verify.ts";

/** FAssets compares underlying addresses by keccak over the address string, so the commitment does too. */
const standardAddressHash = (address: string): Uint8Array => keccak_256(new TextEncoder().encode(address));

/** Fields the commitment covers that live only in the receipt's own record of the decision. */
interface DecisionContext {
  readonly flareChainId: string;
  readonly assetManager: string;
  readonly instructionSender: string;
  readonly agentVault: string;
  readonly requestGeneration: number;
  readonly xrplNetworkId: number;
  readonly policyVersion: number;
  readonly extensionId: string;
  readonly extensionCodeHash: string;
  readonly firstUnderlyingBlock: string;
  readonly lastUnderlyingBlock: string;
  readonly lastUnderlyingTimestamp: string;
  readonly maxFeeDrops: string;
  /** What the signing boundary saw on the XRP ledger, which V2 binds into the commitment. */
  readonly underlying?: {
    readonly available: boolean;
    readonly agreed: boolean;
    readonly sourceCount: number;
    readonly observedAtLedger: number;
    readonly observedAtTime: string;
    readonly payments: readonly { readonly transactionHash: string; readonly amountDrops: string }[];
  };
}

export function commitmentFromReceipt(receipt: Receipt, tx: XrplTransaction): string | null {
  const context = (receipt as Receipt & { decisionContext?: DecisionContext }).decisionContext;
  if (!context || !receipt.requestId) return null;

  // V2 binds the underlying observation. A receipt without it cannot have its commitment
  // recomputed, and the verifier reports UNVERIFIABLE rather than guessing: an assumed-clean
  // observation would produce a commitment matching whatever the receipt claims, which is the
  // failure mode of a verifier that always agrees.
  const observation = context.underlying;
  if (!observation) return null;

  const usesTicket = tx.TicketSequence !== undefined;
  const sequenceOrTicket = usesTicket ? tx.TicketSequence : tx.Sequence;
  if (sequenceOrTicket === undefined || tx.LastLedgerSequence === undefined) return null;

  return authorizationCommitment({
      flareChainId: BigInt(context.flareChainId),
      instructionSender: context.instructionSender,
      assetManager: context.assetManager,
      agentVault: context.agentVault,
      requestId: BigInt(receipt.requestId),
      requestGeneration: context.requestGeneration,
      xrplNetworkId: context.xrplNetworkId,
      xrplSourceAccountId: decodeClassicAddress(tx.Account),
      xrplSourceAddressStringHash: standardAddressHash(tx.Account),
      destinationAccountId: decodeClassicAddress(tx.Destination),
      destinationAddressStringHash: standardAddressHash(tx.Destination),
      destinationTagMode: tx.DestinationTag === undefined ? 0 : 1,
      destinationTag: tx.DestinationTag ?? 0,
      amountDrops: BigInt(tx.Amount),
      paymentReference: hexToBytes((tx.Memos?.[0]?.Memo?.MemoData ?? "").toLowerCase()),
      firstUnderlyingBlock: BigInt(context.firstUnderlyingBlock),
      lastUnderlyingBlock: BigInt(context.lastUnderlyingBlock),
      lastUnderlyingTimestamp: BigInt(context.lastUnderlyingTimestamp),
      sequenceMode: usesTicket ? 1 : 0,
      sequenceOrTicket,
      lastLedgerSequence: tx.LastLedgerSequence,
      feeDrops: BigInt(tx.Fee),
      maxFeeDrops: BigInt(context.maxFeeDrops),
      policyVersion: context.policyVersion,
      extensionId: BigInt(context.extensionId),
      extensionCodeHash: hexToBytes(context.extensionCodeHash),
      observedAtLedger: observation.observedAtLedger,
      observedSourceCount: observation.sourceCount,
      observationRoot: observationRoot({
        available: observation.available,
        agreed: observation.agreed,
        observedAtLedger: observation.observedAtLedger,
        observedAtTime: BigInt(observation.observedAtTime),
        sourceCount: observation.sourceCount,
        payments: observation.payments.map((p) => ({
          transactionHash: p.transactionHash,
          amountDrops: BigInt(p.amountDrops),
        })),
      }),
  });
}
