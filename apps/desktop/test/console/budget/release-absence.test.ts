// Tier: bundle — what a RELEASE build must not contain.
//
// The fixture bridge, every scenario, the pane harness and the fixture handles sit behind
// `__SIDEKICKS_CONSOLE_FIXTURES__`, so a release build folds `if (false) { … }` and the
// bodies are PHYSICALLY ABSENT from what ships, not merely unreachable. The distinction is
// the point: unreachable code still hands anyone who reads the file a way into the
// console's internals and a set of fabricated sessions.
//
// The mechanism is written in source and checked in review. This file checks the OUTCOME,
// on the artifact a person would install, because a define that was misspelled, dropped
// from one build mode, or defeated by a bundler setting leaves the mechanism intact and
// the outcome wrong. It reads no source text: every subject is either the build's own
// output or a constant imported from the module that declares it.
//
// TWO CHECKS, BECAUSE FIXTURE CODE LIVES IN TWO PLACES.
//
// Whole modules. Every build target writes hidden source maps, and a map's `sources` is
// the bundler's own list of the modules that rendered code into that file.
// `isFixtureOnlyModule` in `electron.vite.config.ts` names every module a release build
// owes an absence for: the fixture corpus, whose side effects that config declares away,
// the fixture-only modules beside it, and every test and test-support file. A module on
// that list appearing in any map means a shipped module imports it outside a folded
// branch, whatever the module holds, including a module added after this file was written.
//
// Guarded bodies inside production modules. The tripwire installer, the diagnostics handle
// and the perf meters ship as modules, and only the code inside their guards must fold.
// Their fixture-only content is a set of names, so the second check sweeps the shipped
// text for those names, imported from the tuples their installers read.
//
// Stylesheets are neither: no source map lists one, and an owner-slot shell's sheet ships
// its rules whenever an ungated module imports it. `.dependency-cruiser.mjs` holds that
// case as an import rule (`shell-stylesheet-outside-its-shell`,
// `shell-stylesheet-from-outside-any-shell`).
//
// LIKE ITS NEIGHBORS, THIS NEVER SKIPS. A missing build, or one that wrote no source maps,
// fails with the command that produces one: a sweep that finds nothing because it read
// nothing is the false pass this file exists to prevent, which is also why each check
// carries a positive control and a planted negative control.
//
// `FIXTURE_GLOBAL_NAMES` is imported from its leaf rather than through `core/index.js`
// because a name is all this tier needs, and the installers live in families whose graphs
// reach React and the DOM, which this Node-context project does not compile.

import { describe, expect, it } from "vitest";

import { isFixtureOnlyModule } from "../../../electron.vite.config.js";
import { FIXTURE_GLOBAL_NAMES } from "../../../src/renderer/src/console/core/fixture-globals.js";
import {
  PERF_METER_KINDS,
  type PerfMeterKind,
} from "../../../src/renderer/src/console/core/perf-meters/perf-meters.js";
import {
  BUILD_TARGETS,
  readBuiltTextOrFailLoudly,
  readSourceMapsOrFailLoudly,
  type BuiltFile,
  type BuiltSourceMap,
} from "./built-renderer-tree.js";

/**
 * A string every console build contains, fixture or release.
 *
 * The positive control for the string sweep. Without it a misdirected read (an empty
 * directory, a renamed output path, a tree holding only source maps) would report every
 * name absent because it was reading nothing at all.
 */
const CONSOLE_PRESENCE_MARKER = "meridian-frame";

