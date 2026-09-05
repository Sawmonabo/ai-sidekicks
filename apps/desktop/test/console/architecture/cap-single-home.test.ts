// One home for every cap, asserted rather than asked for.
//
// `apps/desktop/AGENTS.md` says "One value, one home: budgets and their unit factors
// in `budgets.json`, caps in `console/core/constants.ts` with a rationale each." That
// rule had no mechanism, and four view families each grew their own bounds module —
// so the answer to "what caps does this console carry" depended on which of five
// files an audit opened, and the modules were not even named alike: three said
// `constants` and one said `bounds`.
//
// WHICH IS WHY THIS SCANS EVERY MODULE AND NOT EVERY `constants.ts`. A rule scoped to
// a filename is a rule a filename evades, and `sessions/bounds.ts` is the proof that
// one already had. The subject is every console source module except the one home,
// and what it looks for is the EXPORTED NAME: a bound announces itself in its
// identifier, and the three suffixes below are how this tree spells one.
//
// Names, not values, and that line is deliberate. A module may hold `slice(0, 2)` or
// a layout literal and this says nothing about either — the review rule covers those
// and a text scan cannot. What it does cover is the thing that actually happened
// here: a family declaring a named, rationale-carrying bound of its own, which is the
// second home the invariant forbids and the only shape a cap audit misses.
//
// Test files are excluded: a case that plants a would-be offender has to write one.
//
// A NAME IS A DECLARATION QUESTION, SO THE PARSER ANSWERS IT. This scanned for
// `/^export const ([A-Z0-9_]+(?:_CAP|_THRESHOLD|_LIMIT))\b/gmu`, and four shapes each
// shipped a second bounds home past it with the gate green: `const X = 12;` followed
// by `export { X };`, which never writes `export const`; `export const { X } = BOUNDS;`,
// where the binding is a pattern and not an identifier; a declaration Prettier wraps
// after `export const`, where the name is on the next line; and any bound spelled
// with a suffix the alternation did not carry. The first three are declaration-boundary
// misreadings of exactly the class `test/console/typescript-source.ts` exists to end,
// and the fourth is why the vocabulary is now one exported tuple in
// `bound-suffixes.ts` rather than an alternation inside a pattern inside this file.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import { parseSourceText } from "../typescript-source.js";
import { BOUND_NAME_SUFFIXES } from "./bound-suffixes.js";

/**
 * The one module allowed to declare a bound.
 *
 * An allow-list of exactly one, written as a path rather than inferred, so moving
 * the home is an edit a reviewer sees.
 */
const BOUNDS_MODULE = ["console", "core", "constants.ts"].join("/");

/**
 * Whether one binding name is a bound, by the vocabulary and the casing together.
 *
 * The casing half is what separates a constant from a local: a `capThreshold` inside
 * a function body ends in the letters and is not a declaration of a bound.
 */
