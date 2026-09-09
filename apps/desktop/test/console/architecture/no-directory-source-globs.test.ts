// A renderer suite never globs a directory, because a glob is an EDGE and not a read.
//
// WHAT THE FINDING WAS, measured 2026-09-08. `pnpm --filter @ai-sidekicks/desktop
// structure:dead-code` reported nothing at all for a wholly unreachable module planted
// at `console/core/knip-negative-control.ts` — rc 0, no `Unused files` line — while the
// same plant under `scripts/budget/` was reported at rc 1. The cause is one suite:
// `console/sign-in/ceremony-adapter.test.ts` read the tree with
// `import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", eager: true })`. Vite's plugin
// resolves that pattern at transform time into a static specifier per matched file, and
// knip's Vite plugin reads those as dependency edges out of the importing module — which
// is itself an ENTRY, because the `console-unit` include glob claims it. So one
// source-text suite made every module under `console/` reachable from an entry, and the
// gate that reports orphans went silent for the whole family tree. `repos/` had the same
// hole from `test/console/architecture/repos-tripwire-sites.test.ts`, and two of the legacy renderer families had it
// too, measured the same way — a `.ts` orphan planted under `runtime-node-attach/` and a
// `.tsx` one under `session-members/` were each reported by nothing. All three were
// settled rather than exempted: two suites narrowed to the single file each read by key,
// and the family-wide reader moved to `runtime-node-attach-sites.test.ts` in this tier.
// The roster of recorded exceptions those three held is empty, and the case below
// therefore quantifies over the tree with no subtraction at all.
//
// WHY THE RULE IS THE PATTERN RATHER THAN THE CALL. A glob naming ONE file manufactures
// no reachability that an ordinary import would not: the module it names is reached, and
// nothing else is. What defeats the gate is the wildcard, which reaches a set nobody
// enumerated — including files added later, by someone who never read this suite. So a
// single-file pattern passes and a pattern carrying `*` does not, and every single-file
// glob the tree keeps is covered by existing rather than by exemption.
//
// AND THE SUBJECT IS EVERY MODULE UNDER `src/` AND UNDER `test/`, not only the suites in
// one of them. A production module globbing a directory manufactures the same edges, and
// it would additionally defeat the loader boundary `AGENTS.md §Module shape` fixes on
// `body: () => import("./<name>-body.js")` — a lazily-loaded body found by wildcard is a
// body no board registered. The console carries no such module today; the claim covers
// the ones nobody has written yet.
//
// THE TEST TIERS ARE IN THE SUBJECT BECAUSE THE DEFECT IS A PROPERTY OF AN ENTRY, not of
// a directory. What made the measured hole is that a module a Vitest `include` glob
// claims is an ENTRY, and knip reads the specifiers Vite resolved out of it as that
// entry's dependency edges. Every module under `test/console/<tier>/` is such an entry —
// so an architecture suite globbing `"../../../src/renderer/src/console/**/*.ts"` reopens
// the measured defect verbatim, and a walk scoped to `src/` reports clean over it. The
// walk is therefore `DESKTOP_PROSE_ROOTS`, and the case below PROVES that covers the
// runner rather than assuming it: every include glob the console tiers declare is rooted
// inside one of the walked roots, checked against `vitest/console-projects.ts` itself.
//
// THE INSTRUMENT IS THE PARSER. A text needle for `import.meta.glob` matches the mention
// in this header, in every header that explains why a suite stopped using one, and in the
// ambient `declare global` block each such suite writes above its own call. The reading
// below is of the call node, and the pattern it reads is the argument's own literal.
//
// FAIL-CLOSED ON WHAT IT CANNOT READ. A pattern that is not a literal — a constant, a
// template with a substitution — is reported rather than admitted: Vite requires a
// literal there, so such a call does not work anyway, and the alternative reading
// (exempt what the parse cannot reduce) is the hole this file exists to close.

import { relative } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";
import ts from "typescript";

import { CONSOLE_TIER_INCLUDE_GLOBS } from "../../../vitest/console-projects.js";
import {
  ConsoleSourceTree,
  DESKTOP_PACKAGE_ROOT,
  DESKTOP_PROSE_ROOTS,
  toPosixSeparators,
} from "../console-source-modules.js";
import {
  forEachDescendant,
  literalTextOf,
  parseSourceText,
  type SourceModuleText,
} from "../typescript-source.js";

/**
 * The budget this file states rather than inherits.
 *
 * The package's renderer and main trees walked, read, and parsed once, under this
 * tier's project concurrency — the shape `source-parse-home.test.ts` measures at
 * 250-340 ms for the whole package. Set well above it, because what a budget guards
 * is a pass that never settles rather than a slow one.
 */
const PACKAGE_PARSE_ALLOWANCE_MS = 30_000;

