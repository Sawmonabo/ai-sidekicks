// Every console barrel re-export is consumed in production, or it names the task
// that will consume it.
//
// WHY THE DEAD-CODE GATE CANNOT MAKE THIS CLAIM. knip resolves entry points and
// reports what none of them reaches, and every co-located `*.test.ts(x)` is a Vitest
// entry. So a barrel specifier only a test imports IS reached, and knip is right to
// say so — the module graph really does reach it. What knip cannot say is that the
// only thing reaching it is the suite covering it, which is the shape a family door
// grows when a symbol is published for a consumer that never arrived. Narrowing
// knip's entry set to exclude tests would not fix that: every test file would then
// report as an unused file and every test-only helper as an unused export, which is
// a louder wrong answer.
//
// Nor can the `@consumedBy` marker carry it alone. That marker is honoured only
// while knip agrees the export is unreferenced; the moment a test imports the name
// through the barrel, `--treat-tag-hints-as-errors` fails the run on the surviving
// tag. So a specifier whose only reader is a test can be neither tagged nor silent —
// which is exactly the state this gate exists to name.
//
// THE RULE. For every `export { … } from` specifier in a console `index.ts`:
//
//   PASS  a non-test module imports that symbol — through this barrel, through
//         another barrel that publishes it, or from the module that declares it.
//         Doors resolve to the DECLARING module, so "consumed through a different
//         door" is a pass rather than a second census.
//   PASS  the specifier names the task that will import it — `@consumedBy
//         T-023p-1C-<n>` where the dead-code gate needs its one exemption, or the
//         `// Consumed by T-023p-1C-<n>` line `apps/desktop/AGENTS.md` describes
//         where it does not, since a tag knip does not need is a tag
//         `--treat-tag-hints-as-errors` fails the run on.
//   FAIL  otherwise. The failure names the barrel, the specifier, and the test-only
//         importers reaching it, because those are what a disposition moves.
//   FAIL  also when a claim outlived its consumer: a claimed specifier a production
//         module now imports THROUGH THIS DOOR is the event the claim named, and the
//         marker is deleted in that PR. Inside the dead-code gate the tag's own hint
//         says so; it cannot wherever knip already counts the specifier referenced,
//         which is why the retirement is stated here too.
//
// The rule itself is `barrel-census.ts` beside this file, and the reading it judges
// is `barrel-syntax.ts` beside that. THIS FILE RUNS THEM OVER THE REAL CONSOLE;
// `barrel-census-rule.test.ts` beside it runs them over corpora written by hand to
// fail, which is the same split the tier's other census gates take and the reason
// the module set is a parameter at all. The walk stays here, where the source-walk
// chokepoint can see that it is the shared one.

import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import { findingLines, isConsoleBarrel, readCensus, type CensusReading } from "./barrel-census.js";
import type { CensusModule } from "./barrel-syntax.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_CONSOLE_ROOT = resolve(HERE, "..");
const RENDERER_SOURCE_ROOT = resolve(CONSOLE_DIRECTORY, "..");
const DESKTOP_ROOT = resolve(CONSOLE_DIRECTORY, "..", "..", "..", "..");

/** Where a console module sits in the census, and in a failure message. */
const CONSOLE_PREFIX = "src/renderer/src/console";

/**
 * The two roots that hold every module able to import a console door.
 *
 * The renderer root rather than the console root, because the composition root above
 * the families imports two of them; and the console tiers, because a specifier only
 * they reach is the whole finding class. `src/main/` and `src/preload/` are outside
 * on purpose — ESLint bans them from importing renderer source at all, so a root
 * that could contribute no consumer would only slow the walk.
 */
const CENSUS_ROOTS: readonly string[] = [RENDERER_SOURCE_ROOT, TEST_CONSOLE_ROOT];

function toKey(absolutePath: string): string {
  return relative(DESKTOP_ROOT, absolutePath).split("\\").join("/");
}

/** The console and the tiers that read it, as the census reads them. */
function consoleCensusModules(): readonly CensusModule[] {
  return consoleSourceModules({ roots: CENSUS_ROOTS, tests: true }).map((module) => ({
    path: toKey(module.absolutePath),
    source: readConsoleSourceModule(module),
    isTest:
      module.directory === TEST_CONSOLE_ROOT ||
      /\.test(-support)?\.tsx?$/.test(module.relativePath),
  }));
}

/**
 * What one reading of this console costs, measured on 2026-09-05 over 486 modules.
 *
 * Walking the two roots and reading every file: 279 ms. Parsing that set once:
 * 2 756 ms. Asking the census's four questions the way this file used to, each
 * through its own entry point and so each through its own parse: 8 680 ms — which is
 * why a case that was the first to ask exceeded vitest's 5 000 ms default, alone at
 * 4.29 s and at 12.9 s under the gate's five-project turbo concurrency, and timed out
 * three times across two lanes with no code change between runs.
 *
 * Three runs of this file either way, same machine, same tree: four parses took
 * 3.32 s / 6.40 s / 13.39 s wall, all of it invisible in the case timings because a
 * `describe` body is charged to COLLECTION (`import 3.07 / 6.11 / 12.90 s`, cases
 * 0-30 ms). One parse takes 3.87 s / 4.99 s / 2.87 s, of which the hook is
 * 2.02 / 2.56 / 1.38 s and every case is still 0-4 ms. The spread on both sides is
 * machine load, which is the point: the reading is what load multiplies, so the fix
 * is to do it once rather than to budget four of it.
 *
 * TWO BUDGETS, AND THEY ARE DELIBERATELY DIFFERENT SIZES. The hook pays for the whole
 * reading, so its allowance is sized to the parse under the load that produced the
 * failure — ~3.0 s alone, ~13 s at the concurrency measured above — and set at
 * roughly twice the worst of those, because what a budget guards is a parse that
 * never settles rather than a slow one. The cases pay for a comparison over a reading
 * that is already finished, measured at 0-3 ms each, so the test budget is
 * deliberately NOT sized to the parse: a case that somehow became the first to touch
 * the reading should fail here quickly and say so, not inherit the hook's patience.
 * It is stated rather than defaulted so neither number is a fact a reader has to know
 * vitest's defaults to check.
 */