function isBoundName(name: string): boolean {
  return (
    /^[A-Z][A-Z0-9_]*$/u.test(name) && BOUND_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

/** Every name one variable declaration binds, destructuring patterns included. */
function boundNamesOf(name: ts.BindingName, into: string[]): void {
  if (ts.isIdentifier(name)) {
    into.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      boundNamesOf(element.name, into);
    }
  }
}

/**
 * Every bound `source` declares AND exports, in declaration order, or `[]`.
 *
 * A pure function over text rather than a loop inside a test, so the negative
 * controls below can drive it with a module body whose verdict is known and prove
 * the checker bites without perturbing a real module.
 *
 * TWO WAYS TO EXPORT ONE DECLARATION, and both are the same claim about the module:
 * the `export` modifier on the statement, and a later local `export { … }` clause
 * naming it. A clause carrying a module specifier is skipped — that republishes
 * another module's name and declares nothing — and a name a clause exports that this
 * module does not DECLARE as a variable is skipped with it, because an
 * `import`-then-`export` pair is a re-export of the home's own bound rather than a
 * second home for it.
 */
function declaredBoundNames(fileName: string, source: string): readonly string[] {
  const parsed = parseSourceText(fileName, source);
  const exportedByModifier = new Map<string, boolean>();
  const exportedByClause = new Set<string>();
  for (const statement of parsed.statements) {
    if (ts.isVariableStatement(statement)) {
      const exported = (ts.getModifiers(statement) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
      const names: string[] = [];
      for (const declaration of statement.declarationList.declarations) {
        boundNamesOf(declaration.name, names);
      }
      for (const name of names) {
        exportedByModifier.set(name, (exportedByModifier.get(name) ?? false) || exported);
      }
      continue;
    }
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier !== undefined) {
      continue;
    }
    const { exportClause } = statement;
    if (exportClause !== undefined && ts.isNamedExports(exportClause)) {
      for (const element of exportClause.elements) {
        exportedByClause.add(element.propertyName?.text ?? element.name.text);
      }
    }
  }
  return [...exportedByModifier]
    .filter(([name, exported]) => exported || exportedByClause.has(name))
    .map(([name]) => name)
    .filter(isBoundName);
}

describe("console bounds — every cap is declared in one module", () => {
  // The shared walk already drops co-located tests and their support modules, which
  // is the exemption this rule needs: a case that plants a would-be offender has to
  // be able to write one.
  const modules = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });

  it("finds a console tree to scan at all", () => {
    // Without this, a wrong console directory would scan nothing and the assertion
    // below would pass over the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(modules.map((module) => module.displayPath)).toContain(BOUNDS_MODULE);
  });

  it("declares no bound outside that module", () => {
    const secondHomes = modules
      .filter((module) => module.displayPath !== BOUNDS_MODULE)
      .map((module) => ({
        module,
        names: declaredBoundNames(module.displayPath, readConsoleSourceModule(module)),
      }))
      .filter((entry) => entry.names.length > 0)
      .map((entry) => `${entry.module.displayPath}: ${entry.names.join(", ")}`);
    expect(secondHomes).toStrictEqual([]);
  });

  it("negative control: the home itself declares many", () => {
    // The checker reads real files and the pattern matches real declarations.
    // Without this, a typo in the pattern would make the clean result above mean
    // nothing at all.
    const home = moduleNamed(modules, BOUNDS_MODULE, "the console's bounds module");
    const declared = declaredBoundNames(home.displayPath, readConsoleSourceModule(home));
    expect(declared.length).toBeGreaterThan(10);
    expect(declared).toContain("PALETTE_RESULT_CAP");
  });

  it("negative control: it catches the second home this rule was written for", () => {
    // The body a view family's own bounds module had, reduced to the declaration.
    // Run against the predicate rather than against a planted file, so the case
    // states what would fail without writing a violation into the tree.
    const familyBoundsModule = [
      "/** Child-run refusal rows rendered before the group scrolls. */",
      "export const CHILD_RUN_REFUSAL_VISIBLE_CAP = 12;",
    ].join("\n");
    expect(declaredBoundNames("family/bounds.ts", familyBoundsModule)).toStrictEqual([
      "CHILD_RUN_REFUSAL_VISIBLE_CAP",
    ]);
  });

  it("negative control: it catches the three shapes the pattern read past", () => {
    // Each of these declares and exports a bound; each of them the regular expression
    // reported as no bound at all, because none of them writes `export const <NAME>`
    // on one line. They are the whole reason the reader is a parse.
    expect(
      declaredBoundNames(
        "clause.ts",
        [
          "const CHILD_RUN_REFUSAL_VISIBLE_CAP = 12;",
          "export { CHILD_RUN_REFUSAL_VISIBLE_CAP };",
        ].join("\n"),
      ),
    ).toStrictEqual(["CHILD_RUN_REFUSAL_VISIBLE_CAP"]);
    expect(
      declaredBoundNames("pattern.ts", "export const { SETTLED_INVITE_VISIBLE_CAP } = BOUNDS;"),
    ).toStrictEqual(["SETTLED_INVITE_VISIBLE_CAP"]);
    expect(
      declaredBoundNames(
        "wrapped.ts",
        ["export const", "  ATTENTION_ROWS_MAX: number =", "  computeRowBudget();"].join("\n"),
      ),
    ).toStrictEqual(["ATTENTION_ROWS_MAX"]);
  });

  it("negative control: it passes what is not a bound", () => {
    // The two sides of the line the header draws. A wire method string carrying the
    // letters, and a spend of a bound the home declares, are both legal anywhere.
    expect(
      declaredBoundNames(
        "method.ts",
        'export const DRIVER_LIST_CAPABILITIES_METHOD = "driver.listCapabilities";',
      ),
    ).toStrictEqual([]);
    expect(
      declaredBoundNames("spend.ts", "const visible = rows.slice(0, PALETTE_RESULT_CAP);"),
    ).toStrictEqual([]);
    // A module-private bound is this rule's own exemption and always was: what the
    // invariant governs is a SECOND HOME, which is a bound a second module publishes.
    expect(declaredBoundNames("private.ts", "const LOCAL_ROW_CAP = 3;")).toStrictEqual([]);
    // And a re-export of the home's own bound is not a declaration of one.
    expect(
      declaredBoundNames(
        "reexport.ts",
        [
          'import { PALETTE_RESULT_CAP } from "../core/constants.js";',
          "export { PALETTE_RESULT_CAP };",
        ].join("\n"),
      ),
    ).toStrictEqual([]);
  });
});