vi.setConfig({ testTimeout: PACKAGE_PARSE_ALLOWANCE_MS, hookTimeout: PACKAGE_PARSE_ALLOWANCE_MS });

/** What makes a pattern reach a set nobody enumerated. `**` carries it too. */
const WILDCARD = "*";

/** How many single-file globs the tree must still hold for a clean result to mean anything. */
const SINGLE_FILE_GLOB_FLOOR = 4;

/**
 * How many modules the walk must reach under `test/` for the widening to mean anything.
 *
 * The vacuity guard on the roots rather than on the patterns: a walk that had stopped
 * reaching the test tiers would satisfy the offender case over the tiers by finding no
 * module in them at all, which reads exactly like a tier that globs nothing.
 */
const TEST_TIER_MODULE_FLOOR = 50;

/** The roots this gate walks, package-relative, as an include glob spells them. */
const WALKED_ROOT_NAMES: readonly string[] = DESKTOP_PROSE_ROOTS.map((root) =>
  toPosixSeparators(relative(DESKTOP_PACKAGE_ROOT, root)),
);

/** One `import.meta.glob` call, as the tree records it. */
interface SourceGlobCall {
  readonly displayPath: string;
  /** Every pattern the call names, or an empty list where the parse could not read one. */
  readonly patterns: readonly string[];
}

/** Whether `node` is the `import.meta.glob` member, and not some other `.glob`. */
function isImportMetaGlob(node: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "glob") {
    return false;
  }
  const receiver = node.expression;
  return (
    ts.isMetaProperty(receiver) &&
    receiver.keywordToken === ts.SyntaxKind.ImportKeyword &&
    receiver.name.text === "meta"
  );
}

/**
 * Every pattern one call names — Vite admits a literal or an array of them.
 *
 * A PARTIALLY-UNREADABLE ARRAY IS UNREADABLE, and answering `[]` is how this refuses:
 * `manufacturesEdges` reads an empty list as the fail-closed arm the header promises.
 * Filtering the unreadable elements out instead was a hole of exactly the shape this
 * file exists to close — `import.meta.glob(["./one.ts", LEDGER_PATTERN])` reduced to one
 * literal carrying no `*`, and a call whose other half reaches a set nobody enumerated
 * cleared the gate with nothing reported.
 */
function patternsOf(call: ts.CallExpression): readonly string[] {
  const [first] = call.arguments;
  if (first === undefined) {
    return [];
  }
  if (ts.isArrayLiteralExpression(first)) {
    const patterns = first.elements.map(literalTextOf);
    return patterns.every((pattern) => pattern !== undefined) ? (patterns as string[]) : [];
  }
  const single = literalTextOf(first);
  return single === undefined ? [] : [single];
}

/** Every `import.meta.glob` call in the modules given, in scan order. */
function sourceGlobCalls(modules: readonly SourceModuleText[]): readonly SourceGlobCall[] {
  const calls: SourceGlobCall[] = [];
  for (const module of modules) {
    const parsed = parseSourceText(module.displayPath, module.source);
    forEachDescendant(parsed, (node) => {
      if (ts.isCallExpression(node) && isImportMetaGlob(node.expression)) {
        calls.push({ displayPath: module.displayPath, patterns: patternsOf(node) });
      }
    });
  }
  return calls;
}

/** Whether a call reaches a set nobody enumerated, an unreadable pattern included. */
function manufacturesEdges(call: SourceGlobCall): boolean {
  return call.patterns.length === 0 || call.patterns.some((pattern) => pattern.includes(WILDCARD));
}

/** Every offending call, named the way a failure names it. */
function directoryGlobOffenders(calls: readonly SourceGlobCall[]): readonly string[] {
  return calls
    .filter(manufacturesEdges)
    .map((call) => `${call.displayPath}: ${call.patterns.join(", ") || "(pattern not a literal)"}`);
}

/**
 * The directory an include glob is rooted at: every segment above its first wildcard.
 *
 * A pattern with no wildcard at all names one file, so its root is the directory holding
 * it — the same reduction, one segment further in.
 */
function includeGlobRoot(includeGlob: string): string {
  const segments = includeGlob.split("/");
  const firstWildcard = segments.findIndex((segment) => segment.includes(WILDCARD));
  return (firstWildcard === -1 ? segments.slice(0, -1) : segments.slice(0, firstWildcard)).join(
    "/",
  );
}

/** Every include glob whose root the walk does not reach, named the way a failure names it. */
function unwalkedIncludeGlobs(
  includeGlobs: readonly string[],
  walkedRoots: readonly string[],
): readonly string[] {
  return includeGlobs.filter(
    (includeGlob) =>
      !walkedRoots.some((root) => `${includeGlobRoot(includeGlob)}/`.startsWith(`${root}/`)),
  );
}

const tree = new ConsoleSourceTree({ roots: DESKTOP_PROSE_ROOTS, tests: true });

