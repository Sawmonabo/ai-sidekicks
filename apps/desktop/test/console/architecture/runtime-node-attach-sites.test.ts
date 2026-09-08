// Every module in the runtime-node-attach family is renderer source, and names no
// cross-process module on any import surface.
//
// WHY IT IS HERE AND NOT BESIDE THE FAMILY. The claim lived in
// `runtime-node-attach/__tests__/runtime-node-source.test-support.ts`, which read the
// tree through `import.meta.glob("../*.{ts,tsx}", { query: "?raw" })` and handed four
// view suites a pattern table and a keyed lookup. A directory glob in a renderer suite
// is not a read: Vite resolves the pattern at transform time into one static specifier
// per matched file, and knip's Vite plugin reads those as dependency edges out of the
// importing module — which is itself an entry, because the `renderer` include glob
// claims it. So that one helper made every module under `runtime-node-attach/`
// reachable and `structure:dead-code` could report no orphan there; a `.ts` orphan
// planted under the family was invisible to the gate, measured 2026-09-08. The remedy
// is the rule `AGENTS.md §Tests` now states and `ceremony-adapter-sites.test.ts` and
// `repos-tripwire-sites.test.ts` next door already took: a gate that reads the tree as
// TEXT belongs to this tier, where the shared walk and the shared parse live. Reading
// through `ConsoleSourceTree` costs no edge at all, because this tier reads the
// filesystem rather than importing it.
//
// WHAT THE MOVE WIDENED. Each of the four suites named the modules IT was making the
// claim about — one suite covered `CapabilityDeclaration.tsx`, three covered a `.tsx`
// and the `.ts` module its wire call had moved to — so the family's own door,
// `index.ts`, was covered by none of them, and a module added tomorrow would be covered
// by none either. The subject here is the walk's answer, so the family is covered by
// construction and a new module joins the claim the day it lands. The walk also admits
// all four TypeScript module extensions (`console-source-classification.ts` owns that
// set), where the glob read `.ts` and `.tsx` alone.
//
// WHO ELSE OWNS THIS CLAIM, stated rather than left for a reader to discover. The
// primary enforcement is `apps/desktop/eslint.config.mjs`, whose `no-restricted-imports`
// block bans this same set across `src/renderer/src/**/*.{ts,tsx}` at `error` — it runs
// in the package `lint` script, in CI, and it is TRANSITIVE in the way a per-module
// source read can never be: a view that reaches a banned module through a local helper
// fails on the helper's own import. `renderer-import-boundary.test.ts` drives that rule
// through the real ESLint engine and owns its teeth. This gate is a second, independent
// reading of the same claim over one family: it needs no config to be loaded, it covers
// the two module extensions that block's `files` selector does not name, and it is what
// a reader of this family meets when asking what the family is allowed to import. It
// deliberately does NOT re-run ESLint over the live tree — that case was measured and
// removed from `renderer-import-boundary.test.ts` for cost, and `lint` already owns it.
//
// THE INSTRUMENT IS THE PARSER, and it is stronger than the regular expression it
// replaces. Those patterns anchored on `from "…"` / `import "…"` / `import("…")` over
// raw text precisely because these modules discuss "the local daemon" and spell
// "no `electron`, no `node:*`" in PROSE, which a substring match reports. Here a comment
// is not an import: the reading is of the specifier node, on the syntax tree.
//
// FAIL-CLOSED ON WHAT IT CANNOT READ. A specifier that is not a literal — a computed
// dynamic `import(specifier)` — is reported by its own case rather than admitted: such
// a reach is invisible to this reading, and the alternative posture (pass what the parse
// cannot reduce) is the hole this file exists to close. The family names none today.
//
// THE HONEST LIMIT. This reads what a module IMPORTS, so a banned module reached
// through a local helper is invisible here, exactly as it was to the four suites. That
// half is the ESLint rule's, which is path-scoped and therefore fires on the helper.
//
// Refs: docs/plans/003-runtime-node-attach.md §Cross-Plan Obligations CP-003-3,
//       docs/specs/023-desktop-shell-and-renderer.md §Trust Stance.

import { join } from "node:path";

import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ConsoleSourceTree, DESKTOP_SOURCE_ROOT } from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * The family this gate reads, as the walk's own root.
 *
 * Composed under `DESKTOP_SOURCE_ROOT` rather than walked separately: the package-wide
 * root already reaches this subtree, and `source-walk-chokepoint.test.ts` refuses a
 * second directory read. Naming the family as the root rather than filtering the whole
 * package keeps the scan proportional to the claim.
 */
