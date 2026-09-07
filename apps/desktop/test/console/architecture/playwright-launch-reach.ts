// Whether a source text can start an Electron through Playwright, and whether it does.
//
// The reader behind `playwright-launch-chokepoint.test.ts`'s rule: no module
// under `apps/desktop/test/**` or `apps/desktop/src/main/**` launches Electron
// through Playwright except `test/console/electron-harness.ts`. A second launch
// site is a second browser lifetime nobody registered at the settle-time door,
// and Playwright's launch is invisible to the `spawn` chokepoint next door —
// `_electron.launch` reaches `node:child_process` inside the Playwright package,
// not inside this one, so a module that imports it reads clean there forever.
//
// Split from the suites because those are two jobs, exactly as
// `child-process-reach.ts` is split from `electron-spawn-chokepoint.test.ts`:
// deciding what a text reaches, and asserting what the tree does with the
// answer. The planted controls stay with the suites, which is what keeps every
// shape below measured against a foil rather than only against itself.
//
// TWO READINGS AND NOT ONE, because two gates ask different questions of the
// same text. `launch-args.test.ts` asks which module can REACH the launcher — the
// import is what makes a launch possible, and a module holding the binding is
// free to compose arguments nothing reads. The chokepoint asks which module IS a
// launch site — the reach together with the call — because that is the module
// that owes the settle-time registration. One home answers both; two homes would
// be two ideas of what a launcher is, drifting apart the first time a spelling
// is added to either.
//
// WHY THE REACH IS PARSED AND NOT MATCHED, and why it is not the named import
// alone. `@playwright/test`, `playwright` and `playwright-core` all publish
// `_electron` — verified against the installed 1.62.1 trees, each answering the
// same single key — so a rule keyed on one specifier names two ways around
// itself. And a NAMESPACE or DEFAULT binding of any of the three is the module
// object whole: it holds `_electron` under a name no scan can enumerate, which is
// the same posture `child-process-reach.ts` takes for `node:child_process` and
// for the same reason — the alternative is resolving property accesses through an
// alias, which is a judgment rather than a fact about the text.
//
// A TYPE-ONLY REACH IS DELIBERATELY NOT ONE. Four modules in this package import
// `Page`, `Locator`, `ElectronApplication` and `CDPSession` as types; a type
// starts no process, and banning the type import would ban reading the handle the
// harness hands out.
//
// THE CALL IS READ BY NAME rather than by resolving what it hangs off, for the
// reason every arm here is: `electron.launch(...)`, `_electron.launch(...)` and
// `playwright._electron.launch(...)` are one property named `launch`, and the
// bracketed spelling `electron["launch"](...)` is that same property written the
// way a module writes it when it means not to be read. Over-reporting is bounded
// by the conjunction — a module that calls some other `.launch(` and never
// reaches Playwright's Electron binding is not a launch site — so neither half
// has to make a judgment the other does not check.

import ts from "typescript";

import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** Every package specifier that publishes Playwright's Electron binding. */
const PLAYWRIGHT_SPECIFIERS: readonly string[] = [
  "@playwright/test",
  "playwright",
  "playwright-core",
];

/**
 * The binding names a launch is started through.
 *
 * `_electron` is what all three specifiers export today. `electron` rides beside
 * it because the alias this package's own launcher writes
 * (`import { _electron as electron }`) is the name a reader expects to see, and a
 * binding admitted under both spellings cannot read clean on a rename upstream.
 */
const ELECTRON_LAUNCHER_BINDINGS: readonly string[] = ["_electron", "electron"];

/** The loader NAMES that hand a Playwright package back whole. */
const WHOLE_MODULE_CALLEES: readonly string[] = ["require", "createRequire"];

/** The method a Playwright Electron launch is performed through. */
const LAUNCH_METHOD = "launch";

/** What one reading of a module answers about launching Electron. */
export interface PlaywrightLaunchReading {
  /** Whether the module can NAME Playwright's Electron binding. */
  readonly reachesLauncher: boolean;
  /** Whether the module calls a `.launch(` of any kind. */
  readonly callsLaunch: boolean;
  /** Whether it is a launch SITE — it can reach the launcher and it launches. */
  readonly isLaunchSite: boolean;
}

/** Whether a module specifier NAMES a package that publishes the Electron binding. */
function namesPlaywrightPackage(specifier: ts.Expression | undefined): boolean {
  return (
    specifier !== undefined &&
    ts.isStringLiteralLike(specifier) &&
    PLAYWRIGHT_SPECIFIERS.includes(specifier.text)
  );
}

/**
 * Whether an import clause puts the Electron launcher in the module's hands.
 *
 * Three arms, and only the last is a name-by-name question. A DEFAULT binding and
 * a NAMESPACE binding are the module object, which holds the launcher under a
 * name this reader would have to resolve property accesses to enumerate. A bare
 * `import "playwright";` binds nothing and is not a reach.
 */