describe("no module under `src/` globs a directory of its own", () => {
  beforeAll(() => {
    tree.read();
  });

  const callsInTree = (): readonly SourceGlobCall[] => sourceGlobCalls(tree.reading.texts);

  it("manufactures no reachability the dead-code gate would then miss", () => {
    // Quantified over the whole tree and over no exception, which is the state the
    // roster this gate landed with was written to reach: three legacy sites recorded
    // with their remedies, each settled by the change that removed its entry.
    expect(directoryGlobOffenders(callsInTree())).toStrictEqual([]);
  });

  it("reads the test tiers, where a glob would reopen the measured defect verbatim", () => {
    // The widening's own non-vacuity. Every module under `test/console/<tier>/` is an
    // ENTRY the runner's include globs make, so a suite there globbing the console
    // manufactures the same edges a renderer suite does — and a walk scoped to `src/`
    // reports clean over every one of them.
    const tierModules = tree.reading.texts.filter((module) =>
      module.displayPath.startsWith("test/console/"),
    );
    expect(tierModules.length).toBeGreaterThanOrEqual(TEST_TIER_MODULE_FLOOR);
  });

  it("walks every root the console tiers make an entry of", () => {
    // Derived from `vitest/console-projects.ts` rather than asserted about it: a tier
    // added under a root this walk does not reach is a hole nothing else reports, and a
    // hand-listed copy of these globs would agree with the config exactly until one moved.
    expect(unwalkedIncludeGlobs(CONSOLE_TIER_INCLUDE_GLOBS, WALKED_ROOT_NAMES)).toStrictEqual([]);
    expect(CONSOLE_TIER_INCLUDE_GLOBS.length).toBeGreaterThan(WALKED_ROOT_NAMES.length);
  });

  it("negative control: an include root outside the walk is reported", () => {
    // Without this the case above passes over a reduction that answered "inside" for
    // every glob it was handed.
    expect(
      unwalkedIncludeGlobs(
        ["e2e/**/*.test.ts", "test/console/architecture/**/*.test.ts", "srcx/thing.test.ts"],
        WALKED_ROOT_NAMES,
      ),
    ).toStrictEqual(["e2e/**/*.test.ts", "srcx/thing.test.ts"]);
  });

  it("still sees the single-file globs the tree keeps, so a clean result means something", () => {
    // The non-vacuity half. A reading that had stopped recognising the call shape would
    // satisfy the first case over any tree at all.
    const singleFile = callsInTree().filter((call) => !manufacturesEdges(call));
    expect(singleFile.length).toBeGreaterThanOrEqual(SINGLE_FILE_GLOB_FLOOR);
  });

  it("negative control: the reading reports a wildcard and an unreadable pattern, and clears one file", () => {
    const planted: readonly SourceModuleText[] = [
      {
        displayPath: "src/renderer/src/console/ledger/ledger-sites.test.ts",
        source: 'const sources = import.meta.glob("./**/*.ts", { query: "?raw", eager: true });',
      },
      {
        displayPath: "src/renderer/src/console/ledger/ledger-shape.test.ts",
        source: 'const one = import.meta.glob("./ledger-rows.ts", { query: "?raw", eager: true });',
      },
      {
        displayPath: "src/renderer/src/console/ledger/ledger-names.test.ts",
        source: 'const many = import.meta.glob(LEDGER_PATTERN, { query: "?raw", eager: true });',
      },
      {
        // The ARRAY form, one literal and one constant. Filtering the unreadable element
        // out reduced this to `./one.ts` — one pattern, no `*` — and cleared a call whose
        // other half reaches a set nobody enumerated.
        displayPath: "src/renderer/src/console/ledger/ledger-mixed.test.ts",
        source:
          'const mixed = import.meta.glob(["./one.ts", LEDGER_PATTERN], { query: "?raw", eager: true });',
      },
      {
        // The array form both of whose elements ARE readable, so the refusal above is a
        // claim about the unreadable element rather than about arrays.
        displayPath: "src/renderer/src/console/ledger/ledger-pair.test.ts",
        source:
          'const pair = import.meta.glob(["./one.ts", "./two.ts"], { query: "?raw", eager: true });',
      },
      {
        // A `.glob` that is not this one. Reading the member name alone would report a
        // module that never touched Vite's macro at all.
        displayPath: "src/renderer/src/console/ledger/ledger-search.ts",
        source: 'export const found = matcher.glob("./**/*.ts");',
      },
    ];

    expect(directoryGlobOffenders(sourceGlobCalls(planted))).toStrictEqual([
      "src/renderer/src/console/ledger/ledger-sites.test.ts: ./**/*.ts",
      "src/renderer/src/console/ledger/ledger-names.test.ts: (pattern not a literal)",
      "src/renderer/src/console/ledger/ledger-mixed.test.ts: (pattern not a literal)",
    ]);
  });
});
