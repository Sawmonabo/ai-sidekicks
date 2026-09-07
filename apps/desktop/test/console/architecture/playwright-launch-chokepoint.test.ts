// One module launches Electron through Playwright, and it binds that launch to the test.
//
// The rule the `spawn` chokepoint next door cannot make. `_electron.launch`
// reaches `node:child_process` INSIDE the Playwright package, so a second
// launcher in this one imports nothing that gate reads and stays green forever
// while it starts a real browser on a real profile directory. That gate is about
// `spawn`; this one is about the launch, and neither is the other's
// approximation.
//
// TWO CLAIMS, and the second is why the first is worth making. The CHOKEPOINT
// claim is that `test/console/electron-harness.ts` is the only launch site in the
// package — every other module reaches the launched application through
// `withLaunchedConsole`, whose `launchConsole` is deliberately not exported. The
// DOOR claim is that the chokepoint actually registers its close at settle time:
// a single launch site that forgot `disposeWhenTestFinishes` leaves exactly the
// leak the census was drawn to prevent, and the two claims fail independently.
//
// BOTH ARE READ OUT OF THE PARSE, through `playwright-launch-reach.ts` and the
// call reader below, because the shapes this file is measured against are shapes
// a substring reader cannot tell from prose. Its own predecessor asserted the
// door by searching the launcher's TEXT for `disposeWhenTestFinishes` — a search
// the launcher's own paragraph about `disposeWhenTestFinishes` satisfies, so
// deleting the registration and leaving the comment kept it green. The foil below
// is that reader, kept so every control here is measured against what it could
// not see.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  consoleSourceModules,
  ConsoleSourceTree,
  DESKTOP_PROSE_ROOTS,
  readConsoleSourceModule,
  readModuleNamed,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";
import { readPlaywrightLaunch } from "./playwright-launch-reach.js";

/** The one module allowed to launch Electron, as the scan names it. */
const LAUNCHER_DISPLAY_PATH = "test/console/electron-harness.ts";

/** The settle-time door every launch site owes a registration to. */
const SETTLE_TIME_DOOR = "disposeWhenTestFinishes";

/**
 * The reading this file pays for once, and the budgets it is measured against.
 *
 * The package's whole source and test tree, walked and read once in the hook — the
 * roots `DESKTOP_PROSE_ROOTS` names, which reach `src/main/**` as well as `test/**`,
 * so a launch outside the test tree is inside this claim rather than beside it — and
 * then PARSED once per comparison, which two cases below make.
 *
 * The default per-test bound is not enough and that is measured rather than
 * guessed: a five-hundred-module parse finishes well inside it in isolation and
 * overran it at five seconds under this tier's five-project concurrency, which is
 * how the tier actually runs. `source-parse-home.test.ts` carries the same pair of
 * allowances beside the same walk, for the same reason.
 */
const PACKAGE_PARSE_ALLOWANCE_MS = 30_000;
const COMPARISON_ALLOWANCE_MS = 30_000;

vi.setConfig({ testTimeout: COMPARISON_ALLOWANCE_MS, hookTimeout: PACKAGE_PARSE_ALLOWANCE_MS });

/**
 * Whether a module CALLS the settle-time door, out of the parse.
 *
 * A private reader for this file's own claim, on `capture-chokepoint.test.ts`'s
 * pattern: the question is about one named function in one module, and the shared
 * reader beside it owns the launch, not the door. What makes it a parse rather
 * than a search is the defect it was written for — the launcher documents this
 * door at length, and a search for the name is answered by the paragraph.
 */
function callsSettleTimeDoor(source: string, fileName: string): boolean {
  let calls = false;
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === SETTLE_TIME_DOOR
    ) {
      calls = true;
    }
  });
  return calls;
}

/**
 * The reader this file replaced, kept as the foil the controls are measured against.
 *
 * Not a second implementation of the rule — it is the SUPERSEDED one, and its only
 * use is the case that shows what it could not see. A control that merely asserts
 * the parse reader fires would pass over a reader that fires on everything; a
 * control that also asserts the substring reader still fires on the mutilated text
 * is the one that says the parse bought something.
 */
function supersededSubstringReader(source: string): boolean {
  return source.includes(SETTLE_TIME_DOOR);
}

/**
 * The same source with its settle-time registration replaced by a comment naming it.
 *
 * THE MUTATION THE CONTROL NEEDS, and it is built out of the parse rather than
 * written by hand so the control drives the launcher this package actually ships:
 * a hand-written stand-in would prove the reader answers about a stand-in. The
 * comment carries the door's name and its opening parenthesis, which is precisely
 * the text the superseded reader accepted.
 */