const RUNTIME_NODE_ATTACH_DIRECTORY = join(
  DESKTOP_SOURCE_ROOT,
  "renderer",
  "src",
  "runtime-node-attach",
);

/**
 * The budget this file states rather than inherits.
 *
 * One family walked, read, and parsed — a fraction of the tier-wide readings beside it
 * — under this tier's project concurrency, where the load rather than the tree is what a
 * budget has to survive. The figure is `repos-tripwire-sites.test.ts`', on the same
 * shape and the same subject size.
 */
const FAMILY_PARSE_ALLOWANCE_MS = 30_000;

vi.setConfig({ testTimeout: FAMILY_PARSE_ALLOWANCE_MS, hookTimeout: FAMILY_PARSE_ALLOWANCE_MS });

/**
 * How many modules the family must still hold for a clean result to mean anything.
 *
 * The non-vacuity floor every caller of the walk states: a renamed directory or a moved
 * family would otherwise satisfy every case below over an empty set. Eight is what the
 * family holds today, so the floor is a claim rather than a shrug.
 */
const FAMILY_MODULE_FLOOR = 8;

/** The Node built-ins a renderer module may not name in their bare form. */
const BANNED_BARE_BUILTINS: readonly string[] = [
  "fs",
  "child_process",
  "net",
  "os",
  "path",
  "process",
];

/** The two server-side workspace packages the renderer may never reach. */
const BANNED_WORKSPACE_PACKAGES: readonly string[] = [
  "@ai-sidekicks/runtime-daemon",
  "@ai-sidekicks/control-plane",
];

/** A relative escape into either banned package's own source, whatever the depth. */
const BANNED_PACKAGE_PATH = /(^|\/)packages\/(runtime-daemon|control-plane)\//;

/** One module as this gate reads it: a name for a failure, and the text. */
interface SourceModuleText {
  readonly displayPath: string;
  readonly source: string;
}

/** One module specifier, with the module that names it. */
interface NamedSpecifier {
  readonly displayPath: string;
  /** The specifier's own text, or `undefined` where the parse could not reduce it. */
  readonly specifier: string | undefined;
}

/** Whether a bare specifier names `candidate` itself or one of its subpaths. */
function namesPackage(specifier: string, candidate: string): boolean {
  return specifier === candidate || specifier.startsWith(`${candidate}/`);
}

/** Whether one specifier reaches a capability the renderer takes through the bridge. */
function isBannedSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    namesPackage(specifier, "electron") ||
    BANNED_BARE_BUILTINS.includes(specifier) ||
    BANNED_WORKSPACE_PACKAGES.some((banned) => namesPackage(specifier, banned)) ||
    BANNED_PACKAGE_PATH.test(specifier)
  );
}

/** A string whose value is fixed at the specifier — quoted or a bare template. */
function literalTextOf(node: ts.Node | undefined): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

/** Whether `node` is a dynamic `import(…)` call rather than an ordinary one. */
function isDynamicImportCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

/**
 * The specifier one node names, or `undefined` where the node names none.
 *
 * The four surfaces a module reaches another one through, and every one of them is a
 * node with a specifier rather than a shape of text: a static import (side-effect form
 * included, which carries no clause at all), a re-export, a dynamic import, and the
 * `import("…")` a type position takes.
 */
