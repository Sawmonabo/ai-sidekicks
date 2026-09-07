// The stylesheet edge graph: who imports which sheet, counted rather than collapsed.
//
// A MODEL WITH ITS OWN MODULE because it has its own test. The claims about the
// console live in `stylesheet-edges.test.ts`; what lives here is the walk they are
// made with, and the walk is a pure function over a TREE rather than over the disk so
// that its own test can drive it with a graph whose verdict is known. Planting a
// duplicate edge to prove the counter bites would otherwise mean a test writing into
// the console's source.
//
// AND OWNERSHIP IS COMPUTED, NOT ASSUMED. An earlier revision asked only whether a
// sheet was reached from A barrel, which is true of a sheet pulled into a family sheet
// from a sub-directory that has a door of its own — the one shape `apps/desktop/
// AGENTS.md` names as forbidden, and the one a family had actually grown. So the walk
// resolves each sheet's OWNER by climbing to the nearest `index.ts` at or above it and
// holds every inbound edge to that, which needs no list of exceptions and follows a
// directory the day it grows a door.
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

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  consoleStylesheets,
  type ConsoleSourceModule,
} from "../console-source-modules.js";
import {
  moduleStylesheetImports,
  dynamicImportSpecifiers,
  stylesheetAtImports,
  type StylesheetSpecifierReader,
} from "./stylesheet-specifiers.js";

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

/** The four ways a tree's stylesheet edges can be wrong, each with its edges. */
export interface StylesheetEdgeOffences {
  readonly unreached: readonly string[];
  readonly duplicatePaths: readonly string[];
  readonly duplicateBarrels: readonly string[];
  /** Sheets reached from a barrel that is not the one owning their directory. */
  readonly misowned: readonly string[];
}

/**
 * Whether a tree-relative module path is a BARREL: a directory's `index.ts`.
 *
 * One of the two door shapes, and the only one a path alone can answer. The other is
 * the chunk root below, which is a fact about the graph rather than about the name.
 */
export function isOwningBarrel(modulePath: string): boolean {
  return modulePath.endsWith(`${sep}index.ts`);
}

/**
 * Every module some other module reaches by a dynamic `import()`: a chunk root.
 *
 * A DOOR, ON THE SAME REASONING AS A BARREL. What a stylesheet edge needs is a module
 * that is the single way into the code the sheet paints, and a chunk root is exactly
 * that — the loader's `import()` is the only static reference to it, so a sheet it
 * imports arrives on that chunk and on no other. `seats/lazy-body.ts` makes this the
 * console's registration form for a body that is not on the flagship first paint, and
 * such a body is the entry to its own directory in the same way a barrel is.
 *
 * DERIVED FROM THE TREE AND NEVER FROM A NAME. A predicate keyed on a `-body` suffix
 * would admit a module nothing lazily imports, which is the reach the rule forbids; the
 * question the rule asks is whether the importer is the way in, and only the graph
 * answers that.
 *
 * The specifier is written as `./x-body.js` — the console's ESM specifier form — so it
 * is resolved against both source extensions and kept only where the tree holds it.
 */
export function lazyChunkRoots(tree: StylesheetTree): ReadonlySet<string> {
  const modules = new Set(tree.modulePaths);
  const roots = new Set<string>();
  for (const modulePath of tree.modulePaths) {
    for (const specifier of dynamicImportSpecifiers(modulePath, tree.read(modulePath))) {
      const resolved = resolveStylesheet(modulePath, specifier);
      if (resolved === undefined) {
        continue;
      }
      for (const candidate of moduleCandidatesFor(resolved)) {
        if (modules.has(candidate)) {
          roots.add(candidate);
        }
      }
    }
  }
  return roots;
}

/** The source paths an ESM specifier could name, in the order a resolver tries them. */
function moduleCandidatesFor(resolvedSpecifier: string): readonly string[] {
  const withoutExtension = resolvedSpecifier.replace(/\.js$/u, "");
  return [`${withoutExtension}.ts`, `${withoutExtension}.tsx`, resolvedSpecifier];
}

