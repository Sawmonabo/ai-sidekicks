// Where a file NAME is classified, and that the split which moved it is real.
//
// `console-source-modules.ts` had grown to 404 lines holding two jobs: the WALK
// — roots, recursion, display path, read — and the classification of a name
// against it. The package's own threshold says a file that long is doing two
// jobs, and this one was, so the name test moved to
// `console-source-classification.ts` beside it.
//
// A SPLIT IS ONLY A SPLIT IF THE SECOND HOME IS THE ONLY HOME. Moving the
// declarations and leaving a second extension list or a second declaration
// pattern behind produces two answers to one question, which is the drift the
// walk itself was hoisted to end and is invisible from either side: a module one
// list admits and the other refuses is simply absent from one set, so no claim
// made over that set can report it. The size claim is therefore the smaller half
// here; the substantive one is that the walk asks rather than decides.
//
// AND THE LEAF STAYS A LEAF. What lets a gate that wants only the name test take
// it — the spawn chokepoint's declaration control, the body-allowance census's
// extension loop — is that it pulls no recursive directory read in behind it. An
// import added there would put the walk back on their import graph while every
// assertion in this file still passed, so the emptiness is asserted rather than
// assumed.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { TYPESCRIPT_MODULE_EXTENSIONS } from "../console-source-classification.js";
import {
  consoleSourceModules,
  DESKTOP_PROSE_ROOTS,
  readModuleNamed,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";
import { moduleSpecifiersIn } from "./source-walk-census.js";

/** The two halves of the split, by the display path the package-wide walk gives them. */
const WALK_MODULE = "test/console/console-source-modules.ts";
const CLASSIFICATION_MODULE = "test/console/console-source-classification.ts";

/**
 * The length at which `AGENTS.md §Module shape` says a file is doing two jobs.
 *
 * "About 400 lines", read as a bound rather than as a mood: a threshold a gate
 * cannot state is a threshold nothing enforces, and the figure is the package's
 * own rather than this file's. It is applied HERE to the split pair and not to
 * the tree, because the tree carries files past it that this PR neither authored
 * nor is splitting — a package-wide gate is a different change with a different
 * blast radius, and stating it as one here would either fail on arrival or be
 * exempted into meaninglessness.
 */
const SPLIT_THRESHOLD_LINES = 400;

/** Whether a module of `lines` is past the point at which the package splits it. */
function isDoingTwoJobs(lines: number): boolean {
  return lines > SPLIT_THRESHOLD_LINES;
}

/** The pair, walked and read once for the whole file. */
const MODULES = consoleSourceModules({ roots: DESKTOP_PROSE_ROOTS, tests: true });

function linesOf(displayPath: string): number {
  return readModuleNamed(MODULES, displayPath, "a half of the source-classification split").split(
    "\n",
  ).length;
}

/** Every string literal the module writes, read off the parse rather than the text. */
function stringLiteralsIn(displayPath: string): readonly string[] {
  const source = readModuleNamed(MODULES, displayPath);
  const literals: string[] = [];
  forEachDescendant(parseSourceText(displayPath, source), (node) => {
    if (ts.isStringLiteral(node)) {
      literals.push(node.text);
    }
  });
  return literals;
}

/** Every regular expression the module writes, likewise off the parse. */
function regularExpressionsIn(displayPath: string): readonly string[] {
  const source = readModuleNamed(MODULES, displayPath);
  const patterns: string[] = [];
  forEachDescendant(parseSourceText(displayPath, source), (node) => {
    if (ts.isRegularExpressionLiteral(node)) {
      patterns.push(node.text);
    }
  });
  return patterns;
}

describe("the source walk and the name test are two modules", () => {
  it("keeps each half under the length at which this package splits a file", () => {
    const walkLines = linesOf(WALK_MODULE);
    const classificationLines = linesOf(CLASSIFICATION_MODULE);

    expect(isDoingTwoJobs(walkLines), `${WALK_MODULE} is ${String(walkLines)} lines`).toBe(false);
    expect(
      isDoingTwoJobs(classificationLines),
      `${CLASSIFICATION_MODULE} is ${String(classificationLines)} lines`,
    ).toBe(false);
    // And the split is doing work rather than being cosmetic: the two halves
    // together are past the threshold, so this is a file that had to be divided
    // and not one that was tidied into two.
    expect(
      isDoingTwoJobs(walkLines + classificationLines),
      "the two halves together fit under the threshold, so nothing here needed splitting and the second module is ceremony",
    ).toBe(true);
  });

  it("negative control: the threshold answers yes to the length that forced the split", () => {
    // Without this the case above passes over any threshold generous enough by
    // accident — including one raised until the tree fits. The figure driven is
    // the module's own measured length before the split, so the control is a
    // fact about this change rather than a number invented for it.
    expect(isDoingTwoJobs(404)).toBe(true);
    expect(isDoingTwoJobs(SPLIT_THRESHOLD_LINES)).toBe(false);
  });

  it("leaves the walk asking for a classification rather than making one", () => {
    // THE SUBSTANTIVE CLAIM. A second extension list or a second declaration
    // pattern left behind is two answers to one question, and the module each
    // list refuses is absent from that walk's set — so no claim over the set
    // reports the disagreement.
    const literals = stringLiteralsIn(WALK_MODULE);
    for (const extension of TYPESCRIPT_MODULE_EXTENSIONS) {
      expect(
        literals,
        `${WALK_MODULE} names ${extension} itself — the extension set has two homes and they will drift`,
      ).not.toContain(extension);
    }
    for (const pattern of regularExpressionsIn(WALK_MODULE)) {
      expect(
        pattern,
        `${WALK_MODULE} matches declaration files with a pattern of its own`,
      ).not.toContain("\\.d\\.");
    }
    // The positive half: it reaches the one home. Asserting only the absences
    // above would pass over a walk that had stopped classifying anything.
    expect(stringLiteralsIn(WALK_MODULE)).toContain("./console-source-classification.js");
  });

  it("keeps the name test a leaf, so a gate that wants it pulls in no directory read", () => {
    const source = readModuleNamed(MODULES, CLASSIFICATION_MODULE);
    expect(
      moduleSpecifiersIn(source, CLASSIFICATION_MODULE),
      `${CLASSIFICATION_MODULE} imports something — the gates that take it for the name test alone now carry whatever it reached for`,
    ).toStrictEqual([]);
    // Its own set is what every consumer quantifies over, so an empty one would
    // make each of those claims vacuous while every case here stayed green.
    expect(TYPESCRIPT_MODULE_EXTENSIONS.length).toBeGreaterThan(0);
  });
});
