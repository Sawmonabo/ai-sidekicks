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

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { consoleSourceModules, readConsoleSource } from "../console-source-modules.js";

/**
 * The one module allowed to declare a bound.
 *
 * An allow-list of exactly one, written as a path rather than inferred, so moving
 * the home is an edit a reviewer sees.
 */
const BOUNDS_MODULE = join("core", "constants.ts");

/**
 * How this tree spells a bound in an identifier.
 *
 * Anchored at the end of the name: `PERSISTENCE_RECORD_BYTE_CAP` is a bound and
 * `DRIVER_LIST_CAPABILITIES_METHOD` is a method string that happens to contain the
 * letters. `CAP` also has to end the name rather than merely appear in it, which is
 * what keeps `CAPABILITY` out of the result.
 */
const BOUND_DECLARATION = /^export const ([A-Z0-9_]+(?:_CAP|_THRESHOLD|_LIMIT))\b/gmu;

/**
 * Every bound `source` declares, or `[]`.
 *
 * A pure function over text rather than a loop inside a test, so the negative
 * controls below can drive it with a module body whose verdict is known and prove
 * the checker bites without perturbing a real module.
 */
function declaredBoundNames(source: string): readonly string[] {
  return [...source.matchAll(BOUND_DECLARATION)].map((match) => match[1] ?? "");
}

describe("console bounds — every cap is declared in one module", () => {
  // `*.test-support.ts` is dropped here rather than in the shared walk: those
  // modules are test scaffolding, and this rule already exempts a test that has to
  // write a would-be offender in order to prove the checker bites.
  const modules = consoleSourceModules().filter((module) => !module.endsWith(".test-support.ts"));

  it("finds a console tree to scan at all", () => {
    // Without this, a wrong console directory would scan nothing and the assertion
    // below would pass over the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(modules).toContain(BOUNDS_MODULE);
  });

  it("declares no bound outside that module", () => {
    const secondHomes = modules
      .filter((module) => module !== BOUNDS_MODULE)
      .map((module) => ({
        module,
        names: declaredBoundNames(readConsoleSource(module)),
      }))
      .filter((entry) => entry.names.length > 0)
      .map((entry) => `${entry.module}: ${entry.names.join(", ")}`);
    expect(secondHomes).toStrictEqual([]);
  });

  it("negative control: the home itself declares many", () => {
    // The checker reads real files and the pattern matches real declarations.
    // Without this, a typo in the pattern would make the clean result above mean
    // nothing at all.
    const declared = declaredBoundNames(readConsoleSource(BOUNDS_MODULE));
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
    expect(declaredBoundNames(familyBoundsModule)).toStrictEqual(["CHILD_RUN_REFUSAL_VISIBLE_CAP"]);
  });

  it("negative control: it passes what is not a bound", () => {
    // The two sides of the line the header draws. A wire method string carrying the
    // letters, and a spend of a bound the home declares, are both legal anywhere.
    expect(
      declaredBoundNames(
        'export const DRIVER_LIST_CAPABILITIES_METHOD = "driver.listCapabilities";',
      ),
    ).toStrictEqual([]);
    expect(declaredBoundNames("const visible = rows.slice(0, PALETTE_RESULT_CAP);")).toStrictEqual(
      [],
    );
  });
});
