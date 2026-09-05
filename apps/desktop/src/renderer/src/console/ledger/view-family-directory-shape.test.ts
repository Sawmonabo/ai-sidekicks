// No directory in either of this lane's two view families is a pile.
//
// WHAT THE FINDING WAS. `ledger/frame/` held fifty-one modules over five separate
// seams — the reveal engine and its lanes, the scroll chokepoint, the virtualizer and
// its pruning, the measurement batch and the reading anchor, and the row chrome — and
// `ledger/pane/` held fifty-two more over four. A reader opening either met a list, not
// a design, and every module in it was one `../` away from every other, so nothing
// recorded which of them were allowed to know about which.
//
// AND THE FIRST VERSION OF THIS GATE READ ONE FAMILY. Its glob was anchored at
// `ledger/`, and the same task's other half grew the `workspace/` root from
// twenty-nine modules to forty-three — nine over the ceiling stated below, and
// invisible to the rule stating it. A ceiling that quantifies over every directory
// including the ones that do not exist yet still has to be pointed at the tree it is
// a claim about. It now reads both families this lane owns, at ONE ceiling: a second
// number would be a second answer to when a directory stops being one reading.
//
// ITS PROPER HOME IS THE ARCHITECTURE TIER, over `consoleSourceModules({ tests: true })`,
// so every family that lands later is inside the claim without an edit here. That is a
// console-wide gate and this file is not it; until it exists, the families it does read
// are named by their globs and by the case that proves the globs resolved.
//
// READING ANOTHER FAMILY IS NOT IMPORTING ONE. `import.meta.glob` is a build-time file
// read that resolves to keys and source text; no `import` statement and no dynamic
// `import()` reaches `workspace/` from here, so the console's DAG rule — a view family
// never imports a sibling — is untouched. What would break it is a `from "../workspace/…"`,
// which is why the rule under test is a function over a path list and not a call into
// either family.
//
// WHY A CEILING RATHER THAN A LIST OF DIRECTORIES. A list would have to be edited by
// every branch that adds a seam, which is a conflict by construction and never a claim
// about the tree — the same reasoning `barrel-census.ts` records for the door census it
// derives. A ceiling is a claim about every directory including the ones that do not
// exist yet, and it is the claim the finding actually makes: a directory stops being one
// reading somewhere between the thirty-three of the markdown pipeline and the fifty-one
// this family had twice.
//
// WHY 34 IS THE NUMBER. The largest directory the family keeps is `cards/markdown/`,
// whose thirty-three modules are ONE module by construction — a segmenter with no parse
// decides nothing, and a mapper with no segmenter re-parses the world — so the ceiling
// sits one above it rather than at a round number that would either indict that
// pipeline or admit the pile the finding named. A directory that reaches it is not
// forbidden from existing; it is required to say why in a header, which is the review
// this gate exists to force.
//
// THE RULE IS A FUNCTION OVER A PATH LIST so the negative control can run it over a
// corpus written by hand to fail, which is the split the architecture tier's census
// gates take and the reason the module set is a parameter at all.

import { describe, expect, it } from "vitest";

/** How many modules one directory may hold before it stops being one reading. */
const VIEW_FAMILY_DIRECTORY_MODULE_CEILING = 34;

/**
 * This module's own path, which its own glob does not report.
 *
 * Vite excludes the importing module from `import.meta.glob`, so a census of the
 * family's root directory taken from inside the family is short by exactly this file —
 * and a census that under-counts the directory it lives in is the one census that must
 * not be trusted.
 */
const THIS_MODULE = "./view-family-directory-shape.test.ts";

/**
 * Every module in the ledger family, by path relative to this file.
 *
 * Only the KEYS are read — the claim below is about where modules sit, not what they
 * say — but the glob is eager because `?raw` is how a renderer suite reads source at
 * all here: `node:fs` is banned in a renderer program, and the repo's glob typing
 * admits no lazy form.
 */
const ledgerModules: Record<string, string> = import.meta.glob("./**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * Every module in the workspace family, by path relative to this file.
 *
 * A SECOND GLOB RATHER THAN A WIDER ONE. `../**` would reach `console/` entire — every
 * substrate layer and every sibling family — and pass the ceiling over directories no
 * one here has read, which is the vacuous-claim shape the negative control exists to
 * rule out. Two named families are two claims a reader can check.
 */
const workspaceModules: Record<string, string> = import.meta.glob("../workspace/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The directory a module sits in, as the census names it. */
function directoryOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "." : path.slice(0, cut);
}

/** How many modules each directory holds, keyed by directory. */
function directoryCensus(paths: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const directory = directoryOf(path);
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  return counts;
}

/** Every directory over the ceiling, as lines a failure can name. */
function pilesIn(paths: readonly string[], ceiling: number): readonly string[] {
  return [...directoryCensus(paths)]
    .filter(([, count]) => count > ceiling)
    .map(
      ([directory, count]) =>
        `${directory} holds ${String(count)} modules (ceiling ${String(ceiling)})`,
    )
    .sort();
}

describe("the ledger and workspace families' directory shape", () => {
  const paths = [
    ...Object.keys(ledgerModules),
    ...Object.keys(workspaceModules),
    THIS_MODULE,
  ].sort();

  it("reads both families, so a wrong glob cannot pass over an empty set", () => {
    expect(paths.length).toBeGreaterThan(280);
    expect(directoryCensus(paths).size).toBeGreaterThan(24);
    // Directories from BOTH families' splits, named so a glob that resolved only one
    // family — or only a family root — fails here rather than passing the ceiling
    // vacuously over the half it never read.
    for (const directory of [
      "./frame/scroll",
      "./frame/viewport",
      "./pane/find",
      "./structure/seams",
      "../workspace/auxiliary",
      "../workspace/cast-bar",
      "../workspace/deck",
      "../workspace/layout",
      "../workspace/new-session",
    ]) {
      expect(directoryCensus(paths).has(directory)).toBe(true);
    }
  });

  it("holds no pile", () => {
    expect(pilesIn(paths, VIEW_FAMILY_DIRECTORY_MODULE_CEILING)).toStrictEqual([]);
  });

  it("negative control: the rule names a pile when there is one", () => {
    const piled = Array.from({ length: 51 }, (_, index) => `./frame/module-${String(index)}.ts`);
    expect(pilesIn([...piled, "./index.ts"], VIEW_FAMILY_DIRECTORY_MODULE_CEILING)).toStrictEqual([
      "./frame holds 51 modules (ceiling 34)",
    ]);
  });
});
