// Whether a source text can NAME the asynchronous `spawn` of `node:child_process`.
//
// The reader behind `electron-spawn-chokepoint.test.ts`'s rule: no file under
// `apps/desktop/test/**` reaches that binding except `test/helpers/electron-child.ts`.
// A second spawn site is a second child lifetime nobody owns, which is exactly how
// four Electron processes carrying this package's own `sidekicks-gc-test-*` profile
// prefix were found reparented to init long after their run had finished.
//
// Split from the suite because those are two jobs: deciding what a text reaches,
// and asserting what the tree does with the answer. The planted controls stay
// with the suite, which is what keeps every shape below measured against a foil
// rather than only against itself.
//
// WHY THE REACH AND NOT THE CALL
//
// A rule keyed on the call would have to decide whether a given `spawn(...)`
// launches Electron — through a variable holding a binary path, through
// `xvfb-run` wrapping it, through a helper two files away. That is a judgment,
// and a tripwire that makes judgments is a tripwire that can be argued with. The
// reach is a fact: a module that cannot NAME `spawn` cannot start a process
// whose lifetime this package does not already own.
//
// WHY IT IS PARSED AND NOT MATCHED
//
// The first version of this rule read one shape — a braced named-import clause
// with `node:child_process` on its right — and every other way of reaching the
// same binding was invisible to it. `import * as childProcess from
// "node:child_process"` then `childProcess.spawn(...)` carries no brace body;
// `const { spawn } = require("node:child_process")` carries no `import` at all;
// so does `await import("node:child_process")`; and `"child_process"` without
// the `node:` prefix resolves to the same module and did not match the literal.
// Each of those spellings was reported clean. They are not corner cases dug out
// of a spec — the first is the ordinary CommonJS-interop idiom, and the second is
// what a module writes when it needs the loader inside a function.
//
// A RE-EXPORT is the same reach wearing the other keyword: it hands the binding to
// a module that never wrote `import`, whose importer then spawns with a lifetime
// nobody registered. So an export declaration carrying a module specifier is read
// by the same three arms as an import clause.
//
// AND ONE LOADER IS NOT AN EXPRESSION AT ALL. TypeScript's own CommonJS binding
// form, `import childProcess = require("node:child_process")`, spells `require`
// as SYNTAX: the parser builds an `ImportEqualsDeclaration` whose specifier
// hangs off an external module reference, so there is no import CLAUSE for the
// clause arm to read and no call expression for the loader arm to read, and a
// helper written this way was reported clean while it spawned. It is a
// WHOLE-MODULE reach like the namespace and default bindings beside it — the
// binding IS the module object — so it joins them rather than needing a member
// walk of its own, and the `export import …` spelling is the same node kind
// wearing a modifier, which is why one arm answers for both.
//
// A BUILTIN IS ALSO REACHED WITH NO LOADER NAME OF ITS OWN. Node 22 serves
// `process.getBuiltinModule("node:child_process")`, a whole-module load written
// with no `import`, no `require`, and no specifier any import arm ever sees — its
// callee is a property access, and a reader admitting only identifier callees
// reported such a file clean while it spawned. So the closed loader set below is
// read against the callee's NAME rather than against its shape, which takes
// `module.require(...)` in with it and adds no second list to keep in step.
//
// One residual is accepted and named rather than papered over: a loader parked
// in a variable first (`const load = require; load("node:child_process")`) is
// not read, because deciding what `load` holds is binding resolution, which is a
// judgment. Reading a property access by NAME is not that — the object it hangs
// off is never resolved, so `process.getBuiltinModule` is a fact about the text
// in the way `childProcess.spawn` is not. What is closed is every spelling a
// module actually writes.
//
// So the reach is read out of the PARSE, through this tier's one parse home. A
// namespace, a default binding, an import-equals binding, a dynamic import, a
// `require` and a builtin loader are each a WHOLE-MODULE reach: they put every export of
// `node:child_process` in the module's hands under a name no scan can enumerate,
// and `spawn` is one of them. Reporting them is the same posture
// `source-walk-census.ts` already takes for a namespace import of `node:fs`, and
// for the same reason — the alternative is resolving property accesses through
// an alias, which is a judgment again.
//
// `spawnSync` is deliberately untouched. It cannot orphan anything — it returns
// only once its child is gone — and four modules under `test/` use it. Narrowing
// the ban to the asynchronous binding is what keeps this rule about lifetimes
// rather than about a substring. A type-only reach is untouched for the same
// class of reason: a type starts no process.

