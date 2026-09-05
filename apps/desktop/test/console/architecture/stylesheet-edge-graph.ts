// The stylesheet edge graph: who imports which sheet, counted rather than collapsed.
//
// A MODEL WITH ITS OWN MODULE because it has its own test. The claims about the
// console live in `stylesheet-edges.test.ts`; what lives here is the walk they are
// made with, and the walk is a pure function over a TREE rather than over the disk so
// that its own test can drive it with a graph whose verdict is known. Planting a
// duplicate edge to prove the counter bites would otherwise mean a test writing into
// the console's source.
//
// COUNTED, NOT COLLAPSED, and that is this module's whole reason for existing in the
// shape it has. An earlier revision gathered the walk into a `Set` of reached sheets
// and asked only whether each sheet was in it, so a sheet imported from two barrels,
// or reached through two `@import` chains, was one member of a set and passed an
// assertion whose name said "exactly once". Every inbound edge is retained here — who
// named the sheet, by what specifier, and which barrel the walk that found it started
// from — so both duplicates are countable and both are reported with their causes.

import { readFileSync } from "node:fs";
import { dirname, join, posix, sep } from "node:path";

import ts from "typescript";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  consoleStylesheets,
  type ConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/**
 * How a file's stylesheet specifiers are read out of it.
 *
 * A function per LANGUAGE rather than a pattern per shape, because the two questions
 * are asked of two grammars and neither is answerable by a line match. Both readers
 * take the file's name as well as its text: one needs it to choose a script kind, and
 * the other reports it.
 */
export type StylesheetSpecifierReader = (fileName: string, source: string) => readonly string[];

/**
 * The tree a walk reads: which modules and stylesheets exist, and their text.
 *
 * An interface rather than the disk directly, so one implementation is the console and
 * the other is a handful of literal sources a control writes out.
 */
export interface StylesheetTree {
  readonly modulePaths: readonly string[];
  readonly stylesheetPaths: readonly string[];
  read(treeRelativePath: string): string;
}

/** One inbound edge into a stylesheet: who named it, how, and from which barrel. */
export interface StylesheetEdge {
  /** The module or stylesheet that wrote the specifier. */
  readonly importer: string;
  /** The specifier as written, so a report names the text a reader has to find. */
  readonly specifier: string;
  /** The barrel the walk that found this edge started from. */
  readonly owningBarrel: string;
}

/** Every inbound edge into every stylesheet the barrels reach, by sheet. */
export type StylesheetEdgeGraph = ReadonlyMap<string, readonly StylesheetEdge[]>;

/** The three ways a tree's stylesheet edges can be wrong, each with its edges. */
export interface StylesheetEdgeOffences {
  readonly unreached: readonly string[];
  readonly duplicatePaths: readonly string[];
  readonly duplicateBarrels: readonly string[];
}

/**
 * Every stylesheet a TypeScript module imports for its side effect.
 *
 * READ FROM THE PARSE, because the question is about a declaration boundary and a
 * regular expression cannot see one. The pattern this replaced was a whole-LINE match,
 * so `import "./parks.css"; // ships with the parks module` was not an edge, and
 * neither was a specifier broken across two lines: the sheet then read as unreached
 * and the gate reported a tree with an orphaned stylesheet as clean. A side-effect
 * import is exactly `ts.isImportDeclaration(node) && node.importClause === undefined`,
 * and the specifier is the string literal the declaration already holds — no text
 * between the two for a pattern to run past.
 *
 * `.css` and nothing else, because this walk is about stylesheets and a module also
 * side-effect-imports polyfills and registries that are not sheets.
 */
export const moduleStylesheetImports: StylesheetSpecifierReader = (fileName, source) => {
  // A STYLESHEET HANDED HERE ANSWERS WITH ITS OWN AT-RULES, measured: TypeScript's
  // error recovery reads `@import "./surface.css";` as a decorator followed by a
  // side-effect import, so this reader is not blind to CSS by parsing alone. The walk
  // never hands it one — `CONSOLE_STYLESHEET_TREE.modulePaths` holds `.ts` and `.tsx`
  // — and this guard makes that a property of the reader rather than of its callers.
  if (!fileName.endsWith(".ts") && !fileName.endsWith(".tsx")) {
    return [];
  }
  const specifiers: string[] = [];
  const parsed = parseSourceText(fileName, source);
  forEachDescendant(parsed, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause === undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.endsWith(".css")
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
  });
  return specifiers;
};

/** A comment in a stylesheet, so a commented-out `@import` is not read as one. */
const CSS_COMMENT = /\/\*[\s\S]*?\*\//gu;

