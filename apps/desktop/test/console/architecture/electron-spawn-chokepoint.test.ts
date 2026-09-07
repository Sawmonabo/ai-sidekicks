// One module spawns Electron, and this is what says so.
//
// The rule: no file under `apps/desktop/test/**` reaches the asynchronous
// `spawn` of `node:child_process` except `test/helpers/electron-child.ts`. A
// second spawn site is a second child lifetime nobody owns, which is exactly how
// four Electron processes carrying this package's own `sidekicks-gc-test-*`
// profile prefix were found reparented to init long after their run had finished.
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
// One residual is accepted and named rather than papered over: a loader parked
// in a variable first (`const load = require; load("node:child_process")`) is
// not read, for the same reason property accesses are not resolved through an
// alias — that is binding resolution, which is a judgment. What is closed is
// every spelling a module actually writes.
//
// So the reach is read out of the PARSE, through this tier's one parse home. A
// namespace, a default binding, a dynamic import and a `require` are each a
// WHOLE-MODULE reach: they put every export of `node:child_process` in the
// module's hands under a name no scan can enumerate, and `spawn` is one of them.
// Reporting them is the same posture `source-walk-census.ts` already takes for
// a namespace import of `node:fs`, and for the same reason — the alternative is
// resolving property accesses through an alias, which is a judgment again.
//
// `spawnSync` is deliberately untouched. It cannot orphan anything — it returns
// only once its child is gone — and four modules under `test/` use it. Narrowing
// the ban to the asynchronous binding is what keeps this rule about lifetimes
// rather than about a substring. A type-only reach is untouched for the same
// class of reason: a type starts no process.
//
// Playwright's `_electron.launch` is not a `spawn` and is not banned here. It
// has its own chokepoint (`withLaunchedConsole` is the one way in, and
// `launchConsole` is not exported) and it reaches the SAME settle-time door,
// `disposeWhenTestFinishes`, which the last case below asserts rather than
// assumes.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { forEachDescendant, parseSourceText } from "../typescript-source.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = path.resolve(HERE, "..", "..");

/** The one module allowed to reach `spawn`, relative to `test/`. */
const SPAWN_CHOKEPOINT = path.join("helpers", "electron-child.ts");

/** The launcher that must reach the same settle-time door, relative to `test/`. */
const PLAYWRIGHT_LAUNCHER = path.join("console", "electron-harness.ts");

/**
 * This file, which carries every planted control below as literal source text.
 *
 * NOT SUBTRACTED FROM THE SCAN, and that is a property of the reader rather than
 * a decision made here: a planted shape inside a string literal is a string
 * literal to the parser, so this file's own controls cannot make it look like a
 * spawner. The regex this replaced could not tell the two apart and needed an
 * exemption for exactly that reason — and an exemption is a hole that a real
 * second spawner can one day fall into. The case below asserts the difference.
 */
const CONTROL_FIXTURE_FILE = path.join(
  "console",
  "architecture",
  "electron-spawn-chokepoint.test.ts",
);

/** Both specifiers that resolve to the same module. */
const CHILD_PROCESS_SPECIFIERS: readonly string[] = ["node:child_process", "child_process"];

/** The binding whose lifetime this package must own. */
const ASYNCHRONOUS_SPAWN = "spawn";

/** The call forms that hand a module object back whole. */
const WHOLE_MODULE_CALLEES: readonly string[] = ["require", "createRequire"];

