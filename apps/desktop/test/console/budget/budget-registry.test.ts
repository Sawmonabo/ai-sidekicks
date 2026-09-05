// The registry's SHAPE — which rows exist, and what each one must carry.
//
// `budgets.json` is the single source of truth for every numeric budget the
// console is gated on (`Spec-023 §Console Design (Meridian)` §Budgets, Plan-023
// invariant I-023-14), and two of the three failure modes that would make it
// worthless are shape failures this file closes:
//
//   • A budget quietly missing. Every row of the spec's §Budgets table is
//     asserted present by id, so deleting one fails here rather than going
//     unnoticed as a gate nobody runs.
//
//   • A budget quietly ungated. Every `"n/a"` entry must name the Plan-023 task
//     that makes it measurable and the reason it is not measurable yet.
//
//   • A budget gated by a claim rather than by a measurement. A `harness` row's
//     figure has no spec behind it, so the document states the derivation once
//     for that whole set and each row points at it rather than carrying a copy.
//
// Three neighbouring questions are deliberately elsewhere, each beside the module
// that answers it: whether the loader REFUSES a malformed document is
// `budget-document.test.ts`'s, whether the report names every un-measured row is
// `budget-report.test.ts`'s, and whether the comparison bites is
// `budget-evaluation.test.ts`'s. Whether the file a row NAMES actually drives the
// row's subject is a question over a file rather than over the registry, and it
// is `measured-by.test.ts`'s.

import { describe, expect, it } from "vitest";

import {
  ConsoleBudgetRegistry,
  DEFAULT_BUDGETS_FILE_PATH,
} from "../../../scripts/budget/budget-registry.mjs";

/** Every row of `Spec-023 §Console Design (Meridian)` §Budgets, by registry id. */
const EXPECTED_PRODUCT_BUDGET_IDS: readonly string[] = [
  "renderer-initial-bundle",
  "frame-time-p95-four-lanes",
  "renderer-heap-at-rest",
  "steady-heap-flagship-replay",
  "idle-cpu",
  "streaming-cpu-one-lane",
  "terminal-instance-memory",
  "time-to-first-ledger-row",
];

/**
 * Bounds the test scaffolding applies to ITSELF, which no spec figure backs.
 *
 * They share `budgets.json` because one value gets one home, and they are
 * `scope: "harness"` rather than merged into the list above because the claim
 * that list makes — the spec's table names these and nothing else — has to stay
 * countable. Before this they were TypeScript literals one directory away, the
 * only numbers in the tree gated by nothing.
 */
const EXPECTED_HARNESS_BUDGET_IDS: readonly string[] = [
  "console-launch-readiness",
  "console-launch-frame-witness",
  "console-launch-cleanup",
  "console-launch-body",
  "console-endurance-body",
];

/**
 * Budgets this revision actually measures. Every other row must be `"n/a"`.
 *
 * `renderer-heap-at-rest` left this list on 2026-09-02 and returned the same
 * day, and the round trip is the point. It was gated against a Node process
 * holding a stand-in entity map — no Chromium, no renderer isolate, no React, no
 * DOM, no console store — so the gate could report green over a renderer well
 * past its ceiling; the row went `"n/a"` rather than being re-pointed at a
 * reading nothing could take. It is here again because the reading now exists:
 * the endurance tier launches the built console, opens a session the scenario
 * engine has delivered into, and reads that renderer's own heap. Re-listing this
 * id against any harness that holds no renderer restores the false green rather
 * than the gate, which `heap-budget.test.ts` refuses by name.
 */
const EXPECTED_ENFORCED_BUDGET_IDS: readonly string[] = [
  "renderer-initial-bundle",
  "renderer-heap-at-rest",
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

const registry = ConsoleBudgetRegistry.load();

describe("console budget registry", () => {
  it("loads the one budgets file the harnesses read", () => {
    expect(registry.budgetsFilePath).toBe(DEFAULT_BUDGETS_FILE_PATH);
    expect(registry.schemaVersion).toBe(3);
    expect(registry.source).toContain("023-desktop-shell-and-renderer.md");
  });

  it("carries every budget the spec's §Budgets table names, and no others", () => {
    // Scoped to the product rows, which is what makes this claim survive the
    // harness rows joining the file: the spec's table is a closed set and the
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
      expect(budget.producedBy, `${budget.id}: producedBy`).toMatch(/^T-023[pr]-/);
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
      // The symbol is what makes the path checkable at all: `measured-by.test.ts`
      // reads the named file and refuses a row whose harness never holds it.
      expect(budget.subjectSymbol, `${budget.id}: subjectSymbol`).not.toBeNull();
      expect(budget.notMeasurableReason, `${budget.id}: notMeasurableReason`).toBeNull();
    }
  });

  it("states the harness derivation once, and every harness row points at it", () => {
    // The launch rows each opened with the same 44-word sentence, which is one
    // rule with as many places to drift as there are rows — and it was already
    // imprecise: it named `console-e2e` as THE derivation, when the guard runs
    // against every launching tier's resolved timeout.
    const derivation = registry.harnessBudgetDerivation ?? "";
    expect(derivation, "the derivation is stated").not.toBe("");
    expect(derivation, "held against every launching tier, not one named tier").toContain(
      "every launching tier",
    );
    expect(derivation, "and it says how a tier's own timeout comes out of them").toContain(
      "tierTimeoutFor",
    );

    const harnessNotes = registry.harnessBudgets().map((budget) => budget.notes);
    for (const notes of harnessNotes) {
      expect(notes, "a harness row says where its derivation lives").toContain(
        "harnessBudgetDerivation",
      );
    }
    // Rows that open alike are copies of one sentence, which is the shape the
    // pointer replaced.
    const openings = new Set(harnessNotes.map((notes) => notes.slice(0, 60)));
    expect(openings.size, "harness rows repeat one derivation verbatim").toBe(harnessNotes.length);
  });

  it("makes every un-measurable budget name its producing task and its reason", () => {
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
      expect(budget.producedBy, `${budget.id}: producedBy`).toMatch(/^T-023p-1C-[2-8]$/);
    }
  });
});
