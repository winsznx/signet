#!/usr/bin/env node
/**
 * Reads one decision input on stdin and writes the reference decision on stdout.
 *
 * This exists so the composed lifecycle can put the specification and the Go extension in front of
 * the same bytes and compare their answers. The parser below is written out field by field rather
 * than reflectively revived, for the same reason the Go decoder is: a reviver that guesses which
 * fields are bigints would guess the same way in both languages, and two parsers that share a
 * guess cannot catch each other's mistake.
 */
import { readFileSync } from "node:fs";
import { canonicalJson } from "./fixtures.ts";
import { decide } from "./decide.ts";
import type { ReferenceInput } from "./types.ts";

function big(value: unknown, field: string): bigint {
  if (typeof value !== "string") throw new Error(`${field} must be a decimal string`);
  return BigInt(value);
}

/**
 * Rejects any field the parser does not read.
 *
 * This has to hold at every nesting level, not just the top. Go's decoder rejects unknown fields
 * recursively, so a parser that only checked the top level here would silently accept inputs Go
 * refuses, and the two deciders would stop being fed the same semantics without either of them
 * noticing. A field this parser drops is a field an operator believes they set.
 */
function only(value: unknown, path: string, allowed: readonly string[]): Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) throw new Error(`unknown field ${path}.${key}`);
  }
  return value as Record<string, any>;
}

