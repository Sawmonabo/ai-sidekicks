// Caps live in one module, asserted.
//
// `apps/desktop/AGENTS.md` §Config single-sourcing states it as "one value, one
// home: budgets and their unit factors in `budgets.json`, caps in
// `console/core/constants.ts` with a rationale each", and its pre-PR self-audit
// repeats it. Until this file nothing checked it, and two view families had already
// grown their own: `terminal/constants.ts` held the scrollback, WebGL, and ledger
// caps, and `browser/bounds/BudgetMeter.tsx` embedded twenty runtime ceilings in the
// component that displays them. Both were written against a sentence in
// `core/constants.ts` that licensed exactly that — which is the shape a rule takes
// when nothing enforces it, and the reason this tripwire sits beside the byte-scaling
// one rather than being another paragraph.
//
// WHAT COUNTS AS A CAP, and why the line is drawn at the NAME. A cap is a ceiling
// something is checked against, and a module that declares one says so in the
// identifier: `_CAP`, `_MAX`, `MAXIMUM_`, `_LIMIT`, `_CEILING`, `_BUDGET`,
// `_THRESHOLD`. A layout literal does not — `ALERT_GLYPH_SIZE`,
// `CONTROL_GLYPH_SIZE`, and `GEOMETRY_ROUNDING_FACTOR` are sizes and factors, not
// bounds — so the naming convention this package already enforces is what separates
// them, rather than a guess about what a number means.
//
// `THRESHOLD` IS THE SEGMENT THIS CHECKER WAS MISSING, and it was missing for a
// stated reason that turned out to be wrong: `PARTITION_FOLD_THRESHOLD` was listed
// below as a measurement rather than a bound, because a fold is about layout. It is
// not — the browser settings page checks its partition COUNT against it and renders a
// different shape past it, which is what every other entry here does, and the value
// sat in a view family with a comment asserting the opposite placement rule. So the
// segment joins the set and the constant moved to the home. `MAX` and `CAP` were
// already in the set and needed no widening; a `_THRESHOLD` numeric export under a
// view family is what this run newly reports.
//
// THE INSTRUMENT IS THE PARSER, and the three regular expressions it replaces show
// why. Each was a guess at one shape a declaration takes — `const NAME`, a key
// indented two spaces, a quoted name followed by a comma — so the set they covered
// was the intersection of three formatting habits: a `const` whose name wrapped to the
// next line, a key at three levels of nesting, an array element on its own line
// without a trailing comma, and a declaration inside a namespace were all invisible.
// And none could tell a declaration from a sentence about one, which is why the
// quoted-name pattern had a carve-out for backticks: this tree names its constants in
// prose, and the pattern was reading the prose. A declaration is a declaration
// boundary, which `apps/desktop/AGENTS.md` says to answer with the compiler.
//
// WHY THE SCOPE IS THE VIEW FAMILIES. `console/core/constants.ts` is the home, and
// the layer families between it and the views — `primitives/`, `persistence/`,
// `palette/`, `tokens/` — carry bounds of their own whose disposition is a separate
// question from this one. The view families are where a feature module invents a
// ceiling nobody audits, which is the finding this file closes. The set is READ OUT
// OF the layering config rather than listed here: `.dependency-cruiser.mjs` already
// states a view family as the complement of the layer families and the two
// composition sites, and a second list would be a second answer that drifts.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import extractDepcruiseConfig from "dependency-cruiser/config-utl/extract-depcruise-config";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  consoleRelativePaths,
  consoleSourceModules,
  readModuleNamed,
  CONSOLE_DIRECTORY,
} from "../console-source-modules.js";
import { parseSourceText } from "../typescript-source.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const CONFIG_PATH = resolve(PACKAGE_ROOT, ".dependency-cruiser.mjs");

/** Where the layering rules are anchored, which is what their patterns match against. */
const CONSOLE_ROOT = "src/renderer/src/console";

/**
 * The rule whose `from.pathNot` IS the "not a view family" set.
 *
 * `console-view-family-isolation` subtracts the layer families and the two
 * composition sites from both of its endpoints, so its exclusion list is the
 * complement that defines a view family — read rather than restated.
 */
const VIEW_FAMILY_RULE = "console-view-family-isolation";

/**
 * The one module a cap may be declared in.
 *
 * A path rather than a naming convention, so moving the home is an edit a reviewer
 * sees.
 */
const CAP_HOME_MODULE = "core/constants.ts";

/**
 * The name segments that make an identifier a bound rather than a measurement.
 *
 * Matched as whole SCREAMING_SNAKE segments, so `MAXIMUM_LIVE_DRAFT_COUNT` and
 * `PAGES_PER_RUN_MAX` are bounds while `GLYPH_VIEWBOX_SIZE` is not.
 */
const CAP_NAME_SEGMENTS: readonly string[] = [
  "CAP",
  "MAX",
  "MAXIMUM",
  "LIMIT",
  "CEILING",
  "BUDGET",
  "THRESHOLD",
];