function withSettleTimeCallCommentedOut(source: string, fileName: string): string {
  const parsed = parseSourceText(fileName, source);
  let range: { start: number; end: number } | undefined;
  forEachDescendant(parsed, (node) => {
    if (
      range === undefined &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === SETTLE_TIME_DOOR
    ) {
      range = { start: node.getStart(parsed), end: node.end };
    }
  });
  if (range === undefined) {
    throw new Error(`${fileName} carries no ${SETTLE_TIME_DOOR} call to comment out`);
  }
  return `${source.slice(0, range.start)}/* ${SETTLE_TIME_DOOR}( … ) */ undefined${source.slice(range.end)}`;
}

/** A module that launches Electron the way an alternate launcher would. */
const PLANTED_LAUNCHER_SOURCE = [
  'import { _electron } from "playwright";',
  "",
  "export async function launchWithoutTheHarness(): Promise<unknown> {",
  '  return _electron.launch({ args: ["out/main/index.js"] });',
  "}",
  "",
].join("\n");

const tree = new ConsoleSourceTree({ roots: DESKTOP_PROSE_ROOTS, tests: true });

beforeAll(() => {
  tree.read();
}, PACKAGE_PARSE_ALLOWANCE_MS);

/** Every module in `texts` that is a Playwright Electron launch site. */
function launchSitesIn(
  texts: readonly { readonly displayPath: string; readonly source: string }[],
): readonly string[] {
  return texts
    .filter((text) => readPlaywrightLaunch(text.source, text.displayPath).isLaunchSite)
    .map((text) => text.displayPath);
}

describe("every Playwright Electron launch goes through one owner", () => {
  it("control: the tree is walked and read once for the whole file", () => {
    expect(tree.readCount).toBe(1);
    expect(tree.reading.texts.length).toBe(tree.reading.modules.length);
  });

  it("finds a tree to read at all, and the launcher inside it", () => {
    // The zero-match failure this tier requires of every tripwire: a rule that
    // scanned nothing would report clean forever. The roots reach `src/main/**`
    // as well as `test/**`, so both halves are asserted present.
    const displayPaths = tree.reading.texts.map((text) => text.displayPath);
    expect(displayPaths.length).toBeGreaterThan(100);
    expect(displayPaths).toContain(LAUNCHER_DISPLAY_PATH);
    expect(displayPaths.some((displayPath) => displayPath.startsWith("src/main/"))).toBe(true);
  });

  it("names exactly one module that launches Electron", () => {
    expect(
      launchSitesIn(tree.reading.texts),
      "a second module launches Electron through Playwright — route it through " +
        "`withLaunchedConsole` so the browser's close is bound to the test",
    ).toStrictEqual([LAUNCHER_DISPLAY_PATH]);
  });

  it("negative control: a planted alternate launcher inside the scanned roots is named", () => {
    // Without this the clean result above is also what a reader matching nothing
    // would produce. The plant is driven through the REAL walk from a real root and
    // the census then runs over the real tree's texts together with it, so all three
    // halves of the gate are exercised: the walk collects the module, the reader
    // names it, and the census reports two sites where the claim above demands one.
    //
    // It plants OUTSIDE the package rather than inside `test/`, because this tier
    // runs its files concurrently and three other gates walk `test/` — a module
    // planted there would fail whichever of them happened to read the tree while it
    // existed. The walk concatenates its roots, so a root beside the package's own
    // is inside the scanned set exactly as a subdirectory would be, and the first
    // assertion below is what says so rather than leaving it assumed.
    const plantedRoot = mkdtempSync(path.join(tmpdir(), "sidekicks-playwright-launch-"));
    try {
      mkdirSync(path.join(plantedRoot, "console"));
      writeFileSync(
        path.join(plantedRoot, "console", "planted-alternate-launcher.ts"),
        PLANTED_LAUNCHER_SOURCE,
        "utf8",
      );
      const walked = consoleSourceModules({
        roots: [...DESKTOP_PROSE_ROOTS, plantedRoot],
        tests: true,
      });
      const plantedModules = walked.filter((module) => module.directory === plantedRoot);
      expect(walked.map((module) => module.displayPath)).toContain(LAUNCHER_DISPLAY_PATH);
      expect(plantedModules).toHaveLength(1);

      const sites = launchSitesIn([
        ...tree.reading.texts,
        ...plantedModules.map((module) => ({
          displayPath: module.displayPath,
          source: readConsoleSourceModule(module),
        })),
      ]);
      expect(sites).toContain(LAUNCHER_DISPLAY_PATH);
      expect(
        sites.filter((displayPath) => displayPath.endsWith("planted-alternate-launcher.ts")),
      ).toHaveLength(1);
      expect(sites).toHaveLength(2);
    } finally {
      rmSync(plantedRoot, { recursive: true, force: true });
    }
  });

  it("reads every spelling that puts the launcher in a module's hands", () => {
    // Each of these reaches `_electron` under a name no scan can enumerate, and
    // each is a spelling a module actually writes. The named-import arm alone —
    // which is what the reach census next door used to be — saw only the first.
    const reaches: readonly string[] = [
      'import { _electron } from "playwright";\n_electron.launch({});',
      'import { _electron as electron } from "@playwright/test";\nelectron.launch({});',
      'import * as playwright from "playwright-core";\nplaywright._electron.launch({});',
      'import playwright from "playwright";\nplaywright._electron.launch({});',
      'const playwright = require("playwright");\nplaywright._electron.launch({});',
      'const playwright = await import("@playwright/test");\nplaywright._electron.launch({});',
      'import playwright = require("playwright-core");\nplaywright._electron.launch({});',
      'export { _electron } from "playwright";\nconst started = harness.launch({});',
      'export * from "@playwright/test";\nconst started = harness.launch({});',
      'import { _electron } from "playwright";\n_electron["launch"]({});',
    ];
    for (const planted of reaches) {
      expect(readPlaywrightLaunch(planted, "planted.ts").isLaunchSite, planted).toBe(true);
    }
  });

  it("still clears the shapes that cannot launch an Electron", () => {
    // The other half. A type import is what four modules in this package write to
    // read the handle the harness hands out, and banning it would ban reading the
    // handle at all; the mentions are this tier's standing hazard, since a gate's
    // own controls carry the launcher's import statement as literal text.
    const clear: readonly string[] = [
      'import type { ElectronApplication } from "@playwright/test";\napplication.launch({});',
      'import { type _electron } from "playwright";\nharness.launch({});',
      'import { test, expect } from "@playwright/test";\ntest("a case", () => {});',
      'import "playwright";\nharness.launch({});',
      'export type { _electron } from "playwright";',
      'const advice = "import { _electron } from \\"playwright\\"";\nadvice.launch({});',
      // The reach with no launch, and the launch with no reach: neither is a site.
      'import { _electron } from "playwright";\nexport const launcher = _electron;',
      'import { spawn } from "node:child_process";\nconst child = runner.launch({});',
    ];
    for (const planted of clear) {
      expect(readPlaywrightLaunch(planted, "planted.ts").isLaunchSite, planted).toBe(false);
    }
  });
});

