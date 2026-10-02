// Tier: bundle. What a release build must not contain.
//
// The fixture bridge, every scenario, the pane harness and the fixture handles are reached only
// through the fixture composition, behind `__FIXTURE_BUILD__`, so a release build folds the
// branch and they are physically absent from what ships, not merely unreachable: unreachable
// code still hands a reader of the file a way into the console's internals and fabricated
// sessions.
//
// This file checks the outcome on the built artifact, because a misspelled define, one dropped
// from a build mode, or a bundler setting that defeats it leaves the mechanism intact and the
// outcome wrong. It reads no source text: every subject is the build's own output or a constant
// imported from the module that declares it.
//
// Two checks, because fixture code lives in two places:
//
// - Whole modules. Every build target writes hidden source maps whose `sources` list the
//   modules that rendered code into each file. `isFixtureOnlyModule` in
//   `electron.vite.config.ts` names every module a release build owes an absence for (the
//   fixture corpus, the fixture-only modules beside it, and every test and test-support file);
//   one appearing in any map means a shipped module imports it outside a folded branch.
// - Names inside production modules. The fixture launch's page property is read by a module
//   that ships, and the perf meters ship as a module whose recordings fold under
//   `import.meta.env.DEV`, so the shipped text is swept for those names.
//
// Stylesheets are neither: no source map lists one, and a feature fixture's sheet ships its
// rules whenever an ungated module imports it. `.dependency-cruiser.mjs` holds that case as an
// import rule (`fixture-stylesheet-outside-its-folder`,
// `fixture-stylesheet-from-outside-any-fixtures-folder`).
//
// This never skips: a missing build, or one with no source maps, fails with the command that
// produces one, since a sweep that finds nothing because it read nothing is a false pass. Each
// check carries a positive control and a planted negative control.
//
// `FIXTURE_GLOBAL_NAMES` and `FIXTURE_LAUNCH_GLOBAL` are imported from their leaves because
// the installers' graphs reach React and the DOM, which this Node-context project does not
// compile.

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isFixtureOnlyModule } from "../../electron.vite.config.js";
import { DESKTOP_PACKAGE_ROOT } from "../../scripts/budget/budget-registry.mjs";
import { FIXTURE_GLOBAL_NAMES } from "@renderer/app/fixture-global-names.js";
import { FIXTURE_LAUNCH_GLOBAL } from "@shared/fixture-launch.js";
import {
  PERFORMANCE_METER_KINDS,
  type PerformanceMeterKind,
} from "@renderer/lib/performance-meters/performance-meters.js";
import {
  BUILD_TARGETS,
  readBuiltTextOrFailLoudly,
  readSourceMapsOrFailLoudly,
  type BuiltFile,
  type BuiltSourceMap,
} from "./built-renderer-tree.js";

/**
 * A string every renderer build contains, fixture or release: the string sweep's positive
 * control, so a misdirected read (an empty directory, a renamed path) cannot report every name
 * absent by reading nothing.
 */
const RENDERER_PRESENCE_MARKER = "meridian-frame";

/**
 * The perf-meter kinds a release renderer must not carry, named rather than derived. Not every
 * kind in the tuple: `"reveal-drain"` is also a `window-cap.ts` reason code and a
 * `viewport-prune-cycle.ts` case label, and `"frame-time"` is a string other product code
 * carries, so sweeping the tuple whole would fail on a correct bundle. `"apply-latency"` and
 * `"store-size"` are the meters' own words, so their absence is evidence of the fold.
 *
 * Deriving the exceptions would mean reading source text, which no test here does. The cost is
 * that a listed kind gaining another reader turns the sweep red on a correct build (move it off
 * the list), and a new meter-only kind is swept only once added here. `satisfies` makes a
 * renamed or retired kind a compile error, since the tuple is imported from a leaf module whose
 * only import is its bounds table; `vitest/tier-projects.ts` names that as why this tier
 * substitutes the define.
 */
const RELEASE_ABSENT_METER_KINDS = [
  "apply-latency",
  "store-size",
] as const satisfies readonly PerformanceMeterKind[];

/**
 * Which built files carry a marker. Shared so the planted negative control drives the same
 * search the sweep does.
 */
function carriersOf(marker: string, files: readonly BuiltFile[]): readonly string[] {
  return files.filter((file) => file.text.includes(marker)).map((file) => file.relativePath);
}

/**
 * Every fixture-only module the given source maps list, as `map: module` lines. One pass
 * reports every leak, since a leaked import edge usually brings several modules; the planted
 * control drives the same collection and predicate.
 */
function fixtureOnlyModulesIn(maps: readonly BuiltSourceMap[]): readonly string[] {
  return maps.flatMap((map) =>
    map.sources
      .filter((source) => isFixtureOnlyModule(source))
      .map((source) => `${map.relativePath}: ${source}`),
  );
}