/**
 * The perf-meter kinds a release renderer must not carry, named rather than derived.
 *
 * NOT EVERY KIND IN THE TUPLE, and the exceptions are the whole design. `"reveal-drain"`
 * is also a `ledger/frame/viewport/cycle/window-cap.ts` reason code and a
 * `viewport-prune-cycle.ts` case label, and `"frame-time"` is written by surfaces that
 * have nothing to do with the meters: real product strings a clean release build carries
 * for their own reasons, so sweeping the tuple whole would fail on a correct bundle and be
 * silenced rather than believed. `"apply-latency"` and `"store-size"` are the meters' own
 * words, so their absence from the shipped text is evidence of the fold.
 *
 * NAMED HERE because deriving the exceptions would mean reading every console module's
 * source text to find the other readers, and no test in this package reads source text.
 *
 * WHAT THAT COSTS: a kind on this list that later gains a reader elsewhere in the console
 * turns the sweep red on a correct build, and a new meter-only kind is swept only once
 * someone adds it here. The first reports itself the day it happens and is answered by
 * moving the kind off this list; the second is what the `satisfies` clause and the control
 * below keep visible.
 *
 * `satisfies` rather than a bare array of strings: the tuple is IMPORTED, so a renamed or
 * retired kind is a compile error here rather than a case that quietly matches nothing.
 * That import is a leaf whose only import is its own bounds table, so it reaches neither
 * the DOM nor a workspace package, and this tier's block in `vitest/console-projects.ts`
 * names that property as the reason it substitutes the define.
 */
const RELEASE_ABSENT_METER_KINDS = [
  "apply-latency",
  "store-size",
] as const satisfies readonly PerfMeterKind[];

/**
 * Which built files carry a marker.
 *
 * A named function rather than a filter written per case, because the planted negative
 * control below has to drive the SAME search the sweep does: a control that re-expressed
 * the search would prove only that the control works.
 */
function carriersOf(marker: string, files: readonly BuiltFile[]): readonly string[] {
  return files.filter((file) => file.text.includes(marker)).map((file) => file.relativePath);
}

/**
 * Every fixture-only module the given source maps list, as `map: module` lines.
 *
 * ONE PASS REPORTING EVERY LEAK rather than a case per module: a leak is one import edge
 * and usually brings several modules with it, and what a reader needs is which modules
 * and which shipped file. Split out so the planted control drives the same collection and
 * the same predicate the real check does.
 */
function fixtureOnlyModulesIn(maps: readonly BuiltSourceMap[]): readonly string[] {
  return maps.flatMap((map) =>
    map.sources
      .filter((source) => isFixtureOnlyModule(source))
      .map((source) => `${map.relativePath}: ${source}`),
  );
}

