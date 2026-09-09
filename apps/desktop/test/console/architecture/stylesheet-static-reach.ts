// Which console modules the initial import graph can reach, and which sheets nobody on
// it can use.
//
// THE QUESTION THIS ANSWERS. A stylesheet may be moved off a family door and onto a lazy
// chunk root only if nothing on the initial graph needs it — otherwise the surface that
// still paints from the door renders undressed until somebody opens an unrelated pane.
// "Nothing needs it" is not a fact about directory layout, and it is not a fact about the
// sheet: it is a fact about the module GRAPH, which is why it is computed here rather
// than asserted in a header.
//
// EMITTED STATIC EDGES ONLY FOR THAT QUESTION, WHICH IS THE BUNDLER'S OWN RULE. A module
// reachable both statically and dynamically is assigned to the static chunk, so
// `reachableFrom` is the closure over the `import`/`export … from` declarations that
// survive type erasure, and it stops at every `import()`. There is no conservative
// direction to lean in there: the offence is reported when the walk finds NO user, so a
// reach set that is too WIDE silently admits the eager-CSS regression that gate exists to
// reject, and one that is too narrow fails a sheet that is placed correctly. The set has
// to be exact, which is why `moduleStaticImportSpecifiers` reads the parser's own
// type-only flags.
//
// AND A SECOND REACH SET FOR A SECOND QUESTION. `loadableFrom` takes the `import()` edges
// as well, because "can this sheet ever reach the document" is not the eager question
// asked twice: a sheet whose only importer sits behind a loader is placed CORRECTLY by
// the rule above and is still an orphan if nothing on the graph ever loads that chunk.
// The two sets are named apart and cached apart rather than parameterised into one,
// because a caller that reaches for the wrong one gets a wrong answer in silence.
//
// USE IS READ AS A TOKEN MATCH, deliberately coarse. A class name reaches its component
// as a string — composed, conditional, spread through a variant helper — so there is no
// reference to resolve. Tokenising the module and intersecting with the sheet's declared
// class names over-reports (a comment naming a class counts) and never under-reports,
// and over-reporting is the direction that refuses a move rather than admitting a bad
// one.
//
// WHICH CLASSES A SHEET DECLARES IS NOT READ HERE. `stylesheet-selectors.ts` owns that
// grammar for both censuses that ask it, and the header there says why a second copy of
// it is a defect rather than a duplication: this gate reports on finding NO user, so a
// parser that read one class fewer than the collision census reads would turn an offence
// off with nothing anywhere disagreeing out loud.

import { posix } from "node:path";

import type { StylesheetTree } from "./stylesheet-edge-graph.js";
import { resolveStylesheet } from "./stylesheet-edge-graph.js";
import { declaredClassNames } from "./stylesheet-selectors.js";
import { dynamicImportSpecifiers, moduleStaticImportSpecifiers } from "./stylesheet-specifiers.js";

/** Test-file paths, which are part of no bundle and must not join a reach set. */
function isTestModule(modulePath: string): boolean {
  return (
    modulePath.endsWith(".test.ts") ||
    modulePath.endsWith(".test.tsx") ||
    modulePath.includes(".test-support.")
  );
}

/**
 * One reading of the tree, memoised, so a census of 66 sheets is not 66 parses each.
 *
 * WHY A CLASS. Both readings this holds — a module's static specifiers and its
 * identifier tokens — are pure functions of a file's text, and the census asks for the
 * same file's answer once per sheet whose door reaches it. Recomputing was measured at
 * 12s for one gate, which under this tier's five-project concurrency starved the
 * neighbouring suites into hook timeouts: a correct gate that makes four others red is
 * not a correct gate. The cache is per instance rather than at module scope, on the
 * package's rule, so a planted tree and the console never share one.
 */
export class StylesheetReachIndex {
  readonly #tree: StylesheetTree;
  readonly #modulePaths: ReadonlySet<string>;
  readonly #specifiers = new Map<string, readonly string[]>();
  readonly #dynamicSpecifiers = new Map<string, readonly string[]>();
  readonly #tokens = new Map<string, ReadonlySet<string>>();
  readonly #reachFrom = new Map<string, ReadonlySet<string>>();
  readonly #loadableFrom = new Map<string, ReadonlySet<string>>();

  public constructor(tree: StylesheetTree) {
    this.#tree = tree;
    this.#modulePaths = new Set(tree.modulePaths);
  }

