#!/usr/bin/env node
/**
 * Tests for the doctor's decoding and severity logic.
 *
 * These exist because the first version of `decodeAddressArray` read the second head word of a
 * two-array return as a length, got 96, and reported ninety-six machines that do not exist. A
 * diagnostic that invents findings is worse than no diagnostic, so the pure logic is tested against
 * real ABI blobs rather than only exercised against whatever the chain happens to return today.
 *
 * Network reads are not tested here: they are what `make doctor` itself exercises.
 */
import { decodeAddressArray, decodeString, severityOfMachineCount, SEVERITY } from "./doctor.mjs";

let failures = 0;
const check = (name, condition, detail = "") => {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
};

const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const addressWord = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");

// ---------------------------------------------------------------- decodeAddressArray

// The exact blob the live FlareTeeManager returns for an extension with no machines: two dynamic
// arrays, both empty. Head words are offsets 0x40 and 0x60, not lengths.
const EMPTY_TWO_ARRAYS = `0x${word(0x40)}${word(0x60)}${word(0)}${word(0)}`;
check(
  "an extension with no machines decodes to zero machines",
  decodeAddressArray(EMPTY_TWO_ARRAYS).length === 0,
  `got ${decodeAddressArray(EMPTY_TWO_ARRAYS).length}`,
);

// The regression: reading head word 1 as a length yields 96 phantom entries.
check(
  "the second head word is not mistaken for a length",
  decodeAddressArray(EMPTY_TWO_ARRAYS).length !== 96,
);

const ONE = `0x${word(0x40)}${word(0xa0)}${word(1)}${addressWord("0xBEEF00000000000000000000000000000000BEEF")}${word(0)}`;
check("one machine decodes to one address", decodeAddressArray(ONE).length === 1);
check(
  "the decoded address is the one encoded",
  decodeAddressArray(ONE)[0].toLowerCase() === "0xbeef00000000000000000000000000000000beef",
  decodeAddressArray(ONE)[0],
);

const TWO = `0x${word(0x40)}${word(0xc0)}${word(2)}${addressWord("0x1111111111111111111111111111111111111111")}${addressWord("0x2222222222222222222222222222222222222222")}${word(0)}`;
check("two machines decode to two addresses", decodeAddressArray(TWO).length === 2);

// Truncation must not produce entries. A partial answer that looks like a full one is the failure
// mode this whole tool exists to catch.
check("a truncated blob decodes to nothing rather than garbage", decodeAddressArray("0x1234").length === 0);
check("an empty answer decodes to nothing", decodeAddressArray("0x").length === 0);
check(
  "a length longer than the payload is refused rather than padded",
  decodeAddressArray(`0x${word(0x20)}${word(50)}`).length === 0,
);

// ---------------------------------------------------------------- decodeString

const url = "https://signet.example/proxy";
const urlHex = Buffer.from(url, "utf8").toString("hex").padEnd(64, "0");
check(
  "a registered URL decodes",
  decodeString(`0x${word(0x20)}${word(url.length)}${urlHex}`) === url,
  decodeString(`0x${word(0x20)}${word(url.length)}${urlHex}`),
);
check("an empty registered URL decodes to empty", decodeString(`0x${word(0x20)}${word(0)}`) === "");
check("a truncated string decodes to empty rather than throwing", decodeString("0x00") === "");

// ---------------------------------------------------------------- severity

check(
  "zero machines is unavailable when the deployment does not claim one",
  severityOfMachineCount(0, false) === SEVERITY.UNAVAILABLE,
);
check(
  "zero machines is a failure when the deployment claims one",
  severityOfMachineCount(0, true) === SEVERITY.FAIL,
  "a manifest that disagrees with the chain is the stale-identity bug",
);
check("one machine passes", severityOfMachineCount(1, true) === SEVERITY.PASS);
check(
  "more than one active machine warns loudly",
  severityOfMachineCount(2, true) === SEVERITY.WARN,
  "non-deterministic routing, and a stale identity can still be selected",
);
check("many machines still warn", severityOfMachineCount(7, true) === SEVERITY.WARN);

console.log(`\n${failures === 0 ? "doctor tests pass" : `${failures} doctor tests failed`}`);
process.exit(failures === 0 ? 0 : 1);