/**
 * Which barrel OWNS a file: the nearest one at or above its own directory.
 *
 * `apps/desktop/AGENTS.md` states the rule this answers — "a stylesheet enters through
 * the barrel of the directory that OWNS it", where "a directory owns its own
 * sub-directories that carry no `index.ts` of their own" and "a directory that carries
 * a door … has an owner of its own". So ownership is a walk upward to the first barrel,
 * and it is computed rather than configured: a sub-directory that grows a barrel becomes
 * its own owner the moment the file exists, with no list here to keep in step.
 *
 * OWNERSHIP IS KEYED ON THE BARREL AND NOT ON EVERY DOOR, which is the one place the
 * two door shapes part company. A chunk root is a door — it is the single way into the
 * code behind it, which is what admits it as an IMPORTER below — but ownership has to
 * be single-valued, and a directory can carry several chunk roots: `agents/
 * agent-console/` carries one for the deck's pane and one for the auxiliary window's
 * surface. Naming a directory its own owner because it holds a chunk root would then
 * leave the family's barrel — the module that actually admits that directory into the
 * tree — reaching a sheet it no longer owned, and would report the console's existing
 * arrangement as an offence without any sheet having moved.
 *
 * `undefined` where no ancestor carries one, which the caller reports rather than
 * passes over: a sheet under no barrel at all is reached by nothing the rule admits.
 */
