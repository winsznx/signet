import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildFixtures, canonicalJson, serialiseFixtures, type FixtureFile } from "../src/fixtures.ts";
import { decide } from "../src/decide.ts";
import { SCENARIOS, baseInput } from "../src/scenarios.ts";

const path = fileURLToPath(new URL("../test-vectors/decision-fixtures.json", import.meta.url));
const committed = readFileSync(path, "utf8");
const parsed = JSON.parse(committed) as FixtureFile;

describe("frozen fixtures", () => {
  it("matches a fresh build byte for byte", () => {
    // A mismatch means the specification moved. That is allowed, but it must be a deliberate
    // regeneration in a commit that says so, not a silent drift discovered later by another
    // language's test suite.
    expect(serialiseFixtures(buildFixtures())).toBe(committed);
  });

  it("carries a fixture-set hash over its own canonical serialisation", () => {
    const rebuilt = buildFixtures();
    expect(parsed.fixtureSetHash).toBe(rebuilt.fixtureSetHash);
    expect(parsed.fixtureSetHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("covers every scenario", () => {
    expect(parsed.fixtures.map((f) => f.id).sort()).toEqual(SCENARIOS.map((s) => s.id).sort());
  });

  it("records both an authorizing and a refusing outcome", () => {
    const kinds = new Set(parsed.fixtures.map((f) => (f.expected as { kind: string }).kind));
    expect(kinds).toEqual(new Set(["authorize", "refuse"]));
  });

  it("serialises every bigint as a decimal string so other languages read it losslessly", () => {
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (node !== null && typeof node === "object") {
        Object.values(node).forEach(walk);
      } else {
        expect(typeof node).not.toBe("bigint");
      }
    };
    walk(parsed);
    const amounts = parsed.fixtures
      .map((f) => f.expected as { txTemplate?: { Amount?: string } })
      .filter((e) => e.txTemplate !== undefined);
    for (const entry of amounts) expect(entry.txTemplate?.Amount).toMatch(/^\d+$/);
  });

  it("is deterministic across repeated builds", () => {
    expect(canonicalJson(buildFixtures())).toBe(canonicalJson(buildFixtures()));
  });

  it("still produces each recorded decision when the model is re-run", () => {
    for (const scenario of SCENARIOS) {
      const fixture = parsed.fixtures.find((f) => f.id === scenario.id);
      expect(fixture, `no fixture for scenario ${scenario.id}`).toBeDefined();
      if (fixture === undefined) continue;
      const decision = decide(scenario.mutate(baseInput()));
      expect(canonicalJson(decision), `fixture ${scenario.id} drifted`).toBe(canonicalJson(fixture.expected));
    }
  });

  it("pins the encoding constants the other languages must implement", () => {
    expect(parsed.authorizationDomain).toBe("SIGNET_FASSETS_REDEMPTION_V1");
    expect(parsed.obligationDomain).toBe("SIGNET_FASSETS_OBLIGATION_V1");
    expect(parsed.authorizationPreimageLength).toBe(431);
    expect(parsed.obligationPreimageLength).toBe(141);
    expect(parsed.schemaVersion).toBe(1);
  });
});