function isChildProcessSpecifier(text: string): boolean {
  return CHILD_PROCESS_SPECIFIERS.includes(text);
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
  const specifier = node.moduleSpecifier;
  if (specifier === undefined || !ts.isStringLiteralLike(specifier)) {
    return false;
  }
  if (!isChildProcessSpecifier(specifier.text)) return false;
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
 * Whether a call expression loads `node:child_process` whole.
 *
 * `import("node:child_process")`, `require("node:child_process")`, and the
 * `createRequire(...)("node:child_process")` form this package's own
 * `scripts/materialize-electron.ts` uses — the third because a rule that knew
 * the first two would name the third as the way around itself.
 */
function callLoadsChildProcess(node: ts.CallExpression): boolean {
  const specifier = node.arguments[0];
  if (specifier === undefined || !ts.isStringLiteralLike(specifier)) {
    return false;
  }
  if (!isChildProcessSpecifier(specifier.text)) {
    return false;
  }
  const callee = node.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) {
    return true;
  }
  if (ts.isIdentifier(callee)) {
    return WHOLE_MODULE_CALLEES.includes(callee.text);
  }
  // `createRequire(import.meta.url)("node:child_process")` — the callee is
  // itself the call that produced the loader.
  return (
    ts.isCallExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    WHOLE_MODULE_CALLEES.includes(callee.expression.text)
  );
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
function reachesAsynchronousSpawn(source: string, fileName: string): boolean {
  let reaches = false;
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (reaches) {
      return;
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isChildProcessSpecifier(node.moduleSpecifier.text) &&
      node.importClause !== undefined &&
      importClauseReachesSpawn(node.importClause)
    ) {
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

/**
 * The reader this file replaced, kept as the foil the controls are measured against.
 *
 * Not a second implementation of the rule — it is the SUPERSEDED one, and its
 * only use is the case that shows what it could not see. A control that merely
 * asserts the new reader fires would pass over a reader that fires on
 * everything; a control that also asserts the old one did NOT fire is the one
 * that says the walk bought something.
 */
const NAMED_IMPORT_CLAUSE = /import\s*\{([^}]*)\}\s*from\s*["']node:child_process["']/g;

function supersededNamedImportReader(source: string): boolean {
  for (const clause of source.matchAll(NAMED_IMPORT_CLAUSE)) {
    const braceBody = clause[1];
    if (braceBody === undefined) continue;
    const specifiers = braceBody.split(",").map((specifier) => specifier.trim());
    if (
      specifiers.some((specifier) => specifier === "spawn" || specifier.startsWith("spawn as "))
    ) {
      return true;
    }
  }
  return false;
}

/** Every `.ts` / `.tsx` file under `test/`, as paths relative to `test/`. */
function testSourceFiles(directory: string = TEST_ROOT): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collected.push(...testSourceFiles(absolute));
      continue;
    }
    if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      collected.push(path.relative(TEST_ROOT, absolute));
    }
  }
  return collected;
}

function readTestSource(relativePath: string): string {
  return readFileSync(path.join(TEST_ROOT, relativePath), "utf8");
}

function fileReachesSpawn(relativePath: string): boolean {
  return reachesAsynchronousSpawn(readTestSource(relativePath), relativePath);
}

/**
 * The reaches the named-import reader could not see, each one a real spelling.
 *
 * The first is the ordinary CommonJS-interop idiom; the second is what a module
 * writes when it needs the loader inside a function; the third is the same
 * module under the prefix-less specifier; the fourth defers the load; the fifth
 * is the escape a rule that knew only `require` would leave open; the last five are
 * the export keyword doing an import's work.
 */
const REACHES_INVISIBLE_TO_THE_REGEX: readonly string[] = [
  'import * as childProcess from "node:child_process";\nchildProcess.spawn("electron");',
  'const { spawn } = require("node:child_process");',
  'import { spawn } from "child_process";',
  'const childProcess = await import("node:child_process");',
  'const childProcess = createRequire(import.meta.url)("node:child_process");',
  'import childProcess from "node:child_process";',
  // The re-export arm: none writes `import`, so the superseded reader saw nothing.
  'export { spawn } from "node:child_process";',
  'export { spawn as launch } from "node:child_process";',
  'export * from "node:child_process";',
  'export * as childProcess from "child_process";',
];

