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
// The rule itself is `barrel-census.ts` beside this file, so the controls below can
// hand it corpora written to fail. The walk stays here, where the source-walk
// chokepoint can see that it is the shared one.

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
  type CensusModule,
} from "./barrel-census.js";

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

/**
 * Vitest names a screenshot tier's committed reference directory after its spec file.
 *
 * So `test/console/screenshot/__screenshots__/frame.test.tsx` is a DIRECTORY whose
 * name ends in `.tsx`, and the shared walk — which decides what is source by
 * extension — hands it back as a module. No earlier caller passed a root containing
 * one; this census does, so it drops them by the segment that names them rather than
 * by asking the filesystem what each of several hundred entries is.
 */
const REFERENCE_IMAGE_SEGMENT = "__screenshots__/";

/** The console and the tiers that read it, as the census reads them. */
function consoleCensusModules(): readonly CensusModule[] {
  return consoleSourceModules({ roots: CENSUS_ROOTS, tests: true })
    .filter((module) => !module.displayPath.includes(REFERENCE_IMAGE_SEGMENT))
    .map((module) => ({
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
