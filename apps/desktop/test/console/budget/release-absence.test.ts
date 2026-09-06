// Tier: bundle — what a RELEASE renderer build must not contain.
//
// `Spec-023 §Console Design (Meridian)` puts the fixture bridge, every scenario,
// and the scenario switcher behind `__SIDEKICKS_CONSOLE_FIXTURES__` so that Rollup
// collapses `if (false) { … }` and the bodies are PHYSICALLY ABSENT from a shipped
// bundle — not merely unreachable. The distinction is the whole point: unreachable
// code still ships a handle to the console's internals and a set of fabricated
// sessions to anyone who reads the file.
//
// The architecture tier already asserts the mechanism — that the assignment sits
// inside the guard, checked against source text in milliseconds. This asserts the
// OUTCOME, against the artifact a person would actually install, because a define
// that was misspelled, dropped from one build mode, or defeated by a bundler
// setting would leave the mechanism intact and the outcome wrong.
//
// LIKE ITS NEIGHBOURS, THIS NEVER SKIPS. An absent build fails with the command
// that produces one. A grep that finds nothing because it was pointed at nothing
// is the exact false pass this file exists to prevent, which is also why the
// positive control below is not optional decoration.
//
// WHAT IT SWEEPS FOR, AND WHY IT DOES NOT NAME THE STRINGS ITSELF. The subject is
// `FIXTURE_GLOBAL_NAMES` — the closed tuple in `console/core/fixture-globals.ts`
// that every `define`-gated installer takes its own name from. Reading the same
// tuple the producers read is what keeps the set from going stale in the one
// direction that is invisible here: a fourth fixture global this file had never
// heard of would pass the sweep exactly as an absent one does. The leaf is
// imported directly rather than through `core/index.js` because a name is all this
// tier needs, and the three installers live in three families whose graphs reach
// React and the DOM — neither of which this Node-context project compiles with.
//
// THE SECOND SUBJECT: THE SCENARIO CORPUS ITSELF (2026-09-06). The fixture handle
// is the console's DOOR into the fixture, and sweeping for it caught a build that
// shipped the door. It did not catch the one that shipped the ROOM: every fixture
// global was absent from the release artifact while `"Browsing agent"`,
// `artifact-capture-staging-header`, `scenarios:`, and `fixtureServedOperations`
// were all present in it, because the `define` folds a fixture CALL SITE and does
// not remove the static import edge that reaches the corpus — and a module the graph
// still reaches keeps every top-level statement the bundler cannot prove pure, which
// a scenario built by calling builders at module scope never is.
// `electron.vite.config.ts` closes that with a path-scoped `moduleSideEffects`
// declaration, and this half is what stops the corpus coming back unnoticed.
//
// THE MARKERS ARE READ FROM THE CORPUS, never written here, so a scenario a later
// family adds is swept the day it lands and no roster in this file goes stale. They are
// read from the corpus's SOURCE rather than imported from it, because this project's lib
// is Node's and a scenario module reaches the DOM — the same constraint the fixture-global
// import below is already written around.
//
// AND THAT READ IS WHY THE BUILT TREE IS WALKED NEXT DOOR. Reading the corpus means
// reaching renderer SOURCE, and `architecture/source-walk-chokepoint.test.ts` holds that
// a module which does that may not also walk a directory of its own — one admission for
// what counts as console source, and no second opinion drifting from it. Build output is
// a different subject with no such admission, so its walk lives in
// `built-renderer-tree.ts`, which reaches no renderer path and is admitted by that gate's
// derived escape rather than by a name on a list.

import { join } from "node:path";

import ts from "typescript";

import { describe, expect, it } from "vitest";

import { FIXTURE_GLOBAL_NAMES } from "../../../src/renderer/src/console/core/fixture-globals.js";
import { readBuiltTextOrFailLoudly, type BuiltFile } from "./built-renderer-tree.js";
import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * A string every console build contains, fixture or release.
 *
 * The positive control. Without it a misdirected read — an empty directory, a
 * renamed output path, a tree holding only source maps — would report the fixture
 * global absent because it was reading nothing at all.
 */
const CONSOLE_PRESENCE_MARKER = "meridian-frame";

/** Where the scenario corpus lives, as one directory this tier reads rather than imports. */
const SCENARIO_CORPUS_DIRECTORY: string = join(CONSOLE_DIRECTORY, "bridge", "scenarios");

/**
 * The scenario fields whose values make good markers.
 *
 * The LABEL and the PURPOSE, and deliberately not the `id`. A scenario id is a short
 * lowercase word — `repos`, `browser`, `terminal`, `settings` — and every one of them is
 * also a route segment, a pane kind, or a sidebar section id that a release build
 * carries for its own reasons, so an id sweep fails on a clean bundle and would be
 * silenced rather than believed. The label and the purpose are prose written for the
 * scenario picker; nothing else in this console says "Browsing agent", and a bundle that
 * does is carrying the corpus.
 *
 * Both fields rather than the label alone: they are declared beside each other, so a
 * scenario that changed one is exactly the case where the other still catches it.
 */