describe("release build — the fixture surface is absent, not merely unreachable", () => {
  const builtFiles = readBuiltTextOrFailLoudly();
  const sourceMapsPerTarget = BUILD_TARGETS.map(
    (target) => [target, readSourceMapsOrFailLoudly(target)] as const,
  );

  it("positive control: the string sweep is reading a real console build", () => {
    // An absence claim is only as good as the evidence that the search happened. This
    // runs first so a misdirected read is reported as "read nothing" rather than as
    // "shipped nothing".
    const carriers = carriersOf(CONSOLE_PRESENCE_MARKER, builtFiles);
    expect(
      carriers.length,
      `no built file mentions "${CONSOLE_PRESENCE_MARKER}", so the absence claims below would be vacuous`,
    ).toBeGreaterThan(0);
  });

  it.each(FIXTURE_GLOBAL_NAMES)("does not ship the fixture handle %s", (fixtureGlobalName) => {
    const carriers = carriersOf(fixtureGlobalName, builtFiles);
    expect(
      carriers,
      `"${fixtureGlobalName}" reached the built tree. Either the assignment left its ` +
        "`__SIDEKICKS_CONSOLE_FIXTURES__` guard, or `out/renderer` currently holds a " +
        "fixtures build — `pnpm build:fixtures` and `pnpm build` write the same directory. " +
        "Re-run `pnpm --filter @ai-sidekicks/desktop build` and try again.",
    ).toStrictEqual([]);
  });

  it("positive control: every named meter kind is one the module still declares", () => {
    // The list above is written out rather than derived, so this is the control against
    // it going stale: an emptied list makes the case below vacuous without failing it, and
    // a kind the tuple no longer holds is a case that can never match. The `satisfies`
    // clause makes the same claim at compile time; this one makes a `test` run report it
    // without a `typecheck` beside it.
    expect(RELEASE_ABSENT_METER_KINDS.length).toBeGreaterThan(0);
    for (const kind of RELEASE_ABSENT_METER_KINDS) {
      expect(PERF_METER_KINDS).toContain(kind);
    }
  });

  it.each(RELEASE_ABSENT_METER_KINDS)("does not ship the perf-meter kind %s", (kind) => {
    const carriers = carriersOf(kind, builtFiles);
    expect(
      carriers,
      `"${kind}" reached the built tree, so a release renderer is carrying the dev-tier ` +
        "perf meters. Either `out/renderer` currently holds a fixtures build — " +
        "`pnpm build:fixtures` and `pnpm build` write the same directory — or a recording " +
        "call site has left its `__SIDEKICKS_CONSOLE_FIXTURES__` guard, or `PERF_METER_KINDS` " +
        "gained a production reader that keeps the tuple in the graph. The guard is the " +
        "mechanism the module's own header claims; this is the outcome.",
    ).toStrictEqual([]);
  });

  it("negative control: the string sweep reports a carrier when one is planted", () => {
    // Every sweep above is an absence claim, and an absence claim is only worth what its
    // search is worth. This plants a file that DOES carry a fixture handle and drives the
    // same `carriersOf`, so a search that had stopped matching (a read that returned no
    // text, a comparison that stopped comparing) is reported here instead of being read
    // as a clean release build.
    const [plantedName] = FIXTURE_GLOBAL_NAMES;
    const plantedFiles: readonly BuiltFile[] = [
      { relativePath: "assets/clean.js", text: "export const nothingToSeeHere=1;" },
      { relativePath: "assets/planted.js", text: `globalThis["${plantedName}"]={};` },
    ];

    expect(carriersOf(plantedName, plantedFiles)).toStrictEqual(["assets/planted.js"]);
  });

  it.each(sourceMapsPerTarget)(
    "positive control: the %s build wrote source maps naming its own source",
    (target, maps) => {
      // The module check below reads these maps, so a target whose maps name nothing of
      // its own source would make it vacuous for that target. A target that wrote no map
      // at all has already failed the read above with its own message.
      const namesOwnSource = maps.some((map) =>
        map.sources.some((source) => source.includes(`/src/${target}/`)),
      );
      expect(
        namesOwnSource,
        `no out/${target} source map names a module under src/${target}/`,
      ).toBe(true);
    },
  );

  it("no fixture-only module rendered code into any shipped file", () => {
    expect(
      fixtureOnlyModulesIn(sourceMapsPerTarget.flatMap(([, maps]) => maps)),
      "a release build rendered code from a fixture-only module. Either `out/` currently " +
        "holds a fixtures build — `pnpm build:fixtures` and `pnpm build` write the same " +
        "directory — or a module the release build keeps imports this one outside a " +
        "`__SIDEKICKS_CONSOLE_FIXTURES__` branch. The `define` folds a guarded call site " +
        "but not a static import edge, so a value a shipped module reads from the fixture " +
        "belongs in a production module instead.",
    ).toStrictEqual([]);
  });

  it("negative control: the module check reports a planted fixture-only module", () => {
    // One planted module per kind the predicate names, beside a production module that
    // must pass, driven through the same collection and the same predicate the check
    // above reads. A predicate that stopped matching one kind is reported here instead of
    // being read as a clean release build.
    const planted: readonly BuiltSourceMap[] = [
      {
        relativePath: "renderer/assets/clean.js.map",
        sources: ["../../../src/renderer/src/console/frame/frame-commands.ts"],
      },
      {
        relativePath: "renderer/assets/planted.js.map",
        sources: [
          "../../../src/renderer/src/console/bridge/scenario/planted.ts",
          "../../../src/renderer/src/console/frame/pane-harness/Planted.tsx",
          "../../../src/renderer/src/console/core/fixture-globals.ts",
          "../../../src/renderer/src/console/ledger/planted.test.ts",
          "../../../src/renderer/src/console/ledger/planted.test-support.ts",
        ],
      },
    ];

    expect(fixtureOnlyModulesIn(planted)).toStrictEqual([
      "renderer/assets/planted.js.map: ../../../src/renderer/src/console/bridge/scenario/planted.ts",
      "renderer/assets/planted.js.map: ../../../src/renderer/src/console/frame/pane-harness/Planted.tsx",
      "renderer/assets/planted.js.map: ../../../src/renderer/src/console/core/fixture-globals.ts",
      "renderer/assets/planted.js.map: ../../../src/renderer/src/console/ledger/planted.test.ts",
      "renderer/assets/planted.js.map: ../../../src/renderer/src/console/ledger/planted.test-support.ts",
    ]);
  });
});