function importClauseReachesLauncher(clause: ts.ImportClause): boolean {
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
      !element.isTypeOnly &&
      ELECTRON_LAUNCHER_BINDINGS.includes((element.propertyName ?? element.name).text),
  );
}

/**
 * Whether an export declaration hands the launcher on out of a Playwright package.
 *
 * A re-export is the same reach wearing the other keyword: it puts the binding in
 * a module that never wrote `import`, whose importer then launches with a
 * lifetime nobody registered. `export *` is the module whole; a named list is a
 * name-by-name question against the SOURCE name; a type-only export starts no
 * process; and a declaration with no specifier re-exports a local binding.
 */
function exportDeclarationReachesLauncher(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly || !namesPlaywrightPackage(node.moduleSpecifier)) {
    return false;
  }
  const clause = node.exportClause;
  if (clause === undefined || ts.isNamespaceExport(clause)) {
    return true;
  }
  return clause.elements.some(
    (element) =>
      !element.isTypeOnly &&
      ELECTRON_LAUNCHER_BINDINGS.includes((element.propertyName ?? element.name).text),
  );
}

/**
 * Whether an import-equals declaration binds a Playwright package.
 *
 * TypeScript's own CommonJS binding form, and a WHOLE-MODULE reach by
 * construction. A type-only binding starts no process, and a module reference
 * that is an ENTITY NAME names no module at all.
 */
function importEqualsReachesLauncher(node: ts.ImportEqualsDeclaration): boolean {
  if (node.isTypeOnly) {
    return false;
  }
  const reference = node.moduleReference;
  return ts.isExternalModuleReference(reference) && namesPlaywrightPackage(reference.expression);
}

/** Whether a callee NAMES one of the whole-module loaders. */
function isWholeModuleLoader(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) {
    return WHOLE_MODULE_CALLEES.includes(callee.text);
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return WHOLE_MODULE_CALLEES.includes(callee.name.text);
  }
  return (
    ts.isElementAccessExpression(callee) &&
    ts.isStringLiteralLike(callee.argumentExpression) &&
    WHOLE_MODULE_CALLEES.includes(callee.argumentExpression.text)
  );
}

/** Whether a call expression loads a Playwright package whole. */
function callLoadsPlaywright(node: ts.CallExpression): boolean {
  if (!namesPlaywrightPackage(node.arguments[0])) {
    return false;
  }
  const callee = node.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword || isWholeModuleLoader(callee)) {
    return true;
  }
  // `createRequire(import.meta.url)("playwright")` — the callee is itself the
  // call that produced the loader.
  return ts.isCallExpression(callee) && isWholeModuleLoader(callee.expression);
}

/** Whether a call expression invokes a member named `launch`. */
function callsLaunchMethod(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text === LAUNCH_METHOD;
  }
  return (
    ts.isElementAccessExpression(callee) &&
    ts.isStringLiteralLike(callee.argumentExpression) &&
    callee.argumentExpression.text === LAUNCH_METHOD
  );
}

/**
 * What `source` does about launching Electron through Playwright.
 *
 * One walk for both readings, because a caller that wanted them separately would
 * parse the same text twice and the gates that ask both would pay for it over
 * every module in the package.
 *
 * Decided per DECLARATION rather than by a substring, which is the discrimination
 * the rule rests on: `_electron` named in a comment, in a doc block, or inside a
 * string a gate builds its own controls out of is not a reach at all — and this
 * package has all three, including a module that carries the launcher's import
 * statement as literal text.
 */
export function readPlaywrightLaunch(source: string, fileName: string): PlaywrightLaunchReading {
  let reachesLauncher = false;
  let callsLaunch = false;
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (
      ts.isImportDeclaration(node) &&
      namesPlaywrightPackage(node.moduleSpecifier) &&
      node.importClause !== undefined &&
      importClauseReachesLauncher(node.importClause)
    ) {
      reachesLauncher = true;
      return;
    }
    if (ts.isImportEqualsDeclaration(node) && importEqualsReachesLauncher(node)) {
      reachesLauncher = true;
      return;
    }
    if (ts.isExportDeclaration(node) && exportDeclarationReachesLauncher(node)) {
      reachesLauncher = true;
      return;
    }
    if (!ts.isCallExpression(node)) {
      return;
    }
    if (callLoadsPlaywright(node)) {
      reachesLauncher = true;
    }
    if (callsLaunchMethod(node)) {
      callsLaunch = true;
    }
  });
  return { reachesLauncher, callsLaunch, isLaunchSite: reachesLauncher && callsLaunch };
}