/** A SCREAMING_SNAKE name, which is how this package spells a constant. */
const CONSTANT_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u;

function isCapName(identifier: string): boolean {
  return (
    CONSTANT_NAME_PATTERN.test(identifier) &&
    identifier.split("_").some((segment) => CAP_NAME_SEGMENTS.includes(segment))
  );
}

/**
 * Every bound `source` declares, or `[]`.
 *
 * A pure function over text rather than a loop inside a test, so the controls below
 * can drive it with strings whose verdict is known and the checker is proved to bite
 * without perturbing a real module.
 *
 * MODULE-SCOPE VARIABLE STATEMENTS, and nothing else. That is the shape the rule is
 * actually about — a ceiling given a name and a home — and the three patterns this
 * replaced reached past it in a way that decided a layering question by accident. An
 * object-literal KEY and a string literal inside a tuple are how a family names the
 * bounds it already declared somewhere: `BROWSER_BOUND_NAMES` lists twenty of them and
 * `BROWSER_BOUNDS` is keyed by the same twenty, so a checker that read either shape
 * reported a family's own bound TABLE as twenty invented ceilings — and the only
 * placement it would accept was `core/`, two layers below every reader, which the
 * layering rule and `core/constants.ts`'s own header both argue against. Reading the
 * declaration lets the table sit with its readers and still catches what the gate was
 * built for: `terminal/constants.ts`'s pool cap and the settings page's fold threshold
 * were both module-scope declarations.
 *
 * A destructuring pattern binds several names and none of them is a declaration in
 * this tree — it is how a module READS a bound — so it contributes nothing rather than
 * being unpacked into a report against the module that imports the cap.
 */
function capNamesDeclaredIn(fileName: string, source: string): readonly string[] {
  const found = new Set<string>();
  for (const statement of parseSourceText(fileName, source).statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && isCapName(declaration.name.text)) {
        found.add(declaration.name.text);
      }
    }
  }
  return [...found].sort();
}

/** The layering config's own "not a view family" patterns, as regular expressions. */
async function nonViewFamilyPatterns(): Promise<readonly RegExp[]> {
  const configuration = await extractDepcruiseConfig(CONFIG_PATH);
  const rule = configuration.forbidden?.find((candidate) => candidate.name === VIEW_FAMILY_RULE);
  const excluded = rule?.from?.pathNot;
  if (excluded === undefined) {
    // A run over an empty exclusion set would call every console module a view
    // family, which is a different test from this one and a much noisier failure.
    throw new TypeError(`${VIEW_FAMILY_RULE} declares no path exclusions to read`);
  }
  const patterns = typeof excluded === "string" ? [excluded] : excluded;
  return patterns.map((pattern) => new RegExp(pattern, "u"));
}

/**
 * Every console source module, through the tier's one walk.
 *
 * Console-relative because that is the name every message below reports and what the
 * layering patterns are anchored against; the walk's own `displayPath` carries the
 * `console/` root in front of it. The walk itself is not this file's to write:
 * `source-walk-chokepoint.test.ts` fails a gate that reaches renderer source through
 * a `readdirSync` of its own, because five private walks are five slightly different
 * ideas of what counts as source and the difference is invisible until one of them
 * scans a file the others do not.
 */
const CONSOLE_MODULES = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });

/** What the checker is asked, for one console-relative module. */
function capNamesIn(module: string): readonly string[] {
  return capNamesDeclaredIn(module, readModuleNamed(CONSOLE_MODULES, `console/${module}`));
}

