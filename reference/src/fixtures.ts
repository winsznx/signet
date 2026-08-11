/**
 * Fixture generation and freezing.
 *
 * The fixture file is the cross-language contract. Go and Solidity tests must consume it rather
 * than reimplement the decision, because a reimplementation that shares an author also shares its
 * mistakes: two independent bugs that agree prove nothing.
 *
 * Serialisation is deterministic: keys are emitted in sorted order and bigints become decimal
 * strings, so the file's own digest is stable and a single changed field is visible in a diff.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { toHex } from "./bytes.ts";
import { decide } from "./decide.ts";
import {
  AUTHORIZATION_DOMAIN_STRING,
  AUTHORIZATION_PREIMAGE_LENGTH,
  OBLIGATION_DOMAIN_STRING,
  OBLIGATION_PREIMAGE_LENGTH,
} from "./encoding.ts";
import { SCENARIOS, scenarioInput } from "./scenarios.ts";
import { SIGNET_SCHEMA_VERSION, type ReferenceDecision, type ReferenceInput } from "./types.ts";

export const FIXTURE_FORMAT_VERSION = 1;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** bigint becomes a decimal string; every other value keeps its JSON type. */
function toJson(value: unknown): Json {
  if (typeof value === "bigint") return value.toString(10);
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = toJson((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new Error(`cannot serialise ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toJson(value), null, 2);
}

export interface Fixture {
  readonly id: string;
  readonly intent: string;
  readonly input: Json;
  readonly expected: Json;
}

export interface FixtureFile {
  readonly formatVersion: number;
  readonly schemaVersion: number;
  readonly obligationDomain: string;
  readonly authorizationDomain: string;
  readonly obligationPreimageLength: number;
  readonly authorizationPreimageLength: number;
  readonly fixtures: readonly Fixture[];
  /** keccak256 over the canonical serialisation of `fixtures`. Frozen by the phase 01 gate. */
  readonly fixtureSetHash: string;
}

export function buildFixtures(): FixtureFile {
  const fixtures: Fixture[] = SCENARIOS.map((scenario) => {
    const input: ReferenceInput = scenarioInput(scenario.id);
    const decision: ReferenceDecision = decide(input);
    return {
      id: scenario.id,
      intent: scenario.intent,
      input: toJson(input),
      expected: toJson(decision),
    };
  });

  const fixtureSetHash = toHex(keccak_256(new TextEncoder().encode(canonicalJson(fixtures))));

  return {
    formatVersion: FIXTURE_FORMAT_VERSION,
    schemaVersion: SIGNET_SCHEMA_VERSION,
    obligationDomain: OBLIGATION_DOMAIN_STRING,
    authorizationDomain: AUTHORIZATION_DOMAIN_STRING,
    obligationPreimageLength: OBLIGATION_PREIMAGE_LENGTH,
    authorizationPreimageLength: AUTHORIZATION_PREIMAGE_LENGTH,
    fixtures,
    fixtureSetHash,
  };
}

export function serialiseFixtures(file: FixtureFile): string {
  return `${canonicalJson(file)}\n`;
}