import ts from "typescript";

import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** Both specifiers that resolve to the same module. */
const CHILD_PROCESS_SPECIFIERS: readonly string[] = ["node:child_process", "child_process"];

/** The binding whose lifetime this package must own. */
const ASYNCHRONOUS_SPAWN = "spawn";

/**
 * The loader NAMES that hand a module object back whole.
 *
 * One closed set for both spellings a loader is written in — bare, and as a
 * property of the object carrying it — so `require`, `createRequire`,
 * `module.require` and Node 22's `process.getBuiltinModule` are one entry each
 * rather than a shape list that has to be kept in step with itself.
 */
const WHOLE_MODULE_CALLEES: readonly string[] = ["require", "createRequire", "getBuiltinModule"];

/**
 * Whether a module specifier NAMES `node:child_process`.
 *
 * The specifier rule written once, for every syntax below, so a declaration
 * shape added to the walk inherits both spellings rather than restating either
 * — and so an absent specifier (an export declaration re-exporting a local
 * binding) and a computed one are refused in one place rather than four.
 *
 * `isStringLiteralLike` rather than `isStringLiteral` because the quoted form is
 * not the only literal one: a no-substitution template is a specifier a
 * `require` call can carry, and reading it as anything else would leave a
 * spelling open for the sake of a narrower predicate.
 */
function namesChildProcessModule(specifier: ts.Expression | undefined): boolean {
  return (
    specifier !== undefined &&
    ts.isStringLiteralLike(specifier) &&
    CHILD_PROCESS_SPECIFIERS.includes(specifier.text)
  );
}

/**
 * Whether an import clause puts `spawn` in the module's hands.
 *
 * Three arms, and only the last is a name-by-name question. A DEFAULT binding of
 * a CommonJS module is the module object under interop, and a NAMESPACE binding
 * is the module object by definition — both hold `spawn` under a name this scan
 * would have to resolve property accesses to enumerate. A bare
 * `import "node:child_process"` binds nothing and is not a reach.
 */
function importClauseReachesSpawn(clause: ts.ImportClause): boolean {
  if (clause.isTypeOnly) {
    return false;
  }
  if (clause.name !== undefined) {
    return true;
  }
  const bindings = clause.namedBindings;
  if (bindings === undefined) {
    return false;
  }
  if (ts.isNamespaceImport(bindings)) {
    return true;
  }
  return bindings.elements.some(
    (element) =>
      !element.isTypeOnly && (element.propertyName ?? element.name).text === ASYNCHRONOUS_SPAWN,
  );
}

/**
 * Whether an import-equals declaration puts `spawn` in the module's hands.
 *
 * TypeScript's own CommonJS binding form, and a WHOLE-MODULE reach by
 * construction: `import childProcess = require("node:child_process")` binds the
 * module object under one name, exactly as a namespace import does, so there is
 * no member list to walk and this arm asks no name-by-name question. It is not
 * reachable from either arm beside it — the `require` here is syntax rather than
 * a call, and the specifier hangs off an external module reference no import
 * clause carries.
 *
 * Two shapes are refused. A type-only binding starts no process, for the reason
 * every type-only arm here is refused. And a module reference that is an ENTITY
 * NAME (`import childProcess = NodeJS.ChildProcessNamespace`) is an alias for a
 * local namespace rather than a load: it names no module, so there is no
 * specifier for the rule above to key on, and resolving what the alias points at
 * is the binding resolution this module's header refuses to do.
 */