describe("cap-constant-home — a bound is declared in one module", () => {
  const modules = consoleRelativePaths(CONSOLE_MODULES);

  it("finds a console tree to scan, and the home inside it", () => {
    // Without this, a wrong CONSOLE_DIRECTORY would scan nothing and every
    // assertion below would pass over the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(modules).toContain(CAP_HOME_MODULE);
  });

  it("reads the view-family set out of the layering config", async () => {
    // The set is the complement the layering rule already states, so this asserts
    // that it was actually read: a config whose exclusions stopped matching would
    // otherwise silently widen or empty the scope below.
    const patterns = await nonViewFamilyPatterns();
    expect(patterns.length).toBeGreaterThan(0);
    const viewFamilyModules = await viewFamilyModulesAmong(modules);
    expect(viewFamilyModules.some((module) => module.startsWith("terminal/"))).toBe(true);
    expect(viewFamilyModules.some((module) => module.startsWith("browser/"))).toBe(true);
    expect(viewFamilyModules).not.toContain(CAP_HOME_MODULE);
  });

  it("no view family declares one of its own", async () => {
    const offenders = (await viewFamilyModulesAmong(modules))
      .map((module) => ({ module, caps: capNamesIn(module) }))
      .filter((entry) => entry.caps.length > 0)
      .map((entry) => `${entry.module}: ${entry.caps.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the checker bites on both shapes that were moved", () => {
    // The real declarations, verbatim, from the two modules the finding named. The
    // clean result above means nothing unless the predicate recognises them.
    expect(
      capNamesDeclaredIn("terminal.ts", "export const TERMINAL_WEBGL_POOL_CAP = 12;"),
    ).toStrictEqual(["TERMINAL_WEBGL_POOL_CAP"]);
    // The second shape, and the one the widened segment set exists for: the browser
    // settings page's fold threshold, verbatim as it stood in that view family.
    expect(capNamesDeclaredIn("page.tsx", "const PARTITION_FOLD_THRESHOLD = 10;")).toStrictEqual([
      "PARTITION_FOLD_THRESHOLD",
    ]);
  });

  it("negative control: naming a declared bound is not declaring one", () => {
    // The narrowing, as a case, and the reason the browser's bounds block could move
    // out of `core/`. A family's own table is keyed by the names it already declared
    // in one tuple; a checker that counted a key or a tuple member reported that table
    // as twenty invented ceilings and would accept only a home two layers below every
    // reader.
    expect(
      capNamesDeclaredIn(
        "browser-bounds.ts",
        'const bounds = {\n  PAGES_PER_RUN_MAX: scalarBound(\n    8,\n    "pages",\n  ),\n};',
      ),
    ).toStrictEqual([]);
    expect(
      capNamesDeclaredIn("browser-bounds.ts", 'const names = ["SNAPSHOT_TEXT_MAX"];'),
    ).toStrictEqual([]);
    // And the real module, so the claim is about the tree and not only the predicate.
    expect(capNamesIn("browser/bounds/browser-bounds.ts")).toStrictEqual([]);
  });

  it("negative control: a layout literal and a measurement are not bounds", () => {
    // The other side of the line the header draws. A predicate that flagged every
    // SCREAMING_SNAKE number would empty the view families of legitimate sizes and
    // would be turned off rather than obeyed.
    expect(capNamesDeclaredIn("sizes.ts", "const ALERT_GLYPH_SIZE = 12;")).toStrictEqual([]);
    expect(capNamesDeclaredIn("sizes.ts", "const GEOMETRY_ROUNDING_FACTOR = 100;")).toStrictEqual(
      [],
    );
    expect(capNamesDeclaredIn("sizes.ts", "const MINIMUM_VISIBLE_EDGE_PX = 1;")).toStrictEqual([]);
    expect(capNamesDeclaredIn("sizes.ts", "const SCROLL_ANCHOR_OFFSET_PX = 24;")).toStrictEqual([]);
  });

  it("negative control: prose naming a bound is not a declaration", () => {
    // What the three patterns could not tell apart, and the reason one of them had a
    // backtick carve-out: every module in this tree names its constants in a doc
    // comment, and a reader that counted those would report the explanation.
    expect(
      capNamesDeclaredIn(
        "reader.ts",
        "// Checked against `SNAPSHOT_TEXT_MAX`, which lives in the home.\nconst x = 1;",
      ),
    ).toStrictEqual([]);
    expect(
      capNamesDeclaredIn("reader.ts", "/** Reads PAGES_PER_RUN_MAX. */\nconst x = 1;"),
    ).toStrictEqual([]);
  });

  it("negative control: an import of a bound is not a declaration of one", () => {
    // The failure direction that matters most here: every view family READS the caps
    // it is checked against, so a predicate that counted a reference would report the
    // whole console and be turned off rather than obeyed.
    expect(
      capNamesDeclaredIn(
        "consumer.ts",
        'import { SNAPSHOT_TEXT_MAX } from "../core/constants.js";\nconst ok = n < SNAPSHOT_TEXT_MAX;',
      ),
    ).toStrictEqual([]);
  });

  it("negative control: the parse finds a declaration the patterns could not", () => {
    // The other direction, and the reason this is a rewrite rather than a tidy: a name
    // that wrapped past its `const` carried no `const NAME` anywhere, so the pattern
    // read the module as clean.
    expect(
      capNamesDeclaredIn("wrapped.ts", "export const\n  TERMINAL_SCROLLBACK_CAP = 5000;"),
    ).toStrictEqual(["TERMINAL_SCROLLBACK_CAP"]);
    // And a `let`, which the pattern did not consider a declaration at all.
    expect(capNamesDeclaredIn("mutable.ts", "let VIEWS_MAX = 8;")).toStrictEqual(["VIEWS_MAX"]);
  });

  it("negative control: the home itself is full of them", async () => {
    // The scope is what excuses `core/constants.ts`, not the predicate — so the home
    // must trip the checker, or the clean result above would be a checker that
    // recognises nothing.
    expect(capNamesIn(CAP_HOME_MODULE).length).toBeGreaterThan(10);
    expect(await viewFamilyModulesAmong([CAP_HOME_MODULE])).toStrictEqual([]);
  });
});

async function viewFamilyModulesAmong(modules: readonly string[]): Promise<readonly string[]> {
  const patterns = await nonViewFamilyPatterns();
  return modules.filter((module) => {
    const anchoredPath = `${CONSOLE_ROOT}/${module}`;
    return !patterns.some((pattern) => pattern.test(anchoredPath));
  });
}
