import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./source-lock.mjs";
import { selectorOf } from "./evm.mjs";

const ARTIFACT_DIR = join(REPO_ROOT, "contracts", "out");

function canonicalType(input) {
  if (input.type.startsWith("tuple")) {
    const inner = input.components.map(canonicalType).join(",");
    return `(${inner})${input.type.slice("tuple".length)}`;
  }
  return input.type;
}

export function canonicalSignature(abiEntry) {
  return `${abiEntry.name}(${(abiEntry.inputs ?? []).map(canonicalType).join(",")})`;
}

export function loadAbi(fileName, contractName) {
  const path = join(ARTIFACT_DIR, fileName, `${contractName}.json`);
  return JSON.parse(readFileSync(path, "utf8")).abi;
}

/**
 * Resolves a set of function names in a compiled interface to their canonical signature
 * and selector. Throws when a name is missing, so an upstream interface change surfaces
 * as a hard failure instead of a silently dropped check.
 */
export function selectorsFor(fileName, contractName, functionNames) {
  const abi = loadAbi(fileName, contractName);
  return functionNames.map((name) => {
    const matches = abi.filter((e) => e.type === "function" && e.name === name);
    if (matches.length === 0) {
      throw new Error(`${contractName}.${name} not found in pinned ABI ${fileName}`);
    }
    if (matches.length > 1) {
      throw new Error(`${contractName}.${name} is overloaded in ${fileName}; disambiguate explicitly`);
    }
    const signature = canonicalSignature(matches[0]);
    return {
      signature,
      selector: selectorOf(signature),
      stateMutability: matches[0].stateMutability,
      inputCount: (matches[0].inputs ?? []).length,
      source: `${fileName}:${contractName}`,
    };
  });
}