/** Shapes that name the module or the word and start no process. */
const REACHES_THAT_ARE_NOT_ONE: readonly string[] = [
  'import { spawnSync } from "node:child_process";',
  'import { spawnSync, type ChildProcess } from "node:child_process";',
  'import type { spawn } from "node:child_process";',
  'import { type spawn } from "node:child_process";',
  'import "node:child_process";',
  'export type { spawn } from "node:child_process";',
  'export { type spawn } from "node:child_process";',
  'export { spawnSync } from "node:child_process";',
  'export { spawn } from "./electron-child.js";',
  "const spawn = launcher.spawn.bind(launcher);",
  'const advice = "import { spawn } from \\"node:child_process\\"";',
];

describe("every Electron spawn under test/ goes through one owner", () => {
  const files = testSourceFiles();

  it("finds a test tree to read at all", () => {
    // The zero-match failure this tier requires of every tripwire: a rule that
    // scanned nothing would report clean forever.
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(SPAWN_CHOKEPOINT);
    expect(files).toContain(CONTROL_FIXTURE_FILE);
  });

  it("names exactly one module that reaches the asynchronous spawn", () => {
    const spawners = files.filter(fileReachesSpawn);
    expect(
      spawners,
      "a second module under test/ reaches `spawn` — route it through " +
        "`spawnManagedElectronChild` so the child's lifetime is bound to the test",
    ).toStrictEqual([SPAWN_CHOKEPOINT]);
  });

  it("scans this file too, because a quoted reach is not a reach", () => {
    // Why the case above needs no exemption list. Every control in this file is
    // literal source text, and the parser sees literals; the regex could not,
    // which is why it needed this file subtracted — and a subtraction is a hole
    // a real second spawner can fall into. The foil firing here is the proof
    // that the controls really are the text they claim to be.
    expect(fileReachesSpawn(CONTROL_FIXTURE_FILE)).toBe(false);
    expect(
      supersededNamedImportReader(readTestSource(CONTROL_FIXTURE_FILE)),
      "the planted controls are no longer literal import text, so they prove nothing",
    ).toBe(true);
  });

  it("catches every spelling the named-import reader reported clean", () => {
    for (const planted of REACHES_INVISIBLE_TO_THE_REGEX) {
      expect(reachesAsynchronousSpawn(planted, "planted.ts"), planted).toBe(true);
    }
    // The other half of the same control: each of these was invisible to the
    // reader this replaced, so the walk is what closed them and not the tree
    // happening to be clean.
    for (const planted of REACHES_INVISIBLE_TO_THE_REGEX) {
      expect(supersededNamedImportReader(planted), planted).toBe(false);
    }
  });

  it("fails on a planted named import, so the clean result above is not vacuous", () => {
    expect(reachesAsynchronousSpawn('import { spawn } from "node:child_process";', "p.ts")).toBe(
      true,
    );
    expect(
      reachesAsynchronousSpawn('import { spawn, spawnSync } from "node:child_process";', "p.ts"),
    ).toBe(true);
    expect(
      reachesAsynchronousSpawn(
        'import {\n  spawnSync,\n  spawn,\n  type ChildProcess,\n} from "node:child_process";',
        "p.ts",
      ),
    ).toBe(true);
    expect(
      reachesAsynchronousSpawn('import { spawn as launch } from "node:child_process";', "p.ts"),
    ).toBe(true);
  });

  it("still clears the forms that cannot start a process", () => {
    for (const planted of REACHES_THAT_ARE_NOT_ONE) {
      expect(reachesAsynchronousSpawn(planted, "planted.ts"), planted).toBe(false);
    }
  });

  it("holds the Playwright launcher to the same settle-time door", () => {
    // It spawns nothing here, so the rule above cannot reach it — and it has the
    // identical hole: its close runs in the body's own settlement, and vitest's
    // per-test timeout does not run that.
    const launcher = readTestSource(PLAYWRIGHT_LAUNCHER);
    expect(
      launcher.includes("disposeWhenTestFinishes"),
      "`withLaunchedConsole` no longer registers a settle-time close — a tier that " +
        "overruns its own budget will leave a real Electron and its profile behind",
    ).toBe(true);
  });
});
