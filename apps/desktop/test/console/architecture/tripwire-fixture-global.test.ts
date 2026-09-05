// The guard that keeps the tripwire registry out of a release bundle.
//
// The endurance tier reads the console's tripwire registry out of a real renderer
// through a property a FIXTURE build hangs on the page. That property is a handle
// to the console's internals, and the only thing standing between it and every
// user's `globalThis` is the `define`-substituted identifier the assignment sits
// behind: the define is a literal at build time, so the guard is what makes the
// assignment dead code Rollup drops.
//
// A guard is a structural claim about source text, and this tier is where
// structural claims are checked. The bundle tier asserts the OUTCOME — that the
// property name does not appear in a release build; this asserts the MECHANISM,
// so a regression is reported as "the assignment left its guard" rather than as a
// missing string in a 1.2 MB file, and so it is caught in milliseconds without a
// build.
//
// The property NAME is not pinned here and does not need to be — the harness
// re-exports it from this same module rather than copying it, so a rename is a
// compile error in every tier that reads it. Reading source text is still the
// right instrument for the guard, because a guard's placement is not observable
// from the module's exports.

import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
} from "../console-source-modules.js";

/**
 * The module this gate reads, named the way every source-text gate in this tier names
 * one: through the shared walk, which resolves it and says which name was not found.
 *
 * It used to be a path composed segment by segment beside a `readFileSync` — a gate
 * holding its own opinion about where console source lives, which is what the
 * source-walk chokepoint's second claim exists to refuse.
 */
const TRIPWIRES_MODULE = "console/core/tripwires.ts";

const FIXTURE_GUARD = "if (__SIDEKICKS_CONSOLE_FIXTURES__) {";
const REGISTRY_ASSIGNMENT = "[TRIPWIRE_FIXTURE_GLOBAL] = consoleTripwires";

describe("tripwire fixture global — exposed only behind the fixture define", () => {
  const source = readConsoleSourceModule(
    moduleNamed(consoleSourceModules(), TRIPWIRES_MODULE, "the tripwire registry"),
  );

  it("assigns the registry only inside the fixture guard", () => {
    const guardIndex = source.indexOf(FIXTURE_GUARD);
    const assignmentIndex = source.indexOf(REGISTRY_ASSIGNMENT);
    expect(guardIndex, "the fixture guard is missing entirely").toBeGreaterThanOrEqual(0);
    expect(assignmentIndex, "the registry assignment is missing entirely").toBeGreaterThan(
      guardIndex,
    );
  });

  it("assigns it exactly once", () => {
    // A second assignment outside the guard would satisfy the ordering check
    // above while still shipping the handle, so the count is the load-bearing
    // half of the claim rather than a tidiness assertion.
    const occurrences = source.split(REGISTRY_ASSIGNMENT).length - 1;
    expect(occurrences).toBe(1);
  });

  it("negative control: the check notices an assignment that is not there", () => {
    // Without this, a predicate that matched anything — an empty needle, say —
    // would make both tests above pass over any file at all.
    expect(source.indexOf("[SOME_OTHER_GLOBAL] = consoleTripwires")).toBe(-1);
  });
});