function parseInput(raw: string): ReferenceInput {
  const j = only(JSON.parse(raw), "input", ["domain", "binding", "redemption", "xrpl", "policy", "prior", "underlying"]);
  only(j.domain, "domain", ["schemaVersion", "flareChainId", "instructionSender", "assetManager", "xrplNetworkId"]);
  if (j.binding) {
    only(j.binding, "binding", [
      "agentVault", "assetManager", "flareChainId", "instructionSender", "xrplNetworkId", "xrplSourceAddress",
      "signingMode", "signerCount", "keyState", "status", "extensionId", "approvedCodeHash", "policyVersion",
    ]);
  }
  if (j.redemption) {
    only(j.redemption, "redemption", [
      "requestId", "requestGeneration", "status", "agentVault", "paymentAddress", "paymentReference", "valueUBA",
      "feeUBA", "firstUnderlyingBlock", "lastUnderlyingBlock", "lastUnderlyingTimestamp", "requiresDestinationTag",
      "destinationTag", "assetMintingDecimals",
    ]);
  }
  if (j.xrpl) {
    only(j.xrpl, "xrpl", [
      "sequenceMode", "sequenceOrTicket", "currentValidatedLedger", "currentLedgerCloseTime", "lastLedgerSequence",
      "feeDrops", "maxFeeDrops", "baseFeeDrops",
    ]);
  }
  only(j.policy, "policy", [
    "policyVersion", "extensionId", "extensionCodeHash", "revokedCodeHashes", "paused", "safetyMarginLedgers",
    "safetyMarginSeconds", "ledgerCloseIntervalSeconds", "minimumUnderlyingSources", "maxObservationAgeLedgers",
  ]);
  if (j.underlying) {
    only(j.underlying, "underlying", [
      "available", "agreed", "sourceCount", "observedAtLedger", "observedAtTime", "payments",
    ]);
    for (const [index, p] of (j.underlying.payments ?? []).entries()) {
      only(p, `underlying.payments[${index}]`, [
        "transactionHash", "destinationAddress", "amountDrops", "paymentReference", "validated",
      ]);
    }
  }
  for (const [index, p] of (j.prior ?? []).entries()) {
    only(p, `prior[${index}]`, ["requestGeneration", "sequenceMode", "sequenceOrTicket", "outcome"]);
  }
  return {
    domain: {
      schemaVersion: j.domain.schemaVersion,
      flareChainId: big(j.domain.flareChainId, "domain.flareChainId"),
      instructionSender: j.domain.instructionSender,
      assetManager: j.domain.assetManager,
      xrplNetworkId: j.domain.xrplNetworkId,
    },
    binding: j.binding
      ? {
          agentVault: j.binding.agentVault,
          assetManager: j.binding.assetManager,
          flareChainId: big(j.binding.flareChainId, "binding.flareChainId"),
          instructionSender: j.binding.instructionSender,
          xrplNetworkId: j.binding.xrplNetworkId,
          xrplSourceAddress: j.binding.xrplSourceAddress,
          signingMode: j.binding.signingMode,
          signerCount: j.binding.signerCount,
          keyState: j.binding.keyState,
          status: j.binding.status,
          extensionId: big(j.binding.extensionId, "binding.extensionId"),
          approvedCodeHash: j.binding.approvedCodeHash,
          policyVersion: j.binding.policyVersion,
        }
      : null,
    redemption: j.redemption
      ? {
          requestId: big(j.redemption.requestId, "redemption.requestId"),
          requestGeneration: j.redemption.requestGeneration,
          status: j.redemption.status,
          agentVault: j.redemption.agentVault,
          paymentAddress: j.redemption.paymentAddress,
          paymentReference: j.redemption.paymentReference,
          valueUBA: big(j.redemption.valueUBA, "redemption.valueUBA"),
          feeUBA: big(j.redemption.feeUBA, "redemption.feeUBA"),
          firstUnderlyingBlock: big(j.redemption.firstUnderlyingBlock, "redemption.firstUnderlyingBlock"),
          lastUnderlyingBlock: big(j.redemption.lastUnderlyingBlock, "redemption.lastUnderlyingBlock"),
          lastUnderlyingTimestamp: big(j.redemption.lastUnderlyingTimestamp, "redemption.lastUnderlyingTimestamp"),
          requiresDestinationTag: j.redemption.requiresDestinationTag,
          destinationTag: big(j.redemption.destinationTag, "redemption.destinationTag"),
          assetMintingDecimals: j.redemption.assetMintingDecimals,
        }
      : null,
    xrpl: j.xrpl
      ? {
          sequenceMode: j.xrpl.sequenceMode,
          sequenceOrTicket: j.xrpl.sequenceOrTicket,
          currentValidatedLedger: j.xrpl.currentValidatedLedger,
          currentLedgerCloseTime: big(j.xrpl.currentLedgerCloseTime, "xrpl.currentLedgerCloseTime"),
          lastLedgerSequence: j.xrpl.lastLedgerSequence,
          feeDrops: big(j.xrpl.feeDrops, "xrpl.feeDrops"),
          maxFeeDrops: big(j.xrpl.maxFeeDrops, "xrpl.maxFeeDrops"),
          baseFeeDrops: big(j.xrpl.baseFeeDrops, "xrpl.baseFeeDrops"),
        }
      : null,
    policy: {
      policyVersion: j.policy.policyVersion,
      extensionId: big(j.policy.extensionId, "policy.extensionId"),
      extensionCodeHash: j.policy.extensionCodeHash,
      revokedCodeHashes: j.policy.revokedCodeHashes ?? [],
      paused: j.policy.paused,
      safetyMarginLedgers: j.policy.safetyMarginLedgers,
      safetyMarginSeconds: big(j.policy.safetyMarginSeconds, "policy.safetyMarginSeconds"),
      ledgerCloseIntervalSeconds: big(j.policy.ledgerCloseIntervalSeconds, "policy.ledgerCloseIntervalSeconds"),
      minimumUnderlyingSources: j.policy.minimumUnderlyingSources,
      maxObservationAgeLedgers: j.policy.maxObservationAgeLedgers,
    },
    underlying: j.underlying
      ? {
          available: j.underlying.available,
          agreed: j.underlying.agreed,
          sourceCount: j.underlying.sourceCount,
          observedAtLedger: j.underlying.observedAtLedger,
          observedAtTime: big(j.underlying.observedAtTime, "underlying.observedAtTime"),
          payments: (j.underlying.payments ?? []).map((p: Record<string, any>) => ({
            transactionHash: p.transactionHash,
            destinationAddress: p.destinationAddress,
            amountDrops: big(p.amountDrops, "underlying.payments[].amountDrops"),
            paymentReference: p.paymentReference,
            validated: p.validated,
          })),
        }
      : null,
    prior: (j.prior ?? []).map((p: Record<string, any>) => ({
      requestGeneration: p.requestGeneration,
      sequenceMode: p.sequenceMode,
      sequenceOrTicket: p.sequenceOrTicket,
      outcome: p.outcome,
    })),
  };
}

// A malformed input is not a refusal. A refusal is a statement about a real obligation, and an input
// that will not parse does not identify one, so emitting a decision here would attribute an answer
// to an obligation nobody named. Exit 1, matching the Go binary, so that neither can be mistaken for
// the other by a caller reading only the status.
let input;
try {
  input = parseInput(readFileSync(0, "utf8"));
} catch (error) {
  process.stderr.write(`cli-decide: ${(error as Error).message}\n`);
  process.exit(1);
}

const decision = decide(input);
process.stdout.write(`${canonicalJson(decision)}\n`);
process.exit(decision.kind === "authorize" ? 0 : 2);
