#!/usr/bin/env node
/**
 * Prints the observation root for one observation read on stdin.
 *
 * Exists so the Go implementation can be differentially tested against this one over the only
 * variable-length part of the V2 encoding. The two sort the match list differently by construction,
 * and "obviously equivalent" is the kind of claim worth making a machine check.
 */
import { readFileSync } from "node:fs";
import { observationRoot } from "./encoding.ts";
import { toHex } from "./bytes.ts";

const input = JSON.parse(readFileSync(0, "utf8"));
const root = observationRoot({
  available: input.available,
  agreed: input.agreed,
  observedAtLedger: input.observedAtLedger,
  observedAtTime: BigInt(input.observedAtTime),
  sourceCount: input.sourceCount,
  payments: (input.payments ?? []).map((p: { transactionHash: string; amountDrops: string }) => ({
    transactionHash: p.transactionHash,
    amountDrops: BigInt(p.amountDrops),
  })),
});
process.stdout.write(`${JSON.stringify({ root: toHex(root) })}\n`);