describe("the one launch site registers its close at settle time", () => {
  const launcherSource = (): string =>
    readModuleNamed(tree.reading.modules, LAUNCHER_DISPLAY_PATH, "the shared Electron launcher");

  it("calls the settle-time door rather than merely naming it", () => {
    expect(
      callsSettleTimeDoor(launcherSource(), LAUNCHER_DISPLAY_PATH),
      "`withLaunchedConsole` no longer registers a settle-time close — a tier that " +
        "overruns its own budget will leave a real Electron and its profile behind",
    ).toBe(true);
  });

  it("negative control: the registration replaced by a comment naming it reads red", () => {
    // THE DEFECT, driven against the launcher this package ships. The superseded
    // reader searched the module's text for the door's name, and the module's own
    // paragraph about that door answers the search — so the registration could be
    // deleted and the comment left, and the gate stayed green over a launcher that
    // registered nothing.
    const mutilated = withSettleTimeCallCommentedOut(launcherSource(), LAUNCHER_DISPLAY_PATH);
    expect(callsSettleTimeDoor(mutilated, LAUNCHER_DISPLAY_PATH)).toBe(false);
    expect(
      supersededSubstringReader(mutilated),
      "the mutation no longer carries the door's name, so it proves nothing about the search",
    ).toBe(true);
  });

  it("negative control: a comment carrying the call text is not a call", () => {
    // The same discrimination on a corpus small enough to read, so the case above
    // is measured against a shape rather than only against a mutation.
    expect(
      callsSettleTimeDoor(
        `// ${SETTLE_TIME_DOOR}(close, register);\nexport const x = 1;\n`,
        "p.ts",
      ),
    ).toBe(false);
    expect(callsSettleTimeDoor(`const advice = "${SETTLE_TIME_DOOR}(close)";\n`, "p.ts")).toBe(
      false,
    );
    expect(callsSettleTimeDoor(`${SETTLE_TIME_DOOR}(close, register);\n`, "p.ts")).toBe(true);
  });
});