describe("release build — the fixture code is absent, not merely unreachable", () => {
  const builtFiles = readBuiltTextOrFailLoudly();
  const sourceMapsPerTarget = BUILD_TARGETS.map(
    (target) => [target, readSourceMapsOrFailLoudly(target)] as const,
  );

  it("positive control: the string sweep is reading a real console build", () => {
    // An absence claim is only as good as the evidence that the search happened. This runs
    // first so a misdirected read is reported as "read nothing", not "shipped nothing".
    const carriers = carriersOf(RENDERER_PRESENCE_MARKER, builtFiles);
    expect(
      carriers.length,
      `no built file mentions "${RENDERER_PRESENCE_MARKER}", so the absence claims below would be vacuous`,
    ).toBeGreaterThan(0);
  });

  it.each([...FIXTURE_GLOBAL_NAMES, FIXTURE_LAUNCH_GLOBAL])(
    "does not ship the fixture handle %s",
    (fixtureGlobalName) => {
      const carriers = carriersOf(fixtureGlobalName, builtFiles);
      expect(
        carriers,
        `"${fixtureGlobalName}" reached the built tree. Either the assignment left its ` +
          "`__FIXTURE_BUILD__` guard, or `out/` currently holds a " +
          "fixtures build — `pnpm build:fixtures` and `pnpm build` write the same directory. " +
          "Re-run `pnpm --filter @ai-sidekicks/desktop build` and try again.",
      ).toStrictEqual([]);
    },
  );

  it("positive control: every named meter kind is one the module still declares", () => {
    // The list above is written out, not derived, so this guards it going stale: an emptied
    // list makes the case below vacuous, and a kind the tuple no longer holds can never match.
    // `satisfies` makes the same claim at compile time; this reports it in a `test` run alone.
    expect(RELEASE_ABSENT_METER_KINDS.length).toBeGreaterThan(0);
    for (const kind of RELEASE_ABSENT_METER_KINDS) {
      expect(PERFORMANCE_METER_KINDS).toContain(kind);
    }
  });

  it.each(RELEASE_ABSENT_METER_KINDS)("does not ship the perf-meter kind %s", (kind) => {
    const carriers = carriersOf(kind, builtFiles);
    expect(
      carriers,
      `"${kind}" reached the built tree, so a release renderer is carrying the dev-tier ` +
        "perf meters. Either `out/renderer` currently holds a fixtures build — " +
        "`pnpm build:fixtures` and `pnpm build` write the same directory — or a recording " +
        "entry point has left its `import.meta.env.DEV` guard, or `PERFORMANCE_METER_KINDS` " +
        "gained a production reader that keeps the tuple in the graph. The guard is the " +
        "mechanism the module's own header claims; this is the outcome.",
    ).toStrictEqual([]);
  });

  it("negative control: the string sweep reports a carrier when one is planted", () => {
    // Every sweep above is an absence claim, worth only what its search is worth. This plants a
    // file that does carry a fixture handle and drives the same `carriersOf`, so a search that
    // stopped matching (no text read, a comparison that stopped comparing) is reported here
    // instead of read as a clean release build.
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
      // The module check below reads these maps, so a target whose maps name none of its own
      // source would make it vacuous. A target with no map at all already failed the read above.
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
        "`__FIXTURE_BUILD__` branch. The `define` folds a guarded call site " +
        "but not a static import edge, so a value a shipped module reads from the fixture " +
        "belongs in a production module instead.",
    ).toStrictEqual([]);
  });

  it("negative control: the module check reports a planted fixture-only module", () => {
    // One planted module per kind the predicate names, beside a production module that must
    // pass, driven through the same collection and predicate as the check above, so a predicate
    // that stopped matching one kind is reported here.
    const plantedSources = [
      "fixtures/scenarios/planted.ts",
      "src/renderer/src/services/daemon/planted.fixture.ts",
      "src/renderer/src/features/settings/pages/providers/fixtures/planted.ts",
      "src/renderer/src/app/fixture-composition.ts",
      "src/renderer/src/app/fixture-global-names.ts",
      "src/renderer/src/app/pane-harness/Planted.tsx",
      "src/renderer/src/features/transcript/planted.test.ts",
      "src/renderer/src/features/transcript/planted.test-support.ts",
    ].map((modulePath) => join(DESKTOP_PACKAGE_ROOT, modulePath));
    const planted: readonly BuiltSourceMap[] = [
      {
        relativePath: "renderer/assets/clean.js.map",
        sources: [join(DESKTOP_PACKAGE_ROOT, "src/renderer/src/app/App.tsx")],
      },
      { relativePath: "renderer/assets/planted.js.map", sources: plantedSources },
    ];

    expect(fixtureOnlyModulesIn(planted)).toStrictEqual(
      plantedSources.map((source) => `renderer/assets/planted.js.map: ${source}`),
    );
  });
});
