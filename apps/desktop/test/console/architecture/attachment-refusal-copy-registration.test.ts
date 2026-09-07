// The attachment family's refusal copy is keyed on codes the corpus actually registers.
//
// Same class of defect and same instrument as `refusal-remedy-registration.test.ts`
// beside it, one table over: `repos/attachments/attachment-refusal-copy.ts` says what
// four named ingest refusals MEAN on the attachment surfaces, and a key nothing can
// send is copy that was written, reviewed, and shipped to nobody. The lookup answers
// `undefined` forever and no unit suite can see it, because a unit suite reads the
// table's own keys.
//
// TWO TABLES AND NOT ONE, deliberately, which is why this check is a second file rather
// than a widened import list next door. `core/refusal-remedies.ts` fills rule 9's action
// slot for codes that reach several surfaces and need one answer between them; these
// four reach one surface and carry a MEANING rather than a next move. What both tables
// share is the property this gate holds: table ⇒ registry.
//
// THE REGISTRY'S `reserved` ROWS COUNT AS REGISTERED. Every `artifact.*` code is
// reserved until Plan-014's own legs land, and a reserved row is a code the corpus has
// decided the daemon will send — which is exactly the claim this check needs.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { ATTACHMENT_REFUSAL_COPY_CODES } from "../../../src/renderer/src/console/repos/attachments/attachment-refusal-copy.js";

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
 * Read once and asserted non-trivial after the run: every membership claim below is
 * vacuously true over an empty string, so a moved or renamed registry would otherwise
 * report green while checking nothing.
 */
const errorContracts = readFileSync(ERROR_CONTRACTS_PATH, "utf8");

afterAll(() => {
  expect(errorContracts.length).toBeGreaterThan(1000);
});

/**
 * Whether the registry names this code.
 *
 * Containment rather than a table parse, on the sibling gate's reasoning: the registry
 * writes its codes in prose, in tables, and inside backticks, and the failure this
 * catches is a code that appears in it NOWHERE.
 */
function registryNames(code: string): boolean {
  return errorContracts.includes(code);
}

describe("the attachment family's refusal copy is keyed on registered wire codes", () => {
  it("names a code the registry carries for every entry", () => {
    expect(ATTACHMENT_REFUSAL_COPY_CODES.length).toBeGreaterThan(0);

    const unregistered = ATTACHMENT_REFUSAL_COPY_CODES.filter((code) => !registryNames(code));

    expect(unregistered).toEqual([]);
  });

  it("negative control: a code shaped like the others but registered nowhere fails it", () => {
    // Without this the check above could pass by reading a file that happens to
    // contain every string it is handed.
    expect(registryNames("artifact.too_colourful")).toBe(false);
    expect(registryNames("artifact.too_many_attachments")).toBe(true);
  });
});
