// No directory in the console is a pile, and the claim covers directories not yet cut.
//
// WHAT THE FINDING WAS. One view family wrote a directory-shape gate for itself, and
// its `import.meta.glob` was anchored at that family's own root — so a sibling family
// grew a directory to forty-three files with nothing reporting it, and no gate anywhere
// made the claim for the console as a whole. Six families are about to land at once.
// A per-family gate is a claim about the family that remembered to write one.
//
// WHY A CEILING RATHER THAN A LIST OF DIRECTORIES. A list would have to be edited by
// every branch that cuts a seam, which is a merge conflict by construction and never a
// claim about the tree — the same reasoning `barrel-census.ts` records for the door
// census it derives. A ceiling is a claim about every directory including the ones
// that do not exist yet.
//
// WHAT IS COUNTED, AND WHY IT IS NOT EVERY FILE. A co-located test does not make its
// directory harder to read: a reader opens the subject and the test sits beside it, so
// counting both would report a well-tested directory as a pile and push tests away
// from what they test. The door is excluded for the same reason in reverse — every
// directory has at most one and it is the thing a reader opens FIRST. So the count is
// the modules a reader has to hold at once: hand-written, non-test, non-door.
//
// WHY 42. Two readings already recorded in this tree bracket it. The lower is the
// thirty-three-module markdown pipeline one family keeps and defends as one module by
// construction — a segmenter with no parse decides nothing. The upper is the fifty-one
// that same family's finding named a pile outright. A directory stops being one
// reading somewhere between them, and 42 is the middle of that band: above every
// directory the console currently keeps, and below every directory anyone has looked
// at and called a pile. It catches the forty-three that went unseen by one, which is
// the finding this gate exists for.
//
// A directory that reaches it is not forbidden from existing. It is required to say
// why in a header — which is the review this gate exists to force, and the reason the
// remedy is never to raise the number.

import { beforeAll, describe, expect, it } from "vitest";

import { consoleSourceModules } from "../console-source-modules.js";

/** How many modules one console directory may hold before it stops being one reading. */
const CONSOLE_DIRECTORY_MODULE_CEILING = 42;

/** What a directory's door is called, and the one module a census does not count. */
const FAMILY_DOOR = "index.ts";

/**
 * The census, read once for the file.
 *
 * BUDGET. The walk is one `readdirSync` recursion over `console/` and `shell/` and no
 * file is opened — the claim is about where modules sit, not what they say — so the
 * read is 20-30 ms on the authoring machine over the 358 modules it currently returns,
 * measured 2026-09-05. Hoisted to the describe anyway, because four cases ask the same
 * question and a per-case walk would pay it four times for one reading.
 */
class DirectoryCensus {
  #displayPaths: readonly string[] = [];

  public read(): void {
    this.#displayPaths = consoleSourceModules().map((module) => module.displayPath);
  }

  /** Every module a reader has to hold at once, by display path. */
  public get displayPaths(): readonly string[] {
    return this.#displayPaths;
  }
}

/** The directory a module sits in, as a failure names it. */
function directoryOf(displayPath: string): string {
  const cut = displayPath.lastIndexOf("/");
  return cut === -1 ? "." : displayPath.slice(0, cut);
}

/**
 * How many countable modules each directory holds.
 *
 * A FUNCTION OVER A PATH LIST, so the negative control below can run the real rule
 * over a corpus written by hand to fail. A rule reachable only through the live walk
 * can be proved to pass and never proved to bite.
 */
function directoryCensus(displayPaths: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const displayPath of displayPaths) {
    if (displayPath.endsWith(`/${FAMILY_DOOR}`)) {
      continue;
    }
    const directory = directoryOf(displayPath);
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  return counts;
}

/** Every directory over the ceiling, as lines a failure can name. */
function pilesIn(displayPaths: readonly string[], ceiling: number): readonly string[] {
  return [...directoryCensus(displayPaths)]
    .filter(([, count]) => count > ceiling)
    .map(
      ([directory, count]) =>
        `${directory} holds ${String(count)} modules (ceiling ${String(ceiling)})`,
    )
    .sort();
}

describe("console structure — no directory is a pile", () => {
  const census = new DirectoryCensus();

  beforeAll(() => {
    census.read();
  });

  it("reads the whole console, so a wrong root cannot pass over an empty set", () => {
    // The vacuity floor. `console-source-modules.ts` contributes nothing for a root
    // that does not exist — `shell/` is absent on some branches by design — so every
    // caller asserts what it got back rather than trusting the walk.
    expect(census.displayPaths.length).toBeGreaterThan(200);
    const counts = directoryCensus(census.displayPaths);
    expect(counts.size).toBeGreaterThan(12);
    // Named directories rather than a bare size, so a walk that resolved only the
    // console root would fail here rather than pass the ceiling vacuously.
    for (const directory of ["console/bridge", "console/core", "console/frame", "console/store"]) {
      expect(counts.has(directory)).toBe(true);
    }
  });

  it("counts what a reader holds at once, and not the tests beside it", () => {
    // The counting rule as a claim rather than as a property of the walk's defaults:
    // a co-located test is excluded by the walk, and the door by the census, so a
    // change to either shows up here rather than as a ceiling that silently moved.
    expect(census.displayPaths.some((path) => path.includes(".test."))).toBe(false);
    expect(directoryCensus(["console/bridge/a.ts", `console/bridge/${FAMILY_DOOR}`])).toStrictEqual(
      new Map([["console/bridge", 1]]),
    );
  });

  it("holds no pile", () => {
    expect(pilesIn(census.displayPaths, CONSOLE_DIRECTORY_MODULE_CEILING)).toStrictEqual([]);
  });

  it("negative control: the rule names a pile when there is one", () => {
    const piled = Array.from(
      { length: CONSOLE_DIRECTORY_MODULE_CEILING + 1 },
      (_, index) => `console/workspace/module-${String(index)}.ts`,
    );

    expect(
      pilesIn([...piled, `console/workspace/${FAMILY_DOOR}`], CONSOLE_DIRECTORY_MODULE_CEILING),
    ).toStrictEqual(["console/workspace holds 43 modules (ceiling 42)"]);
  });
});