const CONSOLE_READING_ALLOWANCE_MS = 30_000;
const COMPARISON_ALLOWANCE_MS = 10_000;

vi.setConfig({ testTimeout: COMPARISON_ALLOWANCE_MS, hookTimeout: CONSOLE_READING_ALLOWANCE_MS });

/**
 * The one reading this file pays for, and the cases' only source.
 *
 * Behind a private field with a throwing accessor rather than a mutable
 * module-level binding, on `console-layering-cruise.ts`'s reasoning: a `let`
 * shared by every case is reachable from a case that runs before the hook that fills
 * it, and `undefined` there reads as an empty census — every claim in this file
 * passing over nothing. The accessor makes that state say what it is.
 */
class ConsoleCensus {
  #reading: CensusReading | undefined;

  public read(modules: readonly CensusModule[]): void {
    this.#reading = readCensus(modules);
  }

  public get reading(): CensusReading {
    if (this.#reading === undefined) {
      throw new Error("the console census was read by a case before the hook that fills it ran");
    }
    return this.#reading;
  }
}

describe("barrel census — every console re-export has a reader or a claimant", () => {
  const modules = consoleCensusModules();
  const census = new ConsoleCensus();

  // In a hook rather than in this block, so the parse is paid when the file RUNS and
  // not when it is collected. A collected-but-filtered file — `-t` naming a case in
  // another suite, a `.only` elsewhere — otherwise pays the whole reading to run
  // nothing, and a throw during collection is reported as a file that failed to load
  // rather than as the budget it exceeded.
  beforeAll(() => {
    census.read(modules);
  });

  it("negative control: a case reaching the reading before the hook says so", () => {
    // The accessor's whole reason. An unfilled `let` would answer `undefined`, and
    // every claim in this file reads a list off it — so the file would pass over an
    // empty census and report a clean console it never looked at.
    expect(() => new ConsoleCensus().reading).toThrowError(/before the hook/);
  });

  it("finds the console and the tiers that read it", () => {
    // Without a floor a wrong root would scan nothing, and every claim below would
    // pass over the empty set.
    const barrels = modules.filter((module) => isConsoleBarrel(module.path));
    expect(barrels.length).toBeGreaterThan(8);
    expect(barrels.map((module) => module.path)).toContain(`${CONSOLE_PREFIX}/core/index.ts`);
    expect(modules.filter((module) => module.isTest).length).toBeGreaterThan(50);
    expect(modules.filter((module) => !module.isTest).length).toBeGreaterThan(50);
  });

  it("reads a specifier count no hand-maintained list could hold", () => {
    expect(census.reading.specifiers.length).toBeGreaterThan(200);
  });

  it("censuses every door that forwards, so a clause leaving is not a shortfall", () => {
    // The floor above bounds the TOTAL from below, so one clause dropping out of it
    // is invisible — which is exactly what a clause body read up to the first `}` did
    // to a door line whose comment carried a brace. Per door it is visible: a door
    // the specifier census is silent about is either a door that forwards nothing or
    // a door whose clause was dropped, and the two readings that tell those apart are
    // held against each other here.
    //
    // The right-hand side was a hand-maintained list until this became a comparison.
    // Every view family's door is a composition site that forwards nothing, so every
    // family landing appended its own path to that list in its own branch — four
    // branches editing three lines, which is a conflict by construction and never a
    // claim about the tree.
    const censused = new Set(census.reading.specifiers.map((entry) => entry.barrelPath));
    const silent = modules
      .map((module) => module.path)
      .filter((path) => isConsoleBarrel(path) && !censused.has(path));

    expect([...silent].sort()).toStrictEqual(census.reading.doorsForwardingNothing);
  });

  it("finds doors on both sides of the forwarding reading, so neither list is empty", () => {
    // Both claims above compare two sets, and two empty sets are equal. The console
    // has doors of each kind by construction — a family door that composes, a leaf
    // door that republishes — so an empty side is a reading that stopped working.
    const doors = modules.map((module) => module.path).filter((path) => isConsoleBarrel(path));
    const { doorsForwardingNothing } = census.reading;
    expect(doorsForwardingNothing.length).toBeGreaterThan(0);
    expect(doors.length).toBeGreaterThan(doorsForwardingNothing.length);
  });

  it("no barrel forwards a name this census cannot enumerate", () => {
    expect(census.reading.unenumerableForwarders).toStrictEqual([]);
  });

  it("every barrel specifier is production-consumed or claimed by its task", () => {
    expect(findingLines(census.reading.findings)).toStrictEqual([]);
  });
});