  /**
   * Every console module reachable from `entry` without crossing an `import()`.
   *
   * ROOTED AT THE IMPORTER RATHER THAN AT THE BUNDLE'S ENTRY, which is what makes the
   * answer local and exact. A global reach set would have to name where the renderer
   * enters the console, and it enters in more places than a list can be trusted to hold
   * — `src/renderer/src/shell/index.ts` imports a console door, and a list that forgot
   * it reported that door's sheets as unusable by anything, which is the wrong answer in
   * the direction that demands a move. Asked of the sheet's own importer, the question
   * needs no such list: whatever else reaches that door, the door reaches these modules.
   */
  public reachableFrom(entry: string): ReadonlySet<string> {
    return this.#closureFrom(entry, this.#reachFrom, (modulePath) =>
      this.#specifiersOf(modulePath),
    );
  }

  /**
   * Every module `entry` can reach AT ALL — the static closure and every chunk behind it.
   *
   * THE OTHER QUESTION, AND DELIBERATELY NOT A WIDENING OF THE ONE ABOVE. That set is
   * what the bundler puts in one chunk, and a claim about eager CSS is wrong the instant
   * it counts a loader's edge. This set is what the document can ever hold: a sheet no
   * member of it imports is rules that reach no window in any state the application can
   * be driven into, which is a different defect and needs the `import()` edges the other
   * set exists to stop at. Both are kept, under two names and two caches, because the
   * failure a caller gets from the wrong one is silent in both directions.
   */
  public loadableFrom(entry: string): ReadonlySet<string> {
    return this.#closureFrom(entry, this.#loadableFrom, (modulePath) => [
      ...this.#specifiersOf(modulePath),
      ...this.#dynamicSpecifiersOf(modulePath),
    ]);
  }

  /** The walk both reach sets are, memoised into whichever cache the caller owns. */
  #closureFrom(
    entry: string,
    cache: Map<string, ReadonlySet<string>>,
    specifiersOf: (modulePath: string) => readonly string[],
  ): ReadonlySet<string> {
    const cached = cache.get(entry);
    if (cached !== undefined) {
      return cached;
    }
    const reached = new Set<string>();
    const pending = this.#modulePaths.has(entry) ? [entry] : [];
    while (pending.length > 0) {
      const modulePath = pending.pop();
      if (modulePath === undefined || reached.has(modulePath)) {
        continue;
      }
      reached.add(modulePath);
      for (const specifier of specifiersOf(modulePath)) {
        const resolved = this.#resolveModule(modulePath, specifier);
        if (resolved !== undefined) {
          pending.push(resolved);
        }
      }
    }
    cache.set(entry, reached);
    return reached;
  }

  /**
   * Whether any module reachable from `entry` could render against `classNames`.
   *
   * Use is read as a TOKEN MATCH, deliberately coarse. A class name reaches its
   * component as a string — composed, conditional, spread through a variant helper — so
   * there is no reference to resolve. Tokenising and intersecting over-reports (a comment
   * naming a class counts) and never under-reports, and over-reporting is the direction
   * that refuses to move a sheet rather than admitting a move that breaks a surface.
   */
  public anyReachableModuleUses(entry: string, classNames: ReadonlySet<string>): boolean {
    for (const modulePath of this.reachableFrom(entry)) {
      if (this.moduleUses(modulePath, classNames)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether ONE module could render against `classNames`.
   *
   * The grain underneath {@link anyReachableModuleUses}, published because the second
   * claim this file answers asks it of a module rather than of a closure: a sheet that
   * arrives on a chunk is misplaced when a module ALREADY on the initial graph names one
   * of its classes, and walking that module's own closure to find out would re-ask the
   * question of modules the set already holds. One tokeniser, two questions.
   *
   * Test modules are subtracted here rather than at either call site, so both readings
   * agree about what is not part of a bundle.
   */
  public moduleUses(modulePath: string, classNames: ReadonlySet<string>): boolean {
    if (isTestModule(modulePath)) {
      return false;
    }
    for (const className of classNames) {
      if (this.#tokensOf(modulePath).has(className)) {
        return true;
      }
    }
    return false;
  }

  #specifiersOf(modulePath: string): readonly string[] {
    const cached = this.#specifiers.get(modulePath);
    if (cached !== undefined) {
      return cached;
    }
    const read = moduleStaticImportSpecifiers(modulePath, this.#tree.read(modulePath));
    this.#specifiers.set(modulePath, read);
    return read;
  }

  #dynamicSpecifiersOf(modulePath: string): readonly string[] {
    const cached = this.#dynamicSpecifiers.get(modulePath);
    if (cached !== undefined) {
      return cached;
    }
    const read = dynamicImportSpecifiers(modulePath, this.#tree.read(modulePath));
    this.#dynamicSpecifiers.set(modulePath, read);
    return read;
  }

  #tokensOf(modulePath: string): ReadonlySet<string> {
    const cached = this.#tokens.get(modulePath);
    if (cached !== undefined) {
      return cached;
    }
    const tokens = new Set<string>();
    for (const token of this.#tree.read(modulePath).matchAll(IDENTIFIER_TOKEN)) {
      tokens.add(token[0]);
    }
    this.#tokens.set(modulePath, tokens);
    return tokens;
  }

  /**
   * A specifier resolved to a module in the tree, or `undefined`.
   *
   * The console writes ESM specifiers — `./x.js`, `../y/index.js` — so the `.js` is
   * rewritten to both source extensions, and a bare directory is tried as its barrel.
   *
   * The barrel candidates are composed in `path.posix`, because a tree path carries `/`
   * on every host and a candidate spelled the host's way matches nothing in the set.
   */
  #resolveModule(importerPath: string, specifier: string): string | undefined {
    const base = resolveStylesheet(importerPath, specifier);
    if (base === undefined) {
      return undefined;
    }
    const stem = base.endsWith(".js") ? base.slice(0, -".js".length) : base;
    for (const candidate of [
      `${stem}.ts`,
      `${stem}.tsx`,
      base,
      posix.join(stem, "index.ts"),
      posix.join(stem, "index.tsx"),
    ]) {
      if (this.#modulePaths.has(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }
}

const IDENTIFIER_TOKEN = /[A-Za-z_][\w-]*/gu;

/**
 * Every console module the composition sites reach without crossing an `import()`.
 *
 * THE EAGER GRAPH, DERIVED RATHER THAN LISTED. A composition site is a module the tree
 * holds directly under `console/`: `console-root-is-composition-only` in
 * `.dependency-cruiser.mjs` fails any module in that position that imports into the
 * console and is not enumerated in `COMPOSITION_ROOT_FILES`, so the set of roots that
 * can contribute to the initial graph IS the set of paths with no separator in them.
 * The walk behind `modulePaths` has already dropped declaration files, co-located tests
 * and their support modules, so nothing else has to be subtracted.
 *
 * Hoisted here on its second reader rather than left in the gate that had it first: the
 * two claims that ask this question — nothing behind a loader is on the eager graph, and
 * nothing on the eager graph is undressed — are two readings of one walk, and a copy of
 * the derivation is how they would come to disagree about which roots count.
 */
export function eagerlyReachedModules(
  tree: StylesheetTree,
  index: StylesheetReachIndex,
): ReadonlySet<string> {
  const reached = new Set<string>();
  for (const root of tree.modulePaths.filter((modulePath) => !modulePath.includes("/"))) {
    for (const modulePath of index.reachableFrom(root)) {
      reached.add(modulePath);
    }
  }
  return reached;
}

/** One stylesheet sitting on the wrong side of a chunk boundary, and why. */
export interface DeferredSheetOffence {
  readonly stylesheetPath: string;
  /** The module that imports it — a family door, in every offence. */
  readonly importer: string;
}

/** One sheet a surface on the initial graph renders against and cannot have yet. */
export interface UndressedEagerReaderOffence {
  readonly stylesheetPath: string;
  /** The chunk root the sheet enters through, so it arrives only with that chunk. */
  readonly importer: string;
  /** A module on the eager graph naming a class no eagerly-arriving sheet declares. */
  readonly eagerReader: string;
}

/**
 * Every class name the sheets that arrive with the INITIAL graph declare.
 *
 * WHY THE CLAIM SUBTRACTS THIS RATHER THAN ASKING ABOUT ONE SHEET AT A TIME. What a
 * person sees is a surface painted with no rules, and a class some eagerly-arriving
 * sheet already declares is not that: the surface is dressed, whatever else restates it
 * later. The case is in the tree — `browser/pane/pane.css` carries
 * `.meridian-browser-chrome .meridian-browser-action`, a restatement scoped to a chrome
 * bar the settings page has no ancestor of, while the button's own rules live in
 * `browser/controls.css`. Asked per sheet, the pane sheet answers "an eager module names
 * a class I declare" and is true and useless; asked against what arrives eagerly, it
 * answers nothing at all and the sheet that actually owed the rules is the one reported.
 *
 * Keyed on the same reach walk the reader question uses, so both halves of the comparison
 * speak about one graph: a sheet is dressing when the module it enters through is on the
 * eager graph, which is the exact complement of entering through a chunk root that graph
 * never loads.
 */
function eagerlyDeclaredClassNames(
  tree: StylesheetTree,
  importerOf: (stylesheetPath: string) => string | undefined,
  eagerlyReached: ReadonlySet<string>,
): ReadonlySet<string> {
  const declared = new Set<string>();
  for (const stylesheetPath of tree.stylesheetPaths) {
    const importer = importerOf(stylesheetPath);
    if (importer === undefined || !eagerlyReached.has(importer)) {
      continue;
    }
    for (const className of declaredClassNames(tree.read(stylesheetPath))) {
      declared.add(className);
    }
  }
  return declared;
}

/**
 * Sheets that enter through a chunk root while the INITIAL graph renders against them.
 *
 * THE CONVERSE OF {@link deferredSheetOffences}, and the other half of one placement
 * rule rather than a second rule. That predicate asks whether a sheet at a door has a
 * reader; this one asks whether a sheet behind a boundary has a reader on the wrong side
 * of it. Both are answered off the same reach index and the same class-name grammar, so
 * a sheet cannot be reported misplaced by one and correctly placed by the other for
 * having been measured differently.
 *
 * The failure it names is one a person sees and no other gate reports: a surface the
 * settings route paints statically, whose rules travel on a chunk that route never
 * loads, renders unstyled until somebody opens an unrelated pane — and then silently
 * starts working, which is what makes it so hard to catch by hand.
 *
 * ONE OFFENCE PER SHEET, naming the first eager reader found. The remedy is a property
 * of the SHEET — it moves to the barrel of the directory that owns it — so a report per
 * reader would be one fix listed many times.
 */
export function undressedEagerReaderOffences(
  tree: StylesheetTree,
  importerOf: (stylesheetPath: string) => string | undefined,
  isChunkRoot: (modulePath: string) => boolean,
): readonly UndressedEagerReaderOffence[] {
  const index = new StylesheetReachIndex(tree);
  const eagerlyReached = eagerlyReachedModules(tree, index);
  const alreadyDressed = eagerlyDeclaredClassNames(tree, importerOf, eagerlyReached);
  const offences: UndressedEagerReaderOffence[] = [];
  for (const stylesheetPath of tree.stylesheetPaths) {
    const importer = importerOf(stylesheetPath);
    if (importer === undefined || !isChunkRoot(importer)) {
      continue;
    }
    const undressedClassNames = new Set(
      [...declaredClassNames(tree.read(stylesheetPath))].filter(
        (className) => !alreadyDressed.has(className),
      ),
    );
    if (undressedClassNames.size === 0) {
      continue;
    }
    const eagerReader = firstEagerReaderOf(index, eagerlyReached, undressedClassNames);
    if (eagerReader !== undefined) {
      offences.push({ stylesheetPath, importer, eagerReader });
    }
  }
  return offences;
}

/**
 * The first module on the eager graph naming any of `classNames`, in tree order.
 *
 * Use is read as a TOKEN MATCH, the same deliberately coarse reading
 * {@link StylesheetReachIndex.anyReachableModuleUses} makes — but the direction the
 * coarseness cuts is REVERSED here, and that is worth stating rather than inheriting.
 * There the predicate reports on finding no user, so over-reporting a user refused a
 * move; here it reports on finding one, so over-reporting a user fails a sheet that is
 * placed correctly. Both are the safe side of their own claim: neither admits a surface
 * that paints without its rules.
 */
function firstEagerReaderOf(
  index: StylesheetReachIndex,
  eagerlyReached: ReadonlySet<string>,
  classNames: ReadonlySet<string>,
): string | undefined {
  for (const modulePath of eagerlyReached) {
    if (index.moduleUses(modulePath, classNames)) {
      return modulePath;
    }
  }
  return undefined;
}

/**
 * Sheets a family door imports that nothing on that door's own static graph can use.
 *
 * THE RULE, STATED ONCE. A sheet whose only readers sit behind an `import()` is paid for
 * by every session and rendered against by none of them until a pane opens, so it
 * belongs at the chunk root that reaches its readers. The exception is the cascade:
 * `collidesAcrossFamilies` names sheets declaring a class some OTHER family also
 * declares, and deferring one of those changes when it lands relative to that family's
 * sheet, which silently restyles a surface in a family whose files were never touched.
 * Those are exempt here and stay on the door until the collision itself is settled.
 */
export function deferredSheetOffences(
  tree: StylesheetTree,
  importerOf: (stylesheetPath: string) => string | undefined,
  collidesAcrossFamilies: (stylesheetPath: string) => boolean,
  isChunkRoot: (modulePath: string) => boolean,
): readonly DeferredSheetOffence[] {
  const index = new StylesheetReachIndex(tree);
  const offences: DeferredSheetOffence[] = [];
  for (const stylesheetPath of tree.stylesheetPaths) {
    const importer = importerOf(stylesheetPath);
    if (importer === undefined || isChunkRoot(importer)) {
      continue;
    }
    if (collidesAcrossFamilies(stylesheetPath)) {
      continue;
    }
    const classNames = declaredClassNames(tree.read(stylesheetPath));
    if (classNames.size === 0 || index.anyReachableModuleUses(importer, classNames)) {
      continue;
    }
    offences.push({ stylesheetPath, importer });
  }
  return offences;
}
