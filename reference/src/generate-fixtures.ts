#!/usr/bin/env node
/**
 * Regenerates reference/test-vectors/decision-fixtures.json.
 *
 * Run this only when the specification itself changes. The phase gate compares the committed file
 * against a fresh build, so an accidental drift fails rather than being silently absorbed.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildFixtures, serialiseFixtures } from "./fixtures.ts";

const target = fileURLToPath(new URL("../test-vectors/decision-fixtures-v2.json", import.meta.url));
const file = buildFixtures();
writeFileSync(target, serialiseFixtures(file));
console.log(`wrote ${file.fixtures.length} fixtures, fixtureSetHash=${file.fixtureSetHash}`);
