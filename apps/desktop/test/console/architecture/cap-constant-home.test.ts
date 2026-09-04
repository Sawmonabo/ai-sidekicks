// Caps live in one module, asserted.
//
// `apps/desktop/AGENTS.md` §Config single-sourcing states it as "one value, one
// home: budgets and their unit factors in `budgets.json`, caps in
// `console/core/constants.ts` with a rationale each", and its pre-PR self-audit
// repeats it. Until this file nothing checked it, and two view families had already
// grown their own: `terminal/constants.ts` held the scrollback, WebGL, and ledger
// caps, and `browser/BudgetMeter.tsx` embedded twenty runtime ceilings in the
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
// WHY THE SCOPE IS THE VIEW FAMILIES. `console/core/constants.ts` is the home, and
// the layer families between it and the views — `primitives/`, `persistence/`,
// `palette/`, `tokens/` — carry bounds of their own whose disposition is a separate
// question from this one. The view families are where a feature module invents a
// ceiling nobody audits, which is the finding this file closes. The set is READ OUT
// OF the layering config rather than listed here: `.dependency-cruiser.mjs` already
// states a view family as the complement of the layer families and the two
// composition sites, and a second list would be a second answer that drifts.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import extractDepcruiseConfig from "dependency-cruiser/config-utl/extract-depcruise-config";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const CONFIG_PATH = resolve(PACKAGE_ROOT, ".dependency-cruiser.mjs");
const CONSOLE_DIRECTORY = resolve(PACKAGE_ROOT, "src", "renderer", "src", "console");

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
const CAP_HOME_MODULE = join("core", "constants.ts");

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

/** A `const` declaration, and an object-literal key — the two ways a bound is written. */
const DECLARED_NAME_PATTERN = /(?:^|\s)(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\b/gmu;
const OBJECT_KEY_PATTERN = /^\s{2,}([A-Z][A-Z0-9_]*)\s*:/gmu;
/**
 * The closed-set tuple form, where the names are string literals rather than keys.
 *
 * Quote characters only, and a trailing comma or bracket: a BACKTICKED name is prose
 * — every module in this tree names its constants that way in a doc comment — and
 * matching one reported `lease-model.ts` for a bound it imports.
 */
const QUOTED_NAME_PATTERN = /["']([A-Z][A-Z0-9_]{2,})["']\s*[,\]]/gmu;

function isCapName(identifier: string): boolean {
  return identifier.split("_").some((segment) => CAP_NAME_SEGMENTS.includes(segment));
}

/**
 * Every bound `source` declares, or `[]`.
 *
 * A pure function over text rather than a loop inside a test, so the controls below
 * can drive it with strings whose verdict is known and the checker is proved to bite
 * without perturbing a real module.
 */
function capNamesDeclaredIn(source: string): readonly string[] {
  const found = new Set<string>();
  for (const pattern of [DECLARED_NAME_PATTERN, OBJECT_KEY_PATTERN, QUOTED_NAME_PATTERN]) {
    for (const match of source.matchAll(pattern)) {
      const identifier = match[1];
      if (identifier !== undefined && isCapName(identifier)) {
        found.add(identifier);
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

function consoleSourceModules(): readonly string[] {
  return readdirSync(CONSOLE_DIRECTORY, { recursive: true, encoding: "utf8" })
    .filter(
      (entry) =>
        (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
        !entry.endsWith(".test.ts") &&
        !entry.endsWith(".test.tsx") &&
        !entry.endsWith(".test-support.ts") &&
        !entry.endsWith(".test-support.tsx") &&
        !entry.endsWith(".d.ts"),
    )
    .sort();
}

describe("cap-constant-home — a bound is declared in one module", () => {
  const modules = consoleSourceModules();

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
      .map((module) => ({ module, caps: capNamesDeclaredIn(readConsoleSource(module)) }))
      .filter((entry) => entry.caps.length > 0)
      .map((entry) => `${entry.module}: ${entry.caps.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the checker bites on both shapes that were moved", () => {
    // The real declarations, verbatim, from the two modules the finding named. The
    // clean result above means nothing unless the predicate recognises them.
    expect(capNamesDeclaredIn("export const TERMINAL_WEBGL_POOL_CAP = 12;")).toStrictEqual([
      "TERMINAL_WEBGL_POOL_CAP",
    ]);
    expect(
      capNamesDeclaredIn('  PAGES_PER_RUN_MAX: scalarBound(\n    8,\n    "pages",\n  ),'),
    ).toStrictEqual(["PAGES_PER_RUN_MAX"]);
    expect(capNamesDeclaredIn('  "SNAPSHOT_TEXT_MAX",')).toStrictEqual(["SNAPSHOT_TEXT_MAX"]);
    // The third shape, and the one the widened segment set exists for: the browser
    // settings page's fold threshold, verbatim as it stood in that view family.
    expect(capNamesDeclaredIn("const PARTITION_FOLD_THRESHOLD = 10;")).toStrictEqual([
      "PARTITION_FOLD_THRESHOLD",
    ]);
  });

  it("negative control: a layout literal and a measurement are not bounds", () => {
    // The other side of the line the header draws. A predicate that flagged every
    // SCREAMING_SNAKE number would empty the view families of legitimate sizes and
    // would be turned off rather than obeyed.
    expect(capNamesDeclaredIn("const ALERT_GLYPH_SIZE = 12;")).toStrictEqual([]);
    expect(capNamesDeclaredIn("const GEOMETRY_ROUNDING_FACTOR = 100;")).toStrictEqual([]);
    expect(capNamesDeclaredIn("const MINIMUM_VISIBLE_EDGE_PX = 1;")).toStrictEqual([]);
    expect(capNamesDeclaredIn("const SCROLL_ANCHOR_OFFSET_PX = 24;")).toStrictEqual([]);
  });

  it("negative control: the home itself is full of them", async () => {
    // The scope is what excuses `core/constants.ts`, not the predicate — so the home
    // must trip the checker, or the clean result above would be a checker that
    // recognises nothing.
    expect(capNamesDeclaredIn(readConsoleSource(CAP_HOME_MODULE)).length).toBeGreaterThan(10);
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

function readConsoleSource(module: string): string {
  return readFileSync(join(CONSOLE_DIRECTORY, module), "utf8");
}
