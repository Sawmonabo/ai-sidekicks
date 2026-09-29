// The registry's SHAPE — which rows exist, and what each one must carry.
//
// `budgets.json` is the single source of truth for every numeric budget the
// console is gated on, and two failure modes that would make it worthless are shape
// failures this file closes:
//
//   • A budget quietly missing. Every product budget is asserted present by id,
//     so deleting one fails here rather than going unnoticed as a gate nobody
//     runs.
//
//   • A budget quietly ungated. Every `"n/a"` entry must say why it is not
//     measurable yet.
//
// Three neighboring questions are deliberately elsewhere, each beside the module
// that answers it: whether the loader REFUSES a malformed document is
// `budget-document.test.ts`'s, whether the report names every un-measured row is
// `budget-report.test.ts`'s, and whether the comparison bites is
// `budget-evaluation.test.ts`'s. Whether the file a row NAMES actually drives the
// row's subject is a question over a file rather than over the registry, and no
// gate asks it: a row's `measuredBy` is checked by the reviewer of the diff that
// writes it.

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
 * Bounds no spec figure backs — the complement of the list above rather than one
 * kind of thing.
 *
 * They share `budgets.json` because one value gets one home, and they are
 * `scope: "harness"` rather than merged into the list above because the claim
 * that list makes — the spec's table names these and nothing else — has to stay
 * countable. Before this they were TypeScript literals one directory away, the
 * only numbers in the tree gated by nothing.
 *
 * Five of them are the launch slices the scaffolding applies to ITSELF.
 * `renderer-initial-fonts` is not: it bounds a shipped artifact, the
 * self-hosted `woff2` faces on the renderer's initial graph, and it is here
 * because the spec's table names no font row and a ninth `product` id would cost
 * the countability that list exists for. Its unit is raw bytes rather than gzip
 * for the reason `harnessBudgetDerivation` states — a `woff2` is a Brotli
 * container, so a compressed figure over one measures nothing.
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
 * Budgets that are measured. Every other row must be `"n/a"`.
 *
 * The heap, transcript-row, frame-time and terminal-memory rows are taken by the
 * endurance tier because their subject is a running renderer, and no process without
 * one holds it: a harness that held less than its row's subject would report green
 * over a renderer past its ceiling. The frame-time row is hardware-dependent: it
 * prints its figure on every runner and compares it only on the pinned class, which
 * `tests/endurance/pinned-runner-class.ts` decides.
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
    // Scoped to the product rows, which is what makes this claim survive the
    // harness rows joining the file: the product list is a closed set and the
    // scaffolding's own bounds are not part of it.
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
      // The symbol is what makes the path checkable at all — by a reader, who
      // can open the named harness and look for it.
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
