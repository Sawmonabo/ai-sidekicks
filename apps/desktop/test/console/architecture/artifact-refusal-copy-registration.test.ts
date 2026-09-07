// The console's `artifact.*` refusal copy and the corpus registry are the same set.
//
// ONE TABLE, ONE GATE. `repos/artifacts/artifact-refusal-copy.ts` is the console's only
// reading of an `artifact.*` refusal — what the code is about where the daemon's own
// sentence leaves it out, and what a person does next — and it is read by the manifest
// rows, the artifact pane, the ingest cards and the bounds disclosure alike. The
// attachment family kept a second four-code table of its own until that fold; this file
// is the gate the two of them used to need one each of.
//
// TWO CLAIMS, IN BOTH DIRECTIONS, and each catches a defect the other cannot:
//
//   • TABLE ⇒ REGISTRY. A key nothing can send is copy that was written, reviewed and
//     shipped to nobody: the lookup answers `undefined` forever, and no unit suite can
//     see it, because a unit suite reads the table's own keys.
//   • REGISTRY ⇒ TABLE. A code the corpus registers and the table does not answer
//     reaches a participant as a dotted string with nothing beside it. This is the
//     direction `refusal-remedy-registration.test.ts` deliberately does NOT claim —
//     most codes there have no remedy by design — and the direction this table exists
//     to make true: its own header says the namespace is one set, and a set claim is
//     only worth what checks it.
//
// THE REGISTRY IS PARSED FOR ONE SECTION AND CONTAINMENT-READ FOR THE OTHER, on purpose.
// The registry ⇒ table direction needs the ENUMERATED set, which only a parse of
// §Artifact's own table rows can give. The table ⇒ registry direction needs the weakest
// true reading — the code appears in the registry at all — because the failure it
// catches is a code that appears in it nowhere, in a file that writes its codes in
// prose, in tables, and inside backticks.
//
// THE REGISTRY'S `reserved` ROWS COUNT AS REGISTERED. Most `artifact.*` codes are
// reserved until Plan-014's own legs land, and a reserved row is a code the corpus has
// decided the daemon will send — which is exactly the claim both directions need.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { ARTIFACT_REFUSAL_CODES } from "../../../src/renderer/src/console/repos/artifacts/artifact-refusal-copy.js";

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

/**
 * Every `artifact.*` code the registry's own §Artifact table declares, in row order.
 *
 * A row is `| \`artifact.<name>\` | … | <status> |` and the code is its first cell, so
 * the parse anchors on the leading pipe-backtick pair and never on prose that happens
 * to mention a code. Anchoring on the line start is what keeps a code cited inside
 * another row's description — `artifact.hash_mismatch` is cited from three of them —
 * from being counted as a row of its own.
 */
function registeredArtifactCodes(): readonly string[] {
  const rows = errorContracts.matchAll(/^\| `(artifact\.[a-z_]+)` \|/gmu);
  return [...rows].map((row) => row[1] ?? "");
}

describe("the console's artifact refusal table is keyed on registered wire codes", () => {
  it("names a code the registry carries for every entry", () => {
    expect(ARTIFACT_REFUSAL_CODES.length).toBeGreaterThan(0);

    const unregistered = ARTIFACT_REFUSAL_CODES.filter((code) => !registryNames(code));

    expect(unregistered).toEqual([]);
  });

  it("negative control: a code shaped like the others but registered nowhere fails it", () => {
    // Without this the check above could pass by reading a file that happens to
    // contain every string it is handed.
    expect(registryNames("artifact.too_colourful")).toBe(false);
    expect(registryNames("artifact.too_many_attachments")).toBe(true);
  });
});

/** The table's own tuple, widened off its literal union so a wire string can be sought. */
const answeredCodes: readonly string[] = ARTIFACT_REFUSAL_CODES;

describe("the registry's artifact namespace is answered in full", () => {
  it("answers every code the §Artifact table declares", () => {
    const registered = registeredArtifactCodes();
    const unanswered = registered.filter((code) => !answeredCodes.includes(code));

    expect(unanswered).toEqual([]);
  });

  it("is the same set in both directions, in the registry's own row order", () => {
    // The table's own header claims it transcribes §Artifact "in that table's own row
    // order so a reader comparing the two reads them top to bottom". Asserted as an
    // ordered comparison rather than two set inclusions, because that is the claim.
    expect([...answeredCodes]).toStrictEqual([...registeredArtifactCodes()]);
  });

  it("negative control: the parse finds real rows and not prose mentions", () => {
    // Without this the two checks above pass vacuously over an empty parse the moment
    // the registry's table shape changes. The first assertion pins the section's real
    // size; the second is the row-versus-mention distinction the anchor exists for —
    // `run.not_found` is a registered code in a DIFFERENT section, so a parse that had
    // drifted into matching any registry line would pick it up here.
    const registered = registeredArtifactCodes();
    expect(registered.length).toBeGreaterThanOrEqual(10);
    expect(registered).not.toContain("run.not_found");
    expect(registered).toContain("artifact.no_access_key");
  });
});