export function owningBarrelOf(tree: StylesheetTree, filePath: string): string | undefined {
  const barrels = new Set(tree.modulePaths.filter(isOwningBarrel));
  const segments = filePath.split(sep);
  for (let depth = segments.length - 1; depth > 0; depth -= 1) {
    const candidate = [...segments.slice(0, depth), "index.ts"].join(sep);
    if (barrels.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
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
  const chunkRoots = lazyChunkRoots(tree);
  for (const owningBarrel of tree.modulePaths.filter(
    (modulePath) => isOwningBarrel(modulePath) || chunkRoots.has(modulePath),
  )) {
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

/**
 * Whether one inbound edge is admissible for the sheet it reaches.
 *
 * TWO SHAPES AND NOT ONE, because a family's own sheet legitimately pulls in the
 * sheets of the sub-directories that family owns. A module edge is admissible when the
 * importer IS the sheet's owning barrel; every other edge is admissible when the
 * importer answers to the SAME owner, which is what makes
 * `workflows/workflows.css → definitions/definitions-browser.css` right and
 * `workflows/workflows.css → destination/workflows-destination.css` wrong the moment
 * `destination/` grows a door.
 *
 * THE SECOND CLAUSE IS ALSO WHAT ADMITS A CHUNK ROOT, and it admits it without being
 * widened: a lazily imported body sits inside its family's barrel subtree, so it
 * answers to the same owner as the sheet beside it. What keeps that from being a hole
 * is that the clause governs only WHICH sheet may be reached, while
 * `stylesheet-edges.test.ts`'s own door claim governs WHICH modules may reach one at
 * all — a non-door module in the subtree fails there, and the count below still holds
 * every sheet to a single inbound edge.
 */
function isOwnedEdge(tree: StylesheetTree, sheet: string, edge: StylesheetEdge): boolean {
  const owner = owningBarrelOf(tree, sheet);
  if (owner === undefined) {
    return false;
  }
  return edge.importer === owner || owningBarrelOf(tree, edge.importer) === owner;
}

/**
 * Whether a sheet's several importers are alternative entries to its own directory.
 *
 * THE ONE ADMITTED FAN-IN, and it is narrow on purpose. The single-edge rule exists so
 * that no sheet is pulled into a document by two different owners — one directory made
 * the reason another is styled. Two lazy chunk roots under the SAME owning barrel are
 * not two owners: they are two ways into one body, and the bundler emits the sheet once
 * into an asset whichever root pulls. `agents/agent-console/` is the live case — the
 * deck's pane and the auxiliary window's surface are independent first paints of
 * `AgentConsoleBody`, so each has to name the rules that body needs; a sheet named by
 * only one of them leaves the other window rendering undressed.
 *
 * EVERY importer must qualify, so a barrel joining two chunk roots still offends: what
 * is admitted is a fan-in whose members are all deferred entries to one directory, not
 * a sheet that happens to have a chunk root among its importers.
 *
 * AND AN ADMITTED SHEET'S OWN `@import`S INHERIT IT, which is the second clause and not
 * a widening of the first. A family sheet three sibling roots pull carries the sheets
 * that family owns at its head, and each of those is then reached once per root — same
 * importer, three edges — for a reason that is a property of the roots rather than of
 * the sheet. Without this clause the model would forbid a fanned-in family sheet from
 * carrying any `@import` at all, which is an accident of how the walk counts rather than
 * a rule anybody decided: what makes the fan-in safe is that the members are alternative
 * entries to ONE body, and a sheet that body's chrome pulls in is on exactly the same
 * asset. A BARREL among the importers still offends, at this level and at every level
 * below it, because the recursion admits only importers that are themselves admitted.
 */
function isSiblingChunkRootFanIn(
  tree: StylesheetTree,
  sheet: string,
  inbound: readonly StylesheetEdge[],
  chunkRoots: ReadonlySet<string>,
  edges: StylesheetEdgeGraph,
  // The cycle guard, and the only reason this parameter exists: two sheets that
  // `@import` each other would otherwise recur forever, and a malformed tree must fail
  // the gate rather than hang it.
  visiting: ReadonlySet<string> = new Set(),
): boolean {
  const owner = owningBarrelOf(tree, sheet);
  if (owner === undefined || visiting.has(sheet)) {
    return false;
  }
  const descended = new Set([...visiting, sheet]);
  return inbound.every((edge) => {
    if (owningBarrelOf(tree, edge.importer) !== owner) {
      return false;
    }
    if (chunkRoots.has(edge.importer)) {
      return true;
    }
    const importerInbound = edges.get(edge.importer);
    return (
      importerInbound !== undefined &&
      importerInbound.length > 0 &&
      isSiblingChunkRootFanIn(tree, edge.importer, importerInbound, chunkRoots, edges, descended)
    );
  });
}

/** The offending sheets, each reported with the edges that made it one. */
export function stylesheetEdgeOffences(
  tree: StylesheetTree,
  edges: StylesheetEdgeGraph,
): StylesheetEdgeOffences {
  const unreached: string[] = [];
  const duplicatePaths: string[] = [];
  const duplicateBarrels: string[] = [];
  const misowned: string[] = [];
  const chunkRoots = lazyChunkRoots(tree);
  for (const sheet of tree.stylesheetPaths) {
    const inbound = edges.get(sheet) ?? [];
    if (inbound.length === 0) {
      unreached.push(sheet);
      continue;
    }
    const siblingRoots = isSiblingChunkRootFanIn(tree, sheet, inbound, chunkRoots, edges);
    if (inbound.length > 1 && !siblingRoots) {
      const paths = inbound.map((edge) => `${edge.importer} → "${edge.specifier}"`).join("; ");
      duplicatePaths.push(`${sheet}: ${inbound.length} inbound edges — ${paths}`);
    }
    const owningBarrels = [...new Set(inbound.map((edge) => edge.owningBarrel))].sort();
    if (owningBarrels.length > 1 && !siblingRoots) {
      duplicateBarrels.push(`${sheet}: reached from ${owningBarrels.join(", ")}`);
    }
    // THE CLAIM THE OTHER THREE CANNOT MAKE. Reached, reached once, and reached from
    // one barrel are all true of a sheet whose owner is a different directory
    // entirely — which is the shape that puts one surface's rules on the initial
    // document for every session that never opens it.
    for (const edge of inbound.filter((candidate) => !isOwnedEdge(tree, sheet, candidate))) {
      misowned.push(
        `${sheet}: owned by ${owningBarrelOf(tree, sheet) ?? "no barrel"}, reached from ${edge.importer}`,
      );
    }
  }
  return { unreached, duplicatePaths, duplicateBarrels, misowned };
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