function importEqualsDeclarationReachesSpawn(node: ts.ImportEqualsDeclaration): boolean {
  if (node.isTypeOnly) {
    return false;
  }
  const reference = node.moduleReference;
  return ts.isExternalModuleReference(reference) && namesChildProcessModule(reference.expression);
}

/**
 * Whether an export declaration hands `spawn` on out of `node:child_process`.
 *
 * `export * from` and `export * as ns from` are the module whole; a named list is a
 * name-by-name question against the SOURCE name (`export { spawn as launch }`
 * re-exports `spawn`); a type-only export starts no process; and a declaration with
 * no module specifier re-exports a local binding, reaching no module at all.
 */
function exportDeclarationReachesSpawn(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) {
    return false;
  }
  if (!namesChildProcessModule(node.moduleSpecifier)) {
    return false;
  }
  const clause = node.exportClause;
  if (clause === undefined || ts.isNamespaceExport(clause)) {
    return true;
  }
  return clause.elements.some(
    (element) =>
      !element.isTypeOnly && (element.propertyName ?? element.name).text === ASYNCHRONOUS_SPAWN,
  );
}

/**
 * Whether a callee NAMES one of the whole-module loaders.
 *
 * An identifier is the bare spelling and a property access is the same loader
 * reached through the object that carries it. Neither arm resolves a binding —
 * the name is read straight off the parse, which is what keeps this a fact
 * rather than the judgment this module's header refuses to make.
 */
function isWholeModuleLoader(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) {
    return WHOLE_MODULE_CALLEES.includes(callee.text);
  }
  return ts.isPropertyAccessExpression(callee) && WHOLE_MODULE_CALLEES.includes(callee.name.text);
}

/**
 * Whether a call expression loads `node:child_process` whole.
 *
 * `import("node:child_process")`, `require("node:child_process")`,
 * `process.getBuiltinModule("node:child_process")`, and the
 * `createRequire(...)("node:child_process")` form this package's own
 * `scripts/materialize-electron.ts` uses — the last because a rule that knew the
 * others would name it as the way around itself.
 */
function callLoadsChildProcess(node: ts.CallExpression): boolean {
  if (!namesChildProcessModule(node.arguments[0])) {
    return false;
  }
  const callee = node.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) {
    return true;
  }
  if (isWholeModuleLoader(callee)) {
    return true;
  }
  // `createRequire(import.meta.url)("node:child_process")` — the callee is
  // itself the call that produced the loader.
  return ts.isCallExpression(callee) && isWholeModuleLoader(callee.expression);
}

/**
 * Whether `source` reaches the ASYNCHRONOUS `spawn` of `node:child_process`.
 *
 * Decided per DECLARATION rather than by a substring, which is the whole
 * discrimination this rule rests on: `spawnSync` contains `spawn` and is
 * deliberately allowed, a local identifier named `spawn` — a Playwright option
 * object, a property on a driver contract — is not a reach at all, and a shape
 * quoted inside a string is a string.
 */
export function reachesAsynchronousSpawn(source: string, fileName: string): boolean {
  let reaches = false;
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (reaches) {
      return;
    }
    if (
      ts.isImportDeclaration(node) &&
      namesChildProcessModule(node.moduleSpecifier) &&
      node.importClause !== undefined &&
      importClauseReachesSpawn(node.importClause)
    ) {
      reaches = true;
      return;
    }
    if (ts.isImportEqualsDeclaration(node) && importEqualsDeclarationReachesSpawn(node)) {
      reaches = true;
      return;
    }
    if (ts.isExportDeclaration(node) && exportDeclarationReachesSpawn(node)) {
      reaches = true;
      return;
    }
    if (ts.isCallExpression(node) && callLoadsChildProcess(node)) {
      reaches = true;
    }
  });
  return reaches;
}
