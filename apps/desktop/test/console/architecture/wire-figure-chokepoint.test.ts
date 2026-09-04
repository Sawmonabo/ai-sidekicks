// The byte-scaling chokepoint, asserted.
//
// `Spec-023 §Console Design (Meridian)` §The eight rules holds the console to
// `Intl` for every derived quantity, and `primitives/wire-figures.ts` carries the
// single amendment to that rule: `Intl` has no kibibyte, so exactly one function
// scales by powers of 1024 and appends a label from a closed set. That module's
// header states this test exists and says what it asserts. Until this file it did
// not, so the one written claim standing between the console and a second byte
// formatter was a comment describing a test nobody had written — and `apps/desktop`
// AGENTS.md names "no second byte formatter" a chokepoint precisely because the
// second one is never introduced deliberately. It arrives as four lines in a
// component that needed a file size on screen.
//
// WHAT COUNTS AS SCALING, and why the line is drawn where it is. A binary unit
// LABEL is the giveaway: a module that scales bytes has to name the unit it scaled
// to, and a module that merely bounds a byte count does not. That is why
// `core/constants.ts` may hold `64 * 1024` — a cap is a bound, it names no unit,
// and nothing renders it — while `/ 1024` is flagged, because dividing is the
// scaling step itself. Multiplying up to a bound and dividing down to a display
// figure are different acts, and only one of them is this chokepoint's business.
//
// Test files are excluded: a test asserting that "1.0 KiB" renders has to write
// "1.0 KiB", and forbidding that would forbid testing the chokepoint's own output.

import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { consoleSourceModules, readConsoleSource } from "../console-source-modules.js";

/**
 * The one module allowed to scale a byte figure.
 *
 * An allow-list of exactly one, written as a path rather than inferred from a
 * naming convention, so moving the chokepoint is an edit a reviewer sees.
 */
const CHOKEPOINT_MODULE = join("primitives", "wire-figures.ts");

/**
 * The binary unit labels. Naming one of these in a source module is the
 * observable signature of having scaled a byte count for display.
 */
const BINARY_UNIT_LABELS: readonly string[] = ["KiB", "MiB", "GiB", "TiB"];

/**
 * The scaling step, in the forms it can be written.
 *
 * Division only. See the header: multiplying by 1024 bounds a value, dividing by
 * it converts one for a reader.
 */
const SCALING_STEP_FORMS: readonly string[] = [
  "/ 1024",
  "/= 1024",
  "/ BYTE_UNIT_STEP",
  "/= BYTE_UNIT_STEP",
];

/**
 * Every way `source` shows it scaled a byte figure, or `[]`.
 *
 * A pure function over text rather than a loop inside a test, so the negative
 * controls below can drive it with strings whose verdict is known and the checker
 * is proved to bite without perturbing a real module.
 */
function byteScalingSignatures(source: string): readonly string[] {
  return [...BINARY_UNIT_LABELS, ...SCALING_STEP_FORMS].filter((form) => source.includes(form));
}

describe("wire-figure-formatting — byte scaling happens in exactly one module", () => {
  const modules = consoleSourceModules();

  it("finds a console tree to scan at all", () => {
    // Without this, a wrong console directory would scan nothing and every
    // assertion below would pass over the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(modules).toContain(CHOKEPOINT_MODULE);
  });

  it("no other module names a binary unit or divides by the scaling step", () => {
    const offenders = modules
      .filter((module) => module !== CHOKEPOINT_MODULE)
      .map((module) => ({ module, signatures: byteScalingSignatures(readConsoleSource(module)) }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${relative(".", entry.module)}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the chokepoint itself trips every signature", () => {
    // The checker reads real files and the needles match real code. Without this,
    // a typo in a needle would make the clean result above meaningless.
    const signatures = byteScalingSignatures(readConsoleSource(CHOKEPOINT_MODULE));
    for (const label of BINARY_UNIT_LABELS) {
      expect(signatures).toContain(label);
    }
    // The division form is asserted as a CLASS, not as one spelling: the module
    // writes `scaled /= BYTE_UNIT_STEP`, and pinning `/ BYTE_UNIT_STEP` here made
    // this control fail against a chokepoint that was doing exactly its job.
    expect(SCALING_STEP_FORMS.filter((form) => signatures.includes(form))).not.toStrictEqual([]);
  });

  it("negative control: a byte cap is not scaling, and a unit label is", () => {
    // The two sides of the line the header draws, asserted against the predicate
    // rather than against whichever module happens to hold a cap today.
    expect(byteScalingSignatures("export const CAP: number = 64 * 1024;")).toStrictEqual([]);
    expect(byteScalingSignatures('const label = "KiB";')).toStrictEqual(["KiB"]);
    expect(byteScalingSignatures("const scaled = total / 1024;")).toStrictEqual(["/ 1024"]);
  });
});