function specifierNodeOf(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (ts.isExportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (isDynamicImportCall(node)) {
    return node.arguments[0];
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    return node.argument.literal;
  }
  return undefined;
}

/** Every specifier the modules name, in scan order, unreadable ones included. */
function namedSpecifiers(modules: readonly SourceModuleText[]): readonly NamedSpecifier[] {
  const specifiers: NamedSpecifier[] = [];
  for (const module of modules) {
    const parsed = parseSourceText(module.displayPath, module.source);
    forEachDescendant(parsed, (node) => {
      const specifierNode = specifierNodeOf(node);
      if (specifierNode === undefined && !isDynamicImportCall(node)) {
        return;
      }
      specifiers.push({
        displayPath: module.displayPath,
        specifier: literalTextOf(specifierNode),
      });
    });
  }
  return specifiers;
}

/** Every banned reach, named the way a failure names it. */
function bannedReaches(specifiers: readonly NamedSpecifier[]): readonly string[] {
  return specifiers
    .filter((named) => named.specifier !== undefined && isBannedSpecifier(named.specifier))
    .map((named) => `${named.displayPath} imports "${named.specifier ?? ""}"`);
}

/** Every specifier the parse could not reduce to a literal. */
function unreadableReaches(specifiers: readonly NamedSpecifier[]): readonly string[] {
  return specifiers
    .filter((named) => named.specifier === undefined)
    .map((named) => `${named.displayPath} imports a specifier this reading cannot reduce`);
}

const tree = new ConsoleSourceTree({ roots: [RUNTIME_NODE_ATTACH_DIRECTORY] });

describe("the runtime-node-attach family — every module is renderer source", () => {
  beforeAll(() => {
    tree.read();
  });

  const readSpecifiers = (): readonly NamedSpecifier[] => namedSpecifiers(tree.reading.texts);

  it("holds the modules the claim is made over, so a clean result is not an empty set", () => {
    expect(tree.reading.modules.length).toBeGreaterThanOrEqual(FAMILY_MODULE_FLOOR);
  });

  it("names its own door among them, which no per-suite scan covered", () => {
    // The module the four view suites could not name, because each named the files it
    // was itself rendering. A door that stopped being walked would take the widening
    // this move was made for with it.
    expect(tree.reading.modules.map((module) => module.displayPath)).toContain(
      "runtime-node-attach/index.ts",
    );
  });

  it("reaches no daemon, control-plane, Node, or Electron module", () => {
    expect(bannedReaches(readSpecifiers())).toStrictEqual([]);
  });

  it("names every specifier as a literal, so nothing is admitted unread", () => {
    expect(unreadableReaches(readSpecifiers())).toStrictEqual([]);
  });

  it("negative control: the reading reports every surface and clears prose and neighbours", () => {
    const planted: readonly SourceModuleText[] = [
      {
        displayPath: "runtime-node-attach/static.ts",
        source: 'import { readFile } from "node:fs/promises";\nexport const read = readFile;\n',
      },
      {
        displayPath: "runtime-node-attach/side-effect.ts",
        source: 'import "@ai-sidekicks/control-plane";\n',
      },
      {
        displayPath: "runtime-node-attach/dynamic.ts",
        source: 'export const daemon = await import("@ai-sidekicks/runtime-daemon/projector");\n',
      },
      {
        displayPath: "runtime-node-attach/re-export.ts",
        source: 'export { app } from "electron/main";\n',
      },
      {
        displayPath: "runtime-node-attach/type-position.ts",
        source: 'export type Stats = import("fs").Stats;\n',
      },
      {
        displayPath: "runtime-node-attach/relative-escape.ts",
        source: 'import { project } from "../../../../packages/runtime-daemon/src/projector.js";\n',
      },
      {
        // The false positive the regular expression this replaces had to be written
        // around: these modules SPELL the banned names in prose, and one of them writes
        // the sentence below almost verbatim.
        displayPath: "runtime-node-attach/prose.ts",
        source: [
          '// No `electron`, no `node:*`, and never from "@ai-sidekicks/control-plane".',
          'import { useState } from "react";',
          "export const state = useState;",
        ].join("\n"),
      },
      {
        // A neighbour whose name merely starts with a banned one. `pathfinder` is not
        // `path`, and a `startsWith` written without the separator would report it.
        displayPath: "runtime-node-attach/neighbour.ts",
        source: 'import { find } from "pathfinder";\nexport const found = find;\n',
      },
      {
        displayPath: "runtime-node-attach/computed.ts",
        source: "export const load = async (name: string) => await import(name);\n",
      },
    ];

    const specifiers = namedSpecifiers(planted);
    expect(bannedReaches(specifiers)).toStrictEqual([
      'runtime-node-attach/static.ts imports "node:fs/promises"',
      'runtime-node-attach/side-effect.ts imports "@ai-sidekicks/control-plane"',
      'runtime-node-attach/dynamic.ts imports "@ai-sidekicks/runtime-daemon/projector"',
      'runtime-node-attach/re-export.ts imports "electron/main"',
      'runtime-node-attach/type-position.ts imports "fs"',
      'runtime-node-attach/relative-escape.ts imports "../../../../packages/runtime-daemon/src/projector.js"',
    ]);
    expect(unreadableReaches(specifiers)).toStrictEqual([
      "runtime-node-attach/computed.ts imports a specifier this reading cannot reduce",
    ]);
  });
});
