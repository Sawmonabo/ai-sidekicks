// Which names a module HOLDS, read from its parsed source.
//
// The budget registry's `measuredBy` used to be checked with `existsSync` and
// nothing else, and a path that exists says nothing about what the file does:
// two rows named `architecture/launch-deadline.test.ts` for bounds that file
// never drives — it compares registry figures with imported constants, while the
// suites that hold `FrameWitness` and `BoundedCleanup` are their own files. So a
// row now names the symbol its harness must hold, and this module answers whether
// the harness holds it.
//
// WHY THE PARSER AND NOT A PATTERN
//
// It was a pattern first, anchored at the start of a line, and the anchor was
// argued to be enough because a commented-out import opens with `//` or ` *`. It
// was not: the clause pattern ran from an `import` keyword forward to the next
// `from` ANYWHERE in the file, so a side-effect `import "./setup.js";` followed
// by a comment saying `FrameWitness from ...` reported `FrameWitness` as a
// binding of a harness that never imports it. That is precisely the false green
// the `measuredBy` gate replaced `existsSync` to remove — a budget re-pointed at
// a file that merely mentions its subject, passing.
//
// A declaration boundary is the one thing a regular expression cannot see, and
// every question here is about one. `typescript` is the toolchain's own compiler,
// already resolved in this workspace, so the answer this module gives is the
// answer the compiler gives.
//
// TOP LEVEL, DELIBERATELY
//
// A declaration is counted when it is the module's own — a statement of the
// source file — and not when it is a local inside some function body. What a row
// claims is that the harness OBTAINS its subject: it imports the class it drives,
// or declares the measurer it runs. A name bound three scopes down is that
// scope's, and counting it would let a row point at a file whose only mention of
// its subject is a local variable that happens to share the name.

import ts from "typescript";

import { parseSourceText } from "../typescript-source.js";

/** Every name an import clause binds — default, namespace, and named members. */
function collectImportedBindings(importClause: ts.ImportClause, bindings: Set<string>): void {
  if (importClause.name !== undefined) {
    bindings.add(importClause.name.text);
  }
  const namedBindings = importClause.namedBindings;
  if (namedBindings === undefined) {
    return;
  }
  if (ts.isNamespaceImport(namedBindings)) {
    bindings.add(namedBindings.name.text);
    return;
  }
  for (const element of namedBindings.elements) {
    // Both halves of a rename. Either is a defensible thing for a row to name:
    // the local name is what the file uses, and the exported name is what the
    // module it came from calls the subject.
    bindings.add(element.name.text);
    if (element.propertyName !== undefined) {
      bindings.add(element.propertyName.text);
    }
  }
}

/**
 * Every name a binding name introduces, destructuring included.
 *
 * `const { measure } = harness;` binds `measure` as surely as `const measure =`
 * does, and a rule that saw only the identifier form would refuse an honest row
 * for a spelling that makes no difference to what the file holds.
 */
function collectBoundNames(bindingName: ts.BindingName, bindings: Set<string>): void {
  if (ts.isIdentifier(bindingName)) {
    bindings.add(bindingName.text);
    return;
  }
  for (const element of bindingName.elements) {
    if (ts.isBindingElement(element)) {
      collectBoundNames(element.name, bindings);
    }
  }
}

/** The name a top-level statement declares, if it declares one. */
function collectDeclaredBindings(statement: ts.Statement, bindings: Set<string>): void {
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      collectBoundNames(declaration.name, bindings);
    }
    return;
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    // A default-exported function or class may be anonymous, which declares no
    // name at all — the one arm of this set where the name is optional.
    if (statement.name !== undefined) {
      bindings.add(statement.name.text);
    }
  }
}

/**
 * Every name `sourceText` declares or imports.
 *
 * Both halves are needed by real rows: a test harness IMPORTS the class it
 * drives, while a measuring script DECLARES the measurer it runs — and a rule
 * that admitted only one of those would refuse a row that is perfectly honest.
 */
export function bindingsHeldBy(sourceText: string): ReadonlySet<string> {
  const bindings = new Set<string>();
  const sourceFile = parseSourceText("module-bindings-subject.ts", sourceText);
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause !== undefined) {
        collectImportedBindings(statement.importClause, bindings);
      }
      continue;
    }
    collectDeclaredBindings(statement, bindings);
  }
  return bindings;
}
