// Where a gate that parses source text is allowed to live.
//
// A gate that reads the tree as TEXT belongs to this tier, and the mechanism that
// keeps it here is a compiler option rather than a convention:
// `src/renderer/tsconfig.test.json` inherits `rootDir: "src/"` from the renderer
// project, so a co-located suite importing `test/console/typescript-source.js` is
// TS6059 — "not under rootDir" — and not a matter of taste. The renderer's own suites
// are inside `src/` because the modules they cover are; the parse helper is outside it
// because nothing shipped ever parses TypeScript.
//
// A family that wants such a gate has therefore reached a fork with exactly two ways
// on, and one of them is wrong: move the suite into this directory, where the helper
// and the shared walk both are, or restate the parse beside the family — which is the
// fifth copy of `createSourceFile` with the fifth set of options, and the drift the
// source-walk chokepoint next door exists to end. This gate closes the second way.
//
// SO THE CLAIM IS TWO-SIDED, and the second side is what keeps it honest. It is not
// enough that nothing under `src/` parses: a gate asserting only that would also pass
// over a tree that had stopped parsing anywhere at all, which is what a tier whose
// gates were quietly deleted looks like. The positive side names the tier as the one
// home and asserts it is populated.
//
// The instrument is the parser, through this tier's own reader: a `typescript` import
// is a statement, and a scan for the word would count the mention in the sentence
// above.

import { describe, expect, it, vi } from "vitest";

import {
  consoleSourceModules,
  DESKTOP_PROSE_ROOTS,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import { moduleSpecifiersIn } from "./source-walk-census.js";

/**
 * The reading this file pays for once, and the budget it is measured against.
 *
 * The whole package parsed twice over — 541 modules at 250-340 ms on the authoring
 * machine, measured 2026-09-05 — under this tier's five-project concurrency. The hook
 * carries the reading and the cases compare over it, the split
 * `one-doc-per-declaration.test.ts` states for the same walk.
 */
const PACKAGE_PARSE_ALLOWANCE_MS = 30_000;
const COMPARISON_ALLOWANCE_MS = 10_000;

vi.setConfig({ testTimeout: COMPARISON_ALLOWANCE_MS, hookTimeout: PACKAGE_PARSE_ALLOWANCE_MS });

/** The one home, as a path prefix a display path is tested against. */
const PARSE_TIER_PREFIX = "test/console/";

/** The compiler itself, which is imported by its package name and never a path. */
const COMPILER_SPECIFIER = "typescript";

/**
 * This tier's parse home, matched by suffix.
 *
 * A relative path is the only way to reach it and the number of `../` segments is
 * whatever the importer's depth makes it, so the suffix is the stable half. Matched
 * on the file name rather than on a leading `./`, which a co-located importer five
 * directories down does not write.
 */
const PARSE_HOME_SUFFIX = "typescript-source.js";

/** Whether `specifier` reaches the compiler or this tier's parse home. */
function isParseReach(specifier: string): boolean {
  return specifier === COMPILER_SPECIFIER || specifier.endsWith(PARSE_HOME_SUFFIX);
}

/** One module this gate holds to the rule, named the way a failure names it. */
interface PackageModuleText {
  readonly path: string;
  readonly source: string;
}

/** Every module in `modules` that reaches a parse, named by its display path. */
function parsingModules(modules: readonly PackageModuleText[]): readonly string[] {
  return modules
    .filter((module) => moduleSpecifiersIn(module.source, module.path).some(isParseReach))
    .map((module) => module.path);
}

/** The package's modules, read once through the shared walk. */
function packageModules(): readonly PackageModuleText[] {
  return consoleSourceModules({ roots: DESKTOP_PROSE_ROOTS, tests: true }).map((module) => ({
    path: module.displayPath,
    source: readConsoleSourceModule(module),
  }));
}

describe("a source-text gate lives in the tier that owns the parse", () => {
  const parsing = parsingModules(packageModules());

  it("has no module under `src/` reaching the compiler or the parse home", () => {
    expect(parsing.filter((path) => path.startsWith("src/"))).toStrictEqual([]);
  });

  it("has every parsing module inside this tier, and finds some", () => {
    // The non-vacuity half. A tier whose gates had been deleted would satisfy the
    // case above and say nothing about it.
    expect(parsing.length).toBeGreaterThan(5);
    expect(parsing.filter((path) => !path.startsWith(PARSE_TIER_PREFIX))).toStrictEqual([]);
  });

  it("negative control: the reader names a planted parse under `src/` and clears a plain module", () => {
    // Without this, a reader that matched no import shape would report clean over
    // any tree at all, which is the failure this class of gate is most prone to.
    const planted: readonly PackageModuleText[] = [
      {
        path: "src/renderer/src/console/ledger/ledger-declared-sets.test.ts",
        source: 'import ts from "typescript";\nexport const kinds = ts.SyntaxKind;\n',
      },
      {
        path: "src/renderer/src/console/ledger/ledger-shape.test.ts",
        source:
          'import { parseSourceText } from "../../../../../test/console/typescript-source.js";\nexport const parse = parseSourceText;\n',
      },
      {
        path: "src/renderer/src/console/ledger/index.ts",
        source: 'export { LedgerPane } from "./LedgerPane.js";\n',
      },
    ];

    expect(parsingModules(planted)).toStrictEqual([
      "src/renderer/src/console/ledger/ledger-declared-sets.test.ts",
      "src/renderer/src/console/ledger/ledger-shape.test.ts",
    ]);
  });

  it("negative control: the reader reads an import and not a mention of one", () => {
    // The word appears in this file's own header, in a comment, and in a string a
    // gate builds its message out of. None of the three is a reach.
    const mentions: readonly PackageModuleText[] = [
      {
        path: "src/renderer/src/console/core/refusal.ts",
        source: [
          "// A gate that parses with typescript belongs in the tier.",
          'export const advice = "import ts from \\"typescript\\" in the architecture tier";',
        ].join("\n"),
      },
    ];

    expect(parsingModules(mentions)).toStrictEqual([]);
  });
});
