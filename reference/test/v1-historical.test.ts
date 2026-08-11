/**
 * The V1 fixture set, preserved.
 *
 * V1 is no longer a decision the model can make: a V1 input refuses `S001_UNKNOWN_SCHEMA`, because
 * V1 has no field for the underlying observation and accepting it would mean accepting exactly the
 * blindness that produced the duplicate payment on Coston2 request 44928272.
 *
 * The file stays anyway, and this test holds it byte-for-byte. It is the record of what the system
 * committed to before the correction, and every V1 authorization commitment ever published is only
 * checkable against it. Deleting it would make old evidence unverifiable, which is a strange way to
 * respond to having found a defect.
 *
 * Nothing here re-runs the V1 decision. The file is evidence, not a live conformance target.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/fixtures.ts";
import { toHex } from "../src/bytes.ts";
import { decide } from "../src/decide.ts";
import { SIGNET_SCHEMA_VERSION } from "../src/types.ts";

const V1_PATH = fileURLToPath(new URL("../test-vectors/decision-fixtures-v1-historical.json", import.meta.url));
const v1 = JSON.parse(readFileSync(V1_PATH, "utf8"));

/** The hash frozen by the phase 01 gate, before V2 existed. */
const FROZEN_V1_SET_HASH = "0x73368da32c57e012df479ab15389b2b1f5c133eb6b494bf1f7968e644567f69c";

describe("the V1 fixture set is preserved as historical evidence", () => {
  it("still carries the hash the phase 01 gate froze", () => {
    expect(v1.fixtureSetHash).toBe(FROZEN_V1_SET_HASH);
  });

  it("is internally consistent: the recorded hash is the hash of the recorded fixtures", () => {
    const recomputed = toHex(keccak_256(new TextEncoder().encode(canonicalJson(v1.fixtures))));
    expect(recomputed).toBe(FROZEN_V1_SET_HASH);
  });

  it("records the V1 encoding lengths, which V2 deliberately changed", () => {
    expect(v1.schemaVersion).toBe(1);
    expect(v1.authorizationPreimageLength).toBe(431);
    expect(v1.obligationPreimageLength).toBe(141);
  });

  it("describes a schema the model no longer accepts", () => {
    expect(SIGNET_SCHEMA_VERSION).toBe(2);
    const anyV1Input = { ...v1.fixtures[0].input };
    expect(Number(anyV1Input.domain.schemaVersion)).toBe(1);
  });

  it("refuses every V1 input rather than interpreting it", () => {
    // Only the schema gate is exercised: a V1 input is rejected on version alone, before any field
    // it does carry is read. That is the property that matters.
    //
    // One V1 fixture is excluded, and the reason is worth recording. `refuse-unknown-schema` proved
    // V1 rejected unknown versions by setting the version to 2, which at the time was not a version
    // at all. Version 2 is now the real one, so that fixture's input is a valid V2 domain and is no
    // longer a test of anything. It is the one place where bumping a schema turned an old negative
    // case into a positive one.
    const stillV1 = v1.fixtures.filter(
      (f: { input: { domain: { schemaVersion: number } } }) => Number(f.input.domain.schemaVersion) === 1,
    );
    expect(stillV1.length).toBe(v1.fixtures.length - 1);

    for (const fixture of stillV1.slice(0, 12)) {
      const revived = {
        domain: {
          schemaVersion: Number(fixture.input.domain.schemaVersion),
          flareChainId: BigInt(fixture.input.domain.flareChainId),
          instructionSender: fixture.input.domain.instructionSender,
          assetManager: fixture.input.domain.assetManager,
          xrplNetworkId: fixture.input.domain.xrplNetworkId,
        },
        binding: null,
        redemption: null,
        xrpl: null,
        policy: {
          policyVersion: 1,
          extensionId: 0n,
          extensionCodeHash: `0x${"00".repeat(32)}` as const,
          revokedCodeHashes: [],
          paused: false,
          safetyMarginLedgers: 0,
          safetyMarginSeconds: 0n,
          ledgerCloseIntervalSeconds: 1n,
          minimumUnderlyingSources: 1,
          maxObservationAgeLedgers: 0,
        },
        prior: [],
        underlying: null,
      };
      const decision = decide(revived);
      expect(decision.kind).toBe("refuse");
      if (decision.kind === "refuse") expect(decision.reason).toBe("S001_UNKNOWN_SCHEMA");
    }
  });
});