const SCENARIO_MARKER_FIELDS: readonly string[] = ["label", "purpose"];

/**
 * Every marker the corpus contributes, read from its SOURCE rather than imported.
 *
 * IMPORTING `CONSOLE_SCENARIOS` WOULD BE THE OBVIOUS THING AND IT DOES NOT COMPILE. This
 * project is `tsconfig.test.json`, whose lib is Node's and carries no DOM — the same
 * constraint the fixture-global import above is written around — and a scenario module
 * reaches the console's store for its event types, which reaches the DOM. So the corpus
 * is read the way this tier reads everything else: off disk.
 *
 * Through the compiler's own parser rather than a regular expression, and through the
 * source reader the architecture tier already owns rather than a second directory walk.
 * What it collects is every string-literal value assigned to one of the marker fields
 * anywhere in that directory, which is a superset of the scenarios' own — a helper's
 * label is just as much a string only the corpus has — and a superset is the safe
 * direction for an absence sweep.
 */
function scenarioCorpusMarkers(): readonly string[] {
  const markers = new Set<string>();
  for (const module of consoleSourceModules({ roots: [SCENARIO_CORPUS_DIRECTORY] })) {
    const parsed = parseSourceText(module.displayPath, readConsoleSourceModule(module));
    forEachDescendant(parsed, (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        SCENARIO_MARKER_FIELDS.includes(node.name.text) &&
        ts.isStringLiteral(node.initializer)
      ) {
        markers.add(node.initializer.text);
      }
    });
  }
  return [...markers].sort();
}

const SCENARIO_CORPUS_MARKERS: readonly string[] = scenarioCorpusMarkers();

/**
 * Which built files carry a marker.
 *
 * A named function rather than a filter written twice, because the planted negative
 * control below has to drive the SAME predicate the sweep does — a control that
 * re-expressed the search would prove only that the control works.
 */
function carriersOf(marker: string, files: readonly BuiltFile[]): readonly string[] {
  return files.filter((file) => file.text.includes(marker)).map((file) => file.relativePath);
}

describe("release bundle — the fixture surface is absent, not merely unreachable", () => {
  const builtFiles = readBuiltTextOrFailLoudly();

  it("positive control: the sweep is reading a real console build", () => {
    // An absence claim is only as good as the evidence that the search happened.
    // This is the control for the test below rather than a fact worth asserting
    // on its own, and it runs first so a misdirected read is reported as "read
    // nothing" rather than as "shipped nothing".
    const carriers = carriersOf(CONSOLE_PRESENCE_MARKER, builtFiles);
    expect(
      carriers.length,
      `no built file mentions "${CONSOLE_PRESENCE_MARKER}", so the absence claim below would be vacuous`,
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

  it("positive control: the corpus sweep has scenarios to look for", () => {
    // The markers are derived, so an empty derivation would make every case below
    // vacuous without failing any of them. This is the one assertion that catches a
    // corpus that stopped exporting scenarios rather than one that stopped shipping.
    expect(SCENARIO_CORPUS_MARKERS.length).toBeGreaterThan(0);
  });

  it.each(SCENARIO_CORPUS_MARKERS)("does not ship the scenario marker %s", (marker) => {
    const carriers = carriersOf(marker, builtFiles);
    expect(
      carriers,
      `"${marker}" reached the built tree, so a release bundle carries the fixture ` +
        "scenario corpus. Either `out/renderer` currently holds a fixtures build — " +
        "`pnpm build:fixtures` and `pnpm build` write the same directory — or the " +
        "`treeshake.moduleSideEffects` declaration in `electron.vite.config.ts` no " +
        "longer covers the module this string came from. The `define` guard alone " +
        "does not remove a static import edge; both halves are needed.",
    ).toStrictEqual([]);
  });

  it("negative control: the corpus sweep reports a carrier when one is planted", () => {
    // Every case above is an absence claim, and an absence claim is only worth what
    // its search is worth. This plants a file that DOES carry a scenario marker and
    // drives the same `carriersOf` the sweep drives, so a predicate that had stopped
    // matching — a read that returned no text, a comparison that stopped comparing —
    // is reported here instead of being read as a clean release build.
    const plantedMarker = SCENARIO_CORPUS_MARKERS[0];
    expect(plantedMarker).toBeDefined();
    const plantedFiles: readonly BuiltFile[] = [
      { relativePath: "assets/clean.js", text: "export const nothingToSeeHere=1;" },
      { relativePath: "assets/planted.js", text: `const s={id:"${plantedMarker ?? ""}"};` },
    ];

    expect(carriersOf(plantedMarker ?? "", plantedFiles)).toStrictEqual(["assets/planted.js"]);
  });
});