/** The head of an `@import` at-rule: the keyword and whatever follows it, to its end. */
const CSS_AT_IMPORT_PRELUDE = /@import\b(?<prelude>[^;{]*)/gu;

/** The target of an `@import` prelude, quoted directly or wrapped in `url()`. */
const CSS_IMPORT_TARGET =
  /url\(\s*(?<quoted>"[^"]*"|'[^']*'|[^)\s]*)\s*\)|"(?<double>[^"]*)"|'(?<single>[^']*)'/u;

/**
 * Every stylesheet an `@import` at-rule pulls into this sheet.
 *
 * ANCHORED ON THE AT-RULE, not on a line. The pattern this replaced matched a whole
 * line and required the closing `";` to end it, so an `@import` carrying a media
 * query, a cascade layer, or a trailing comment disappeared from the graph — and a
 * sheet reached only that way was reported as unreached while a sheet reached twice
 * was reported as reached once. The prelude runs from the keyword to the `;` or `{`
 * that ends it, and the target is the first string in it however it is written, which
 * is what the CSS grammar says an `@import` names.
 *
 * Comments are stripped first, so a commented-out `@import` is not an edge — the one
 * way this question can be asked wrongly that anchoring alone does not answer.
 */
export const stylesheetAtImports: StylesheetSpecifierReader = (_fileName, source) => {
  const withoutComments = source.replace(CSS_COMMENT, " ");
  const specifiers: string[] = [];
  for (const atRule of withoutComments.matchAll(CSS_AT_IMPORT_PRELUDE)) {
    const target = CSS_IMPORT_TARGET.exec(atRule.groups?.["prelude"] ?? "");
    if (target === null) {
      continue;
    }
    const quoted = target.groups?.["quoted"];
    const unwrapped =
      quoted === undefined
        ? (target.groups?.["double"] ?? target.groups?.["single"])
        : quoted.replace(/^["']|["']$/gu, "");
    if (unwrapped !== undefined && unwrapped !== "") {
      specifiers.push(unwrapped);
    }
  }
  return specifiers;
};

/**
 * Whether a tree-relative module path is a barrel — a family's door or a lazily
 * loaded chunk's, which the rule treats alike.
 *
 * The two are the same shape on purpose. What a stylesheet edge needs is a module that
 * is the single way into the code the sheet paints, and a door is that whether the
 * code behind it is a family or a chunk; a predicate that tried to tell them apart
 * would be reading intent out of a path.
 */
export function isOwningBarrel(modulePath: string): boolean {
  return modulePath.endsWith(`${sep}index.ts`);
}

/**
 * A specifier resolved against the file that wrote it, back to a tree-relative path —
 * or `undefined` where it names a package rather than a file in this tree.
 *
 * The graph library's own `base.css` is the case that returns `undefined`: it is a
 * bare specifier, it is not this tree's to place, and the reachability claim is about
 * sheets the console owns.
 */
export function resolveStylesheet(importerPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const importerDirectory = dirname(importerPath).split(sep).join(posix.sep);
  return posix.normalize(posix.join(importerDirectory, specifier)).split(posix.sep).join(sep);
}

/**
 * Record every stylesheet `importer` names, and queue each for its own descent.
 *
 * The edge is recorded before anything decides whether to descend, which is the whole
 * difference from the collapsing walk this replaced: a sheet reached a second time
 * still contributes its second edge, and only the DESCENT is skipped.
 */
function recordStylesheetEdges(
  tree: StylesheetTree,
  importer: string,
  owningBarrel: string,
  readSpecifiers: StylesheetSpecifierReader,
  edges: Map<string, StylesheetEdge[]>,
  pending: string[],
): void {
  for (const specifier of readSpecifiers(importer, tree.read(importer))) {
    const resolved = resolveStylesheet(importer, specifier);
    if (resolved === undefined) {
      continue;
    }
    const inbound = edges.get(resolved) ?? [];
    inbound.push({ importer, specifier, owningBarrel });
    edges.set(resolved, inbound);
    pending.push(resolved);
  }
}

/**
 * Every stylesheet edge in `tree`, following `@import` chains out of every barrel.
 *
 * THE VISITED SET IS PER WALK RATHER THAN GLOBAL, and the difference is not where it
 * first looks. A sheet named directly by two barrels is counted either way, because
 * the edge is recorded when the specifier is read and before anything is marked — the
 * set governs the DESCENT alone. What a global set would lose is everything BELOW a
 * doubly-reached sheet: the second walk would stop at it, so the sheets its own
 * `@import`s pull in would carry one edge attributed to whichever barrel the walk
 * order happened to reach first. That is the module-graph-order dependence this whole
 * file exists to remove, reintroduced inside the checker. Per walk, a sheet injected
 * into the cascade twice is reported at every level it injects, and the attribution is
 * order-free. Within one walk the set still stops a cyclic `@import` from looping, and
 * the edge that closed the cycle is already recorded.
 */
export function collectStylesheetEdges(tree: StylesheetTree): StylesheetEdgeGraph {
  const edges = new Map<string, StylesheetEdge[]>();
  for (const owningBarrel of tree.modulePaths.filter(isOwningBarrel)) {
    const visited = new Set<string>();
    const pending: string[] = [];
    recordStylesheetEdges(
      tree,
      owningBarrel,
      owningBarrel,
      moduleStylesheetImports,
      edges,
      pending,
    );
    while (pending.length > 0) {
      const sheet = pending.pop() ?? "";
      if (visited.has(sheet)) {
        continue;
      }
      visited.add(sheet);
      recordStylesheetEdges(tree, sheet, owningBarrel, stylesheetAtImports, edges, pending);
    }
  }
  return edges;
}

/** The offending sheets, each reported with the edges that made it one. */
export function stylesheetEdgeOffences(
  tree: StylesheetTree,
  edges: StylesheetEdgeGraph,
): StylesheetEdgeOffences {
  const unreached: string[] = [];
  const duplicatePaths: string[] = [];
  const duplicateBarrels: string[] = [];
  for (const sheet of tree.stylesheetPaths) {
    const inbound = edges.get(sheet) ?? [];
    if (inbound.length === 0) {
      unreached.push(sheet);
      continue;
    }
    if (inbound.length > 1) {
      const paths = inbound.map((edge) => `${edge.importer} → "${edge.specifier}"`).join("; ");
      duplicatePaths.push(`${sheet}: ${inbound.length} inbound edges — ${paths}`);
    }
    const owningBarrels = [...new Set(inbound.map((edge) => edge.owningBarrel))].sort();
    if (owningBarrels.length > 1) {
      duplicateBarrels.push(`${sheet}: reached from ${owningBarrels.join(", ")}`);
    }
  }
  return { unreached, duplicatePaths, duplicateBarrels };
}

/**
 * A tree built from literal sources, for the controls that need a planted duplicate.
 *
 * A missing file throws rather than reading as empty: a control whose own typo made a
 * sheet silently sourceless would assert over a graph it did not describe.
 */
export function syntheticStylesheetTree(sources: ReadonlyMap<string, string>): StylesheetTree {
  const paths = [...sources.keys()];
  return {
    modulePaths: paths.filter((path) => path.endsWith(".ts") || path.endsWith(".tsx")),
    stylesheetPaths: paths.filter((path) => path.endsWith(".css")),
    read: (treeRelativePath) => {
      const treeSource = sources.get(treeRelativePath);
      if (treeSource === undefined) {
        throw new Error(`the synthetic tree holds no ${treeRelativePath}`);
      }
      return treeSource;
    },
  };
}

/**
 * The console-relative paths of one scan, in the order the tree is walked in.
 *
 * THE PATHS COME FROM THE TIER'S ONE WALK. This module used to `readdirSync` the
 * console itself, which is exactly what `architecture/source-walk-chokepoint.test.ts`
 * forbids and for exactly the reason it gives: a gate whose set is its own walk has
 * its own opinion about what counts as source, and that opinion drifts from every
 * other gate's silently. `console-source-modules.ts` owns both admissions — modules
 * through {@link consoleSourceModules}, stylesheets through {@link consoleStylesheets}
 * — and a root that moves moves in one place.
 *
 * SORTED HERE, on the raw relative path. The shared walk orders by a display path that
 * prefixes the root, which is the right order for a failure message and a different
 * order for this set; the barrel order `collectStylesheetEdges` walks in is part of
 * what an edge reports, so it is pinned to the path a tree is keyed by.
 */
function consoleRelativePaths(modules: readonly ConsoleSourceModule[]): readonly string[] {
  return modules.map((module) => module.relativePath).sort();
}

/** Read a console-relative path. Exported because a claim reads one file by name. */
export function readConsoleFile(consoleRelativePath: string): string {
  return readFileSync(join(CONSOLE_DIRECTORY, consoleRelativePath), "utf8");
}

/** The console itself, as a tree the walk can read. */
export const CONSOLE_STYLESHEET_TREE: StylesheetTree = {
  modulePaths: consoleRelativePaths(consoleSourceModules({ roots: [CONSOLE_DIRECTORY] })),
  stylesheetPaths: consoleRelativePaths(consoleStylesheets({ roots: [CONSOLE_DIRECTORY] })),
  read: readConsoleFile,
};
