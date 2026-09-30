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
//   that ships, so the shipped text is swept for the fixture handles by name.
//
// Stylesheets are neither: no source map lists one, and a feature fixture's sheet ships its
// rules whenever an ungated module imports it. `.dependency-cruiser.mjs` holds that case as an
// import rule (`fixture-stylesheet-outside-its-folder`,
// `fixture-stylesheet-from-outside-any-fixtures-folder`).
//
// This never skips: a missing build, or one with no source maps, fails with the command that
// produces one, since a sweep that finds nothing because it read nothing is a false pass. Each
// check carries a positive control.
//
// `FIXTURE_GLOBAL_NAMES` and `FIXTURE_LAUNCH_GLOBAL` are imported from their leaves because
// the installers' graphs reach React and the DOM, which this Node-context project does not
// compile.

import { describe, expect, it } from "vitest";

import { isFixtureOnlyModule } from "../../electron.vite.config.js";
import { FIXTURE_GLOBAL_NAMES } from "@renderer/app/fixture-global-names.js";
import { FIXTURE_LAUNCH_GLOBAL } from "@shared/fixture-launch.js";
import {
  BUILD_TARGETS,
  readBuiltTextOrFailLoudly,
  readSourceMapsOrFailLoudly,
  type BuiltFile,
  type BuiltSourceMap,
} from "./built-renderer-tree.js";

/**
 * A string every console build contains, fixture or release: the string sweep's positive
 * control, so a misdirected read (an empty directory, a renamed path) cannot report every name
 * absent by reading nothing.
 */
const CONSOLE_PRESENCE_MARKER = "meridian-frame";

/** Which built files carry a marker. */
function carriersOf(marker: string, files: readonly BuiltFile[]): readonly string[] {
  return files.filter((file) => file.text.includes(marker)).map((file) => file.relativePath);
}

/**
 * Every fixture-only module the given source maps list, as `map: module` lines. One pass
 * reports every leak, since a leaked import edge usually brings several modules.
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
    const carriers = carriersOf(CONSOLE_PRESENCE_MARKER, builtFiles);
    expect(
      carriers.length,
      `no built file mentions "${CONSOLE_PRESENCE_MARKER}", so the absence claims below would be vacuous`,
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
});
