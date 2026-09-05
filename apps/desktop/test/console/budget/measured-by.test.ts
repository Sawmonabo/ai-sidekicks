// A budget row points at the harness that DRIVES its subject, not merely at a file.
//
// `measuredBy` was checked with `existsSync` and nothing else, and a path that
// exists is not evidence. Two rows named `architecture/launch-deadline.test.ts`
// — the frame-witness bound and the cleanup bound — and that file compares
// registry figures with imported constants and checks aggregate timeout
// arithmetic. It drives neither `FrameWitness` nor `BoundedCleanup`; those races
// are held in `frame-witness.test.ts` and `bounded-cleanup.test.ts`. Budget-audit
// tooling following `measuredBy` therefore arrived at a suite that holds none of
// the subjects the rows claimed it enforced.
//
// So a row names its subject as a SYMBOL, and the rule here is mechanical: the
// named harness must hold that symbol as a binding — imported, for a test that
// drives a class, or declared, for a script that runs a measurer it owns. A row
// whose harness never touches its subject is red.
//
// This claim lives beside `budget-registry.test.ts` rather than inside it because
// the two are different subjects: that file holds the registry's SHAPE — which rows
// exist, which are enforced, how a unit reduces — and this one holds the relationship
// between a row and a file on disk, which is the only claim here that reads
// anything outside the registry.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ConsoleBudgetRegistry,
  DESKTOP_PACKAGE_ROOT,
  type ConsoleBudget,
} from "../../../scripts/budget/budget-registry.mjs";
import { bindingsHeldBy } from "./module-bindings.js";

const REPOSITORY_ROOT: string = path.resolve(DESKTOP_PACKAGE_ROOT, "..", "..");

const registry = ConsoleBudgetRegistry.load();

/** The harness's own source, read the way the gate reads it. */
function sourceOf(repositoryRelativePath: string): string {
  return readFileSync(path.join(REPOSITORY_ROOT, repositoryRelativePath), "utf8");
}

/** Whether `budget`'s named harness holds the symbol the row is about. */
function harnessHoldsSubject(budget: ConsoleBudget): boolean {
  return bindingsHeldBy(sourceOf(budget.measuredBy ?? "")).has(budget.subjectSymbol ?? "");
}

describe("every enforced budget names the harness that drives its subject", () => {
  const enforcedBudgets = registry.enforcedBudgets();

  it("finds enforced rows to check", () => {
    // Without this the case below is vacuously true over an empty list, which is
    // the shape a registry that failed to load would take.
    expect(enforcedBudgets.length).toBeGreaterThan(1);
  });

  it.each(enforcedBudgets.map((budget) => [budget.id, budget] as const))(
    "%s is measured by a file that holds its subject",
    (_budgetId, budget) => {
      expect(budget.measuredBy, "measuredBy").not.toBeNull();
      expect(budget.subjectSymbol, "subjectSymbol").not.toBeNull();
      expect(
        harnessHoldsSubject(budget),
        `${budget.measuredBy ?? ""} holds no binding named \`${budget.subjectSymbol ?? ""}\``,
      ).toBe(true);
    },
  );

  it("negative control: the harness that only reads the figures fails the frame-witness row", () => {
    // THE FINDING, as a case. `launch-deadline.test.ts` exists, is a test, and
    // imports `FRAME_WITNESS_TIMEOUT_MS` — everything the old rule asked — and it
    // still drives no witness. Re-point the row at it and this file goes red.
    const frameWitnessBudget = registry.requireBudget("console-launch-frame-witness");
    expect(harnessHoldsSubject(frameWitnessBudget)).toBe(true);
    expect(
      harnessHoldsSubject({
        ...frameWitnessBudget,
        measuredBy: "apps/desktop/test/console/architecture/launch-deadline.test.ts",
      }),
    ).toBe(false);
  });

  it("points a harness row's `measuredBy` at a test rather than at a module that reads it", () => {
    // A `harness` row has no spec figure behind it, so the test that drives its
    // subject IS the whole enforcement — a module that merely consumes the number
    // measures nothing, and three rows once named `launch-deadline.ts`,
    // `frame-witness.ts`, and `bounded-cleanup.ts`, the consumers themselves.
    const enforcedHarnessBudgets = registry
      .harnessBudgets()
      .filter((budget) => budget.status === "enforced");
    expect(enforcedHarnessBudgets.length, "harness rows to check").toBeGreaterThan(0);
    for (const budget of enforcedHarnessBudgets) {
      expect(budget.measuredBy ?? "", `${budget.id}: measuredBy`).toMatch(/\.test\.ts$/u);
    }
  });
});
