// Every remedy the console offers is keyed on a code the corpus actually registers.
//
// `core/refusal-remedies.ts` is the one table that says what a person can DO about a
// named daemon refusal, and its own doc claims every entry is "a code the corpus
// registers". That claim goes wrong SILENTLY: a key nothing sends answers `undefined`
// forever, `refusalRemedyFor` is never handed the string, and the copy behind it —
// written, reviewed, and shipped — reaches nobody. Nothing in the unit suite can
// catch it, because the unit suite reads the table's own keys.
//
// So the closed set is checked against the registry FILE, the way the tier's other
// closed-set tripwires check a claim against the artifact that decides it rather than
// against a copy of it. `error-contracts.md` is the corpus's registry of wire codes;
// a key absent from it is a key the daemon has no way to send.
//
// WHAT THIS DOES NOT CLAIM. Not that every registered code has a remedy — most have
// none, and the table's own header says an unlisted code renders exactly as it does
// today. The implication runs one way: table ⇒ registry.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { REMEDIED_REFUSAL_CODES } from "../../../src/renderer/src/console/core/refusal-remedies.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const ERROR_CONTRACTS_PATH = join(
  REPOSITORY_ROOT,
  "docs",
  "architecture",
  "contracts",
  "error-contracts.md",
);

/**
 * The registry's own text.
 *
 * Read once and asserted non-trivial before anything is checked against it: every
 * membership claim below is vacuously true over an empty string, so a moved or
 * renamed registry would otherwise report green while checking nothing.
 */
const errorContracts = readFileSync(ERROR_CONTRACTS_PATH, "utf8");

afterAll(() => {
  expect(errorContracts.length).toBeGreaterThan(1000);
});

/**
 * Whether the registry names this code.
 *
 * Containment rather than a table parse: the registry writes its codes in prose,
 * in tables, and inside backticks, and a parser tuned to one of those shapes would
 * answer "unregistered" for a code written in another. What is needed here is the
 * weakest true reading — the code appears in the registry at all — because the
 * failure this catches is a code that appears in it NOWHERE.
 */
function registryNames(code: string): boolean {
  return errorContracts.includes(code);
}

describe("the console's remedy table is keyed on registered wire codes", () => {
  it("names a code the registry carries for every entry", () => {
    expect(REMEDIED_REFUSAL_CODES.length).toBeGreaterThan(0);

    const unregistered = REMEDIED_REFUSAL_CODES.filter((code) => !registryNames(code));

    expect(unregistered).toEqual([]);
  });

  it("negative control: a code shaped like the others but registered nowhere fails it", () => {
    // Without this the check above could pass by reading a file that happens to
    // contain every string it is handed. `run.version_conflict` is the real case:
    // it was console vocabulary, it keyed a remedy row, and the corpus registers it
    // in no file — a stale comparand reaches the intervention lifecycle instead.
    expect(registryNames("run.version_conflict")).toBe(false);
    expect(registryNames("run.not_found")).toBe(true);
  });
});
