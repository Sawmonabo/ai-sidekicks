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
// ONE WALK, AND A BUDGET PER FILE. The corpus is read once at `describe` scope and
// every case works over the same in-memory modules; a walk per case would multiply the
// whole file read by the case count for one answer. Measured on this tree 2026-09-05:
// 782 modules, 1.45 s of test time over seventeen cases — about 1.9 ms per module for
// the file, walk and parse included. A case that pushes it past about 5 ms per module
// is doing its own IO, which is the shape this budget exists to catch.
//
// The rule itself is `barrel-census.ts` beside this file, and the reading it judges
// is `barrel-syntax.ts` beside that, so the controls below can hand either one
// corpora written to fail. The walk stays here, where the source-walk chokepoint can
// see that it is the shared one.

import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import {
  barrelSpecifiers,
  censusFindings,
  findingLines,
  isConsoleBarrel,
  starReexportingBarrels,
} from "./barrel-census.js";
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

/**
 * The doors that publish nothing they did not declare themselves.
 *
 * Every one is a composition site: `scenarios/index.ts` composes the scenario list,
 * `panes/index.ts` registers the pane board, and a pane family's own door claims its
 * kind — each declaring its one export in place rather than forwarding a name from
 * elsewhere. The three pane families sit beside `panes/` rather than inside it: that
 * directory holds the deck's composition and no body, so each family door is a family
 * door like any other and is censused as one. The approvals door joined them when its approval-flow projector moved
 * into `bridge/approvals/`: the composition that registers the fold now reaches the
 * bridge door directly, which is where a validator's registrar belongs, and a
 * forwarding line here would have been an index-to-index chain. Named here so the per-door claim below is a quantifier rather than a
 * predicate that could grow to admit anything: a pane door that started forwarding a
 * symbol would leave this list and be censused like every other door.
 */
const DOORS_THAT_FORWARD_NOTHING: readonly string[] = [
  `${CONSOLE_PREFIX}/approvals/index.ts`,
  `${CONSOLE_PREFIX}/bridge/scenarios/index.ts`,
  `${CONSOLE_PREFIX}/inspector/index.ts`,
  `${CONSOLE_PREFIX}/panes/index.ts`,
  `${CONSOLE_PREFIX}/runs/index.ts`,
];

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

/** A module written by hand, for the controls. */
function syntheticModule(path: string, source: string): CensusModule {
  return { path, source, isTest: /\.test(-support)?\.tsx?$/.test(path) };
}

describe("barrel census — every console re-export has a reader or a claimant", () => {
  const modules = consoleCensusModules();

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
    expect(barrelSpecifiers(modules).length).toBeGreaterThan(200);
  });

  it("censuses every door that forwards, so a clause leaving is not a shortfall", () => {
    // The floor above bounds the TOTAL from below, so one clause dropping out of it
    // is invisible — which is exactly what a clause body read up to the first `}` did
    // to a door line whose comment carried a brace. Per door it is visible: a door
    // that forwards nothing is what a dropped clause leaves behind, and the two that
    // legitimately forward nothing are named rather than subtracted by a predicate.
    const censused = new Set(barrelSpecifiers(modules).map((entry) => entry.barrelPath));
    const silent = modules
      .map((module) => module.path)
      .filter((path) => isConsoleBarrel(path) && !censused.has(path));

    expect([...silent].sort()).toStrictEqual([...DOORS_THAT_FORWARD_NOTHING].sort());
  });

  it("no barrel forwards a name this census cannot enumerate", () => {
    expect(starReexportingBarrels(modules)).toStrictEqual([]);
  });

  it("every barrel specifier is production-consumed or claimed by its task", () => {
    expect(findingLines(censusFindings(modules))).toStrictEqual([]);
  });
});

