/**
 * Holds the hand-decoded struct layout to the pinned interface.
 *
 * The verifier reads `DataExt` positionally over raw `eth_call` output, which is the right call for
 * a file a skeptic has to trust, but it means a field added upstream would shift every value while
 * the decode still "succeeds". This test reads the field order out of the pinned Solidity source, so
 * the day that happens the verifier fails loudly instead of comparing the wrong numbers.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DATA_EXT_LAYOUT } from "../src/fassets.ts";

const SOURCE = fileURLToPath(
  new URL("../../upstream/fassets/contracts/userInterfaces/data/RedemptionRequestInfo.sol", import.meta.url),
);

/** Field declarations inside `struct DataExt`, in source order, comments stripped. */
function declaredFields(): string[] {
  const source = readFileSync(SOURCE, "utf8");
  const start = source.indexOf("struct DataExt {");
  const body = source.slice(start + "struct DataExt {".length, source.indexOf("}", start));
  return body
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.endsWith(";"))
    .map((line) => line.slice(0, -1).trim().split(/\s+/).pop()!);
}

describe("DataExt layout", () => {
  const fields = declaredFields();

  it("matches the pinned interface, field for field", () => {
    for (const [name, index] of Object.entries(DATA_EXT_LAYOUT)) {
      expect(fields[index], `${name} should be word ${index}`).toBe(name);
    }
  });

  it("reads a struct with at least as many fields as the verifier indexes", () => {
    expect(fields.length).toBeGreaterThanOrEqual(Math.max(...Object.values(DATA_EXT_LAYOUT)) + 1);
  });
});
