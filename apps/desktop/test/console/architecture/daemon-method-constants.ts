// The method constant one module EXPORTS and another IMPORTS, keyed by both halves.
//
// A NAME IS NOT AN IDENTITY, WHICH IS THE SECOND HALF OF THE SAME LESSON.
// `daemon-method-bindings.ts` refuses to resolve a name to a declaration the call does
// not see, and then hands an imported binding here — where the first reading keyed
// every `const NAME = "<method>"` in the tree by its BARE NAME and folded them
// together. That answers correctly while exactly one module in the whole console binds
// a given spelling, and wrongly the moment two do, in both directions at once:
//
//   • A CONSUMER GETS SOMEBODY ELSE'S CONSTANT. `agents/agent-wire.ts` can export a
//     `METHOD` this parse cannot reduce — a value composed at run time, a re-export —
//     and be skipped, while an unrelated module's PRIVATE `const METHOD = "session.join"`
//     is the one entry the index holds under that spelling. The import resolves to it.
//     The call then classifies as a record, from a module it never imported, and the
//     record rule reports it for carrying the signal its real read needs.
//   • A CORRECT CONSUMER GETS NOTHING. Two modules binding one spelling to two methods
//     made the index ambiguous and the fold answered the empty set, so a call naming
//     the unambiguous one of them was reported as naming no registered method at all.
//
// SO THE KEY IS THE PAIR, and the pair is what an import already carries: the module
// its specifier names, and the name that specifier came from. A binding is indexed
// under the module that DECLARES it and asked for under the module the importer
// NAMES, so a second module's constant of the same spelling is a different key rather
// than a collision, and neither of the two failures above has a shape left to take.
//
// AND ONLY AN EXPORT IS INDEXED, because only an export is reachable. A module-private
// `const` is invisible to every other module by the language's own rule, and indexing
// one made this parse claim a reach the program does not have. That is also why the
// ambiguity refusal the fold needed is gone rather than kept: (module, exported name)
// admits one declaration by construction, so there is nothing left to be ambiguous
// between.
//
// AND ONLY A `const` IS REDUCED, through the same reduction the scope chain uses, because
// this index has the writable-binding hole in its own shape too: an
// `export let METHOD = "session.join"` the exporting module later writes reaches every
// importer as whatever it holds at the call, and an index that recorded its initializer
// would classify a read as a record across a module boundary. The rule is stated once in
// `daemon-method-literals.ts` and consumed here, so the two readers cannot disagree about
// what a declaration holds.
//
// AND THE SPECIFIER IS RESOLVED BY `daemon-module-resolution.ts`, which is the one join
// this tier makes and is no longer this module's own. A name the resolved module does
// not export answers nothing, exactly as an unresolvable specifier does, which the
// census reads as an unresolved method and reports on its own reading: a call whose
// method this parse cannot reach is a defect whatever it was handed.

import ts from "typescript";

import { parseSourceText } from "../typescript-source.js";
import { variableDeclarationBinding } from "./daemon-method-literals.js";
import { moduleCandidates } from "./daemon-module-resolution.js";

/**
 * Every module's exported method constants, keyed by the module that exports them.
 *
 * ONLY REGISTERED METHODS ARE INDEXED, and only what an IMPORT reached is asked of
 * this index at all. A console module exports constants for many things; admitting
 * them all would let an unrelated string be resolved as a method name on the strength
 * of an import that happens to point at the right module.
 */
export class DaemonMethodConstantIndex {
  readonly #methodsByModule = new Map<string, ReadonlyMap<string, string>>();
  readonly #registeredMethods: readonly string[];

  /**
   * @param registeredMethods Every method the daemon-reply registry binds a schema for.
   */
  public constructor(registeredMethods: readonly string[]) {
    this.#registeredMethods = registeredMethods;
  }

  /**
   * Fold one module's `export const NAME = "<method>"` bindings in, under its own path.
   *
   * @param displayPath What the scan names this module by — the same spelling a
   *   consumer's specifier resolves to, which is what makes the two halves meet.
   */
  public add(source: string, displayPath: string): void {
    const exported = new Map<string, string>();
    for (const statement of parseSourceText(displayPath, source).statements) {
      if (!ts.isVariableStatement(statement) || !isExported(statement)) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        const bound = this.#registeredMethodIn(statement.declarationList, declaration);
        if (ts.isIdentifier(declaration.name) && bound !== undefined) {
          exported.set(declaration.name.text, bound);
        }
      }
    }
    this.#methodsByModule.set(displayPath, exported);
  }

  /**
   * The method one import names, or none where this parse cannot reach one.
   *
   * @param importerPath The module the import is written in, which the specifier is
   *   relative to.
   * @param moduleSpecifier The specifier as that import spells it.
   * @param exportedName The name the specifier came from, not the local spelling.
   */
  public resolve(
    importerPath: string,
    moduleSpecifier: string,
    exportedName: string,
  ): readonly string[] {
    for (const candidate of moduleCandidates(importerPath, moduleSpecifier)) {
      const method = this.#methodsByModule.get(candidate)?.get(exportedName);
      if (method !== undefined) {
        return [method];
      }
    }
    return [];
  }

  /** The registered method a declaration binds, or `undefined` for everything else. */
  #registeredMethodIn(
    declarationList: ts.VariableDeclarationList,
    declaration: ts.VariableDeclaration,
  ): string | undefined {
    const bound = variableDeclarationBinding(declarationList, declaration);
    if (bound.kind !== "literals") {
      return undefined;
    }
    const [method] = bound.literals;
    return method !== undefined && this.#registeredMethods.includes(method) ? method : undefined;
  }
}

/** Whether a statement carries the `export` keyword, which is what makes it reachable. */
function isExported(statement: ts.VariableStatement): boolean {
  return (
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  );
}