describe("barrel census — the rule, against corpora written to fail it", () => {
  const declaringModule = syntheticModule(
    `${CONSOLE_PREFIX}/tokens/palette.ts`,
    "export const RING_WIDTH_PX = 2;\n",
  );
  const barrel = (claim: "none" | "tag" | "comment"): CensusModule =>
    syntheticModule(
      `${CONSOLE_PREFIX}/tokens/index.ts`,
      {
        none: 'export { RING_WIDTH_PX } from "./palette.js";\n',
        tag: 'export {\n  /** @consumedBy T-023p-1C-2 */\n  RING_WIDTH_PX,\n} from "./palette.js";\n',
        comment:
          'export {\n  // Consumed by T-023p-1C-2\n  RING_WIDTH_PX,\n} from "./palette.js";\n',
      }[claim],
    );
  const testImporter = syntheticModule(
    `${CONSOLE_PREFIX}/frame/Ring.test.tsx`,
    'import { RING_WIDTH_PX } from "../tokens/index.js";\n',
  );

  it("fails an untagged specifier whose only importer is a test", () => {
    const findings = censusFindings([declaringModule, barrel("none"), testImporter]);

    expect(findingLines(findings)).toStrictEqual([
      `${CONSOLE_PREFIX}/tokens/index.ts :: RING_WIDTH_PX — reached only by ${CONSOLE_PREFIX}/frame/Ring.test.tsx`,
    ]);
  });

  it("passes the same specifier once it names the task that will import it", () => {
    // Both forms, because the tree carries both and neither is the weaker claim: the
    // JSDoc tag additionally buys the dead-code gate's exemption, which is the only
    // difference between them.
    expect(censusFindings([declaringModule, barrel("tag"), testImporter])).toStrictEqual([]);
    expect(censusFindings([declaringModule, barrel("comment"), testImporter])).toStrictEqual([]);
  });

  it("fails a claim the task that made it has already honoured", () => {
    const doorReader = syntheticModule(
      `${CONSOLE_PREFIX}/frame/Ring.tsx`,
      'import { RING_WIDTH_PX } from "../tokens/index.js";\n',
    );

    for (const claim of ["tag", "comment"] as const) {
      expect(
        findingLines(censusFindings([declaringModule, barrel(claim), doorReader])),
      ).toStrictEqual([
        `${CONSOLE_PREFIX}/tokens/index.ts :: RING_WIDTH_PX — claimed, and already imported in production; delete the claim`,
      ]);
    }
  });

  it("leaves a claim standing while the only production reader goes around the door", () => {
    // The claim names an import through THIS door. A family reaching the module that
    // declares the symbol has not made that import, so retiring the marker there
    // would delete a claim whose event has not happened.
    const deepReader = syntheticModule(
      `${CONSOLE_PREFIX}/frame/Ring.tsx`,
      'import { RING_WIDTH_PX } from "../tokens/palette.js";\n',
    );

    expect(censusFindings([declaringModule, barrel("tag"), deepReader])).toStrictEqual([]);
  });

  it("passes a specifier a production module imports through the barrel", () => {
    const productionImporter = syntheticModule(
      `${CONSOLE_PREFIX}/frame/Ring.tsx`,
      'import { RING_WIDTH_PX } from "../tokens/index.js";\n',
    );

    expect(
      censusFindings([declaringModule, barrel("none"), testImporter, productionImporter]),
    ).toStrictEqual([]);
  });

  it("passes a specifier a production module imports through a different door", () => {
    // The disposition that changes nothing: the symbol has a reader, reaching it by
    // the module that declares it rather than by this barrel. A census failing this
    // would be counting doors rather than readers.
    const deepImporter = syntheticModule(
      `${CONSOLE_PREFIX}/frame/Ring.tsx`,
      'import { RING_WIDTH_PX } from "../tokens/palette.js";\n',
    );

    expect(
      censusFindings([declaringModule, barrel("none"), testImporter, deepImporter]),
    ).toStrictEqual([]);
  });

  it("reads an alias by the name the declaring module gave it", () => {
    const aliasingBarrel = syntheticModule(
      `${CONSOLE_PREFIX}/tokens/index.ts`,
      'export { RING_WIDTH_PX as ringWidth } from "./palette.js";\n',
    );
    const deepImporter = syntheticModule(
      `${CONSOLE_PREFIX}/frame/Ring.tsx`,
      'import { RING_WIDTH_PX } from "../tokens/palette.js";\n',
    );

    expect(censusFindings([declaringModule, aliasingBarrel, deepImporter])).toStrictEqual([]);
    expect(findingLines(censusFindings([declaringModule, aliasingBarrel]))).toStrictEqual([
      `${CONSOLE_PREFIX}/tokens/index.ts :: ringWidth — reached only by no importer at all`,
    ]);
  });

  it("does not let one barrel's re-export of another stand in for a reader", () => {
    // A door forwarding to a door moves a name; it does not read one. Both specifiers
    // are findings rather than one carrying the other — which is also why the console
    // forbids the chain outright, in `console-no-barrel-chain`.
    const forwardingBarrel = syntheticModule(
      `${CONSOLE_PREFIX}/frame/index.ts`,
      'export { RING_WIDTH_PX } from "../tokens/index.js";\n',
    );

    expect(
      findingLines(censusFindings([declaringModule, barrel("none"), forwardingBarrel])),
    ).toEqual(
      expect.arrayContaining([
        `${CONSOLE_PREFIX}/tokens/index.ts :: RING_WIDTH_PX — reached only by no importer at all`,
        `${CONSOLE_PREFIX}/frame/index.ts :: RING_WIDTH_PX — reached only by no importer at all`,
      ]),
    );
  });

  it("reads a multi-task claim as one entry, commas and all", () => {
    const multiTagged = syntheticModule(
      `${CONSOLE_PREFIX}/tokens/index.ts`,
      'export {\n  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */\n  RING_WIDTH_PX,\n  RING_GAP_PX,\n} from "./palette.js";\n',
    );

    // The tag covers the entry it precedes and no more: the second name is untagged
    // and unread, so it is still a finding.
    expect(findingLines(censusFindings([declaringModule, multiTagged]))).toStrictEqual([
      `${CONSOLE_PREFIX}/tokens/index.ts :: RING_GAP_PX — reached only by no importer at all`,
    ]);
  });

  it("reports both halves of a stale claim and the neighbour it used to exempt", () => {
    // Where a misattributed claim lands in the RULE, and the smallest corpus a
    // comma-flushing reader passed WHOLE: the claim moved one name down, so
    // `RING_WIDTH_PX` read as unclaimed with a production reader and `RING_GAP_PX`
    // read as claimed with none. Two findings in one clause, and neither reported.
    const staleClaim = syntheticModule(
      `${CONSOLE_PREFIX}/tokens/index.ts`,
      'export {\n  RING_WIDTH_PX, // Consumed by T-023p-1C-2\n  RING_GAP_PX,\n} from "./palette.js";\n',
    );
    const doorReader = syntheticModule(
      `${CONSOLE_PREFIX}/frame/Ring.tsx`,
      'import { RING_WIDTH_PX } from "../tokens/index.js";\n',
    );

    expect(findingLines(censusFindings([declaringModule, staleClaim, doorReader]))).toStrictEqual([
      `${CONSOLE_PREFIX}/tokens/index.ts :: RING_WIDTH_PX — claimed, and already imported in production; delete the claim`,
      `${CONSOLE_PREFIX}/tokens/index.ts :: RING_GAP_PX — reached only by no importer at all`,
    ]);
  });

  it("censuses a door line that names no module of its own", () => {
    // A barrel republishing a name it imported writes no `from`, and a pattern that
    // required one saw no line there. It publishes a name, so it needs a reader or a
    // claim like any other — and the name's declaring identity is the door itself.
    const republishingBarrel = syntheticModule(
      `${CONSOLE_PREFIX}/tokens/index.ts`,
      'import { RING_WIDTH_PX } from "./palette.js";\n\nexport { RING_WIDTH_PX };\n',
    );
    const doorReader = syntheticModule(
      `${CONSOLE_PREFIX}/frame/Ring.tsx`,
      'import { RING_WIDTH_PX } from "../tokens/index.js";\n',
    );

    expect(findingLines(censusFindings([declaringModule, republishingBarrel]))).toStrictEqual([
      `${CONSOLE_PREFIX}/tokens/index.ts :: RING_WIDTH_PX — reached only by no importer at all`,
    ]);
    expect(censusFindings([declaringModule, republishingBarrel, doorReader])).toStrictEqual([]);
  });

  it("names a star re-export rather than censusing fewer specifiers", () => {
    const starBarrel = syntheticModule(
      `${CONSOLE_PREFIX}/tokens/index.ts`,
      'export * from "./palette.js";\n',
    );

    expect(starReexportingBarrels([declaringModule, starBarrel])).toStrictEqual([
      `${CONSOLE_PREFIX}/tokens/index.ts`,
    ]);
    expect(starReexportingBarrels([declaringModule, barrel("none")])).toStrictEqual([]);
  });
});
