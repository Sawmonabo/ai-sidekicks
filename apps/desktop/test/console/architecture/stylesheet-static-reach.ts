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
// EMITTED STATIC EDGES ONLY, WHICH IS THE BUNDLER'S OWN RULE. A module reachable both
// statically and dynamically is assigned to the static chunk, so the reach set is the
// closure over the `import`/`export … from` declarations that survive type erasure, and
// it stops at every `import()`. There is no conservative direction to lean in here: the
// offence is reported when the walk finds NO user, so a reach set that is too WIDE
// silently admits the eager-CSS regression this gate exists to reject, and one that is
// too narrow fails a sheet that is placed correctly. The set has to be exact, which is
// why `moduleStaticImportSpecifiers` reads the parser's own type-only flags.
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

import { sep } from "node:path";

import type { StylesheetTree } from "./stylesheet-edge-graph.js";
import { resolveStylesheet } from "./stylesheet-edge-graph.js";
import { declaredClassNames } from "./stylesheet-selectors.js";
import { moduleStaticImportSpecifiers } from "./stylesheet-specifiers.js";

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
  readonly #tokens = new Map<string, ReadonlySet<string>>();
  readonly #reachFrom = new Map<string, ReadonlySet<string>>();

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
    const cached = this.#reachFrom.get(entry);
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
      for (const specifier of this.#specifiersOf(modulePath)) {
        const resolved = this.#resolveModule(modulePath, specifier);
        if (resolved !== undefined) {
          pending.push(resolved);
        }
      }
    }
    this.#reachFrom.set(entry, reached);
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
      if (isTestModule(modulePath)) {
        continue;
      }
      for (const className of classNames) {
        if (this.#tokensOf(modulePath).has(className)) {
          return true;
        }
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
      [stem, "index.ts"].join(sep),
      [stem, "index.tsx"].join(sep),
    ]) {
      if (this.#modulePaths.has(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }
}

const IDENTIFIER_TOKEN = /[A-Za-z_][\w-]*/gu;

/** One stylesheet sitting on the wrong side of a chunk boundary, and why. */
export interface DeferredSheetOffence {
  readonly stylesheetPath: string;
  /** The module that imports it — a family door, in every offence. */
  readonly importer: string;
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
