// No directory in this family is a pile.
//
// WHAT THE FINDING WAS. `ledger/frame/` held fifty-one modules over five separate
// seams — the reveal engine and its lanes, the scroll chokepoint, the virtualizer and
// its pruning, the measurement batch and the reading anchor, and the row chrome — and
// `ledger/pane/` held fifty-two more over four. A reader opening either met a list, not
// a design, and every module in it was one `../` away from every other, so nothing
// recorded which of them were allowed to know about which.
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
const LEDGER_DIRECTORY_MODULE_CEILING = 34;

/**
 * This module's own path, which its own glob does not report.
 *
 * Vite excludes the importing module from `import.meta.glob`, so a census of the
 * family's root directory taken from inside the family is short by exactly this file —
 * and a census that under-counts the directory it lives in is the one census that must
 * not be trusted.
 */
const THIS_MODULE = "./ledger-directory-shape.test.ts";

/**
 * Every module in the family, by path relative to it.
 *
 * Only the KEYS are read — the claim below is about where modules sit, not what they
 * say — but the glob is eager because `?raw` is how a renderer suite reads source at
 * all here: `node:fs` is banned in a renderer program, and the repo's glob typing
 * admits no lazy form.
 */
const familyModules: Record<string, string> = import.meta.glob("./**/*.{ts,tsx}", {
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

describe("the ledger family's directory shape", () => {
  const paths = [...Object.keys(familyModules), THIS_MODULE].sort();

  it("reads the whole family, so a wrong glob cannot pass over an empty set", () => {
    expect(paths.length).toBeGreaterThan(200);
    expect(directoryCensus(paths).size).toBeGreaterThan(18);
    // The four directories the finding's split produced, named so a glob that resolved
    // only the family root would fail here rather than pass the ceiling vacuously.
    for (const directory of [
      "./frame/scroll",
      "./frame/viewport",
      "./pane/find",
      "./structure/seams",
    ]) {
      expect(directoryCensus(paths).has(directory)).toBe(true);
    }
  });

  it("holds no pile", () => {
    expect(pilesIn(paths, LEDGER_DIRECTORY_MODULE_CEILING)).toStrictEqual([]);
  });

  it("negative control: the rule names a pile when there is one", () => {
    const piled = Array.from({ length: 51 }, (_, index) => `./frame/module-${String(index)}.ts`);
    expect(pilesIn([...piled, "./index.ts"], LEDGER_DIRECTORY_MODULE_CEILING)).toStrictEqual([
      "./frame holds 51 modules (ceiling 34)",
    ]);
  });
});
