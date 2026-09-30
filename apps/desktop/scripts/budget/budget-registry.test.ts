// The registry's shape: which rows exist and what each must carry. `budgets.json` is the single
// source of truth for every numeric budget, so a budget quietly missing (every product budget is
// asserted present by id) or quietly ungated (every `"n/a"` row must say why) fails here. The
// loader's refusals, the report and the comparison are tested beside their own modules. Whether a
// row's `measuredBy` file really drives its subject is left to the reviewer of the diff.

import { describe, expect, it } from "vitest";

import { BudgetRegistry, DEFAULT_BUDGETS_FILE_PATH } from "./budget-registry.mjs";

/** Every product budget, by registry id. */
const EXPECTED_PRODUCT_BUDGET_IDS: readonly string[] = [
  "renderer-initial-bundle",
  "frame-time-p95-four-lanes",
  "renderer-heap-at-rest",
  "steady-heap-concurrent-streaming",
  "idle-cpu",
  "streaming-cpu-one-lane",
  "terminal-instance-memory",
  "time-to-first-transcript-row",
];

/**
 * Bounds no spec figure backs, kept in `scope: "harness"` so the product list stays countable.
 * Five are the launch slices the scaffolding applies to itself; `renderer-initial-fonts` bounds
 * the shipped `woff2` faces in raw bytes, since a `woff2` is already compressed.
 */
const EXPECTED_HARNESS_BUDGET_IDS: readonly string[] = [
  "renderer-initial-fonts",
  "console-launch-readiness",
  "console-launch-frame-paint-probe",
  "console-launch-cleanup",
  "console-launch-body",
  "console-endurance-body",
];

/**
 * Budgets that are measured; every other row must be `"n/a"`. The heap, transcript-row,
 * frame-time and terminal-memory rows belong to the endurance tier because only a running
 * renderer holds their subject. The frame-time row prints its figure on every runner and compares
 * it only on the pinned class, which `tests/endurance/pinned-runner-class.ts` decides.
 */
const EXPECTED_ENFORCED_BUDGET_IDS: readonly string[] = [
  "renderer-initial-bundle",
  "renderer-heap-at-rest",
  "time-to-first-transcript-row",
  "frame-time-p95-four-lanes",
  "terminal-instance-memory",
  ...EXPECTED_HARNESS_BUDGET_IDS,
];

/** How each declared unit reduces to its canonical unit. */
const CANONICAL_UNIT_FACTORS: Readonly<Record<string, { factor: number; canonical: string }>> = {
  kB: { factor: 1000, canonical: "bytes" },
  MB: { factor: 1_000_000, canonical: "bytes" },
  MiB: { factor: 1_048_576, canonical: "bytes" },
  ms: { factor: 1, canonical: "ms" },
  percentOfOneCore: { factor: 1, canonical: "percentOfOneCore" },
};

const registry = BudgetRegistry.load();

describe("console budget registry", () => {
  it("loads the one budgets file the harnesses read", () => {
    expect(registry.budgetsFilePath).toBe(DEFAULT_BUDGETS_FILE_PATH);
    expect(registry.schemaVersion).toBe(3);
  });

  it("carries every product budget, and no others", () => {
    // Scoped to the product rows: the scaffolding's own bounds are not part of the closed list.
    expect(
      registry
        .productBudgets()
        .map((budget) => budget.id)
        .sort(),
    ).toStrictEqual([...EXPECTED_PRODUCT_BUDGET_IDS].sort());
  });

  it("carries the harness's own bounds, and no others", () => {
    expect(
      registry
        .harnessBudgets()
        .map((budget) => budget.id)
        .sort(),
    ).toStrictEqual([...EXPECTED_HARNESS_BUDGET_IDS].sort());
  });

  it("splits every row into exactly one scope", () => {
    expect(registry.productBudgets().length + registry.harnessBudgets().length).toBe(
      registry.budgets.length,
    );
  });

  it("gives every entry the fields a harness reads", () => {
    for (const budget of registry.budgets) {
      expect(budget.label.length, `${budget.id}: label`).toBeGreaterThan(0);
      expect(budget.subject.length, `${budget.id}: subject`).toBeGreaterThan(0);
      expect(budget.specTarget.length, `${budget.id}: specTarget`).toBeGreaterThan(0);
      expect(budget.notes.length, `${budget.id}: notes`).toBeGreaterThan(0);
      expect(budget.limit.comparison, `${budget.id}: comparison`).toBe("<=");
      expect(budget.limit.value, `${budget.id}: limit value`).toBeGreaterThan(0);
    }
  });

  it("reduces each declared limit to its canonical unit without arithmetic drift", () => {
    for (const budget of registry.budgets) {
      const conversion = CANONICAL_UNIT_FACTORS[budget.limit.unit];
      expect(conversion, `${budget.id}: unknown unit \`${budget.limit.unit}\``).toBeDefined();
      if (conversion === undefined) {
        continue;
      }
      expect(budget.limit.canonicalUnit, `${budget.id}: canonical unit`).toBe(conversion.canonical);
      expect(budget.limit.canonicalValue, `${budget.id}: canonical value`).toBeCloseTo(
        budget.limit.value * conversion.factor,
        6,
      );
    }
  });

  it("names a measuring harness and a subject for exactly the enforced budgets", () => {
    expect(
      registry
        .enforcedBudgets()
        .map((budget) => budget.id)
        .sort(),
    ).toStrictEqual([...EXPECTED_ENFORCED_BUDGET_IDS].sort());
    for (const budget of registry.enforcedBudgets()) {
      expect(budget.measuredBy, `${budget.id}: measuredBy`).not.toBeNull();
      // The symbol is what lets a reader open the named harness and look for it.
      expect(budget.subjectSymbol, `${budget.id}: subjectSymbol`).not.toBeNull();
      expect(budget.notMeasurableReason, `${budget.id}: notMeasurableReason`).toBeNull();
    }
  });

  it("makes every un-measurable budget give its reason", () => {
    const unavailable = registry.unavailableBudgets();
    expect(unavailable.length).toBe(
      EXPECTED_PRODUCT_BUDGET_IDS.length +
        EXPECTED_HARNESS_BUDGET_IDS.length -
        EXPECTED_ENFORCED_BUDGET_IDS.length,
    );
    for (const budget of unavailable) {
      expect(budget.measuredBy, `${budget.id}: measuredBy`).toBeNull();
      expect(budget.subjectSymbol, `${budget.id}: subjectSymbol`).toBeNull();
      expect(budget.notMeasurableReason ?? "", `${budget.id}: reason`).not.toBe("");
      expect(
        (budget.notMeasurableReason ?? "").length,
        `${budget.id}: reason length`,
      ).toBeGreaterThan(40);
    }
  });
});
