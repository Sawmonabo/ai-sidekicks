// The budget registry's own tests — Plan-023 Phase 1C (T-023p-1C-1).
//
// `budgets.json` is the single source of truth for every numeric budget the
// console is gated on (`Spec-023 §Console Design (Meridian)` §Budgets, Plan-023
// invariant I-023-14). Two failure modes make it worthless, and this file
// closes both:
//
//   • A budget quietly missing. Every row of the spec's §Budgets table is
//     asserted present by id, so deleting one fails here rather than going
//     unnoticed as a gate nobody runs.
//
//   • A budget quietly ungated. Every `"n/a"` entry must name the Plan-023 task
//     that makes it measurable and the reason it is not measurable yet, and the
//     report every harness prints must actually name all of them.
//
// The loader's validation is additionally exercised against known-bad inputs
// below, so "the registry parsed" is evidence rather than an assumption: a
// checker that has never been shown to reject anything has not been shown to
// check anything.

import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ConsoleBudgetRegistry,
  ConsoleBudgetRegistryError,
  DEFAULT_BUDGETS_FILE_PATH,
  DESKTOP_PACKAGE_ROOT,
  evaluateBudget,
  formatUnavailableBudgetReport,
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

const REPOSITORY_ROOT: string = path.resolve(DESKTOP_PACKAGE_ROOT, "..", "..");

const registry = ConsoleBudgetRegistry.load();

describe("console budget registry", () => {
  it("loads the one budgets file the harnesses read", () => {
    expect(registry.budgetsFilePath).toBe(DEFAULT_BUDGETS_FILE_PATH);
    expect(registry.schemaVersion).toBe(2);
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

  it("names a measuring harness for exactly the enforced budgets, and each one exists", () => {
    expect(
      registry
        .enforcedBudgets()
        .map((budget) => budget.id)
        .sort(),
    ).toStrictEqual([...EXPECTED_ENFORCED_BUDGET_IDS].sort());
    for (const budget of registry.enforcedBudgets()) {
      expect(budget.measuredBy, `${budget.id}: measuredBy`).not.toBeNull();
      expect(budget.notMeasurableReason, `${budget.id}: notMeasurableReason`).toBeNull();
      const harnessPath = path.join(REPOSITORY_ROOT, budget.measuredBy ?? "");
      expect(existsSync(harnessPath), `${budget.id}: harness at ${harnessPath}`).toBe(true);
    }
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
      expect(budget.notMeasurableReason ?? "", `${budget.id}: reason`).not.toBe("");
      expect(
        (budget.notMeasurableReason ?? "").length,
        `${budget.id}: reason length`,
      ).toBeGreaterThan(40);
      expect(budget.producedBy, `${budget.id}: producedBy`).toMatch(/^T-023p-1C-[2-8]$/);
    }
  });

  it("prints one explicit n/a line per un-measured budget, so none is silently omitted", () => {
    const report = formatUnavailableBudgetReport(registry);
    for (const budget of registry.unavailableBudgets()) {
      expect(report, `${budget.id} missing from the report`).toContain(budget.id);
      expect(report).toContain(budget.producedBy);
      expect(report).toContain(budget.notMeasurableReason ?? "");
    }
    for (const budget of registry.enforcedBudgets()) {
      expect(report, `${budget.id} should not appear in the n/a block`).not.toContain(
        `n/a  ${budget.id}`,
      );
    }
  });
});

describe("budget evaluation", () => {
  it("compares a measurement against the canonical limit", () => {
    const budget = registry.requireBudget("renderer-initial-bundle");
    const under = evaluateBudget(budget, 92_497);
    expect(under.withinBudget).toBe(true);
    expect(under.headroomCanonicalValue).toBe(budget.limit.canonicalValue - 92_497);

    const exactlyAtLimit = evaluateBudget(budget, budget.limit.canonicalValue);
    expect(exactlyAtLimit.withinBudget).toBe(true);
    expect(exactlyAtLimit.utilizationFraction).toBe(1);

    const over = evaluateBudget(budget, budget.limit.canonicalValue + 1);
    expect(over.withinBudget).toBe(false);
    expect(over.headroomCanonicalValue).toBe(-1);
  });

  it("refuses an unknown budget id rather than returning a vacuous pass", () => {
    expect(() => registry.requireBudget("no-such-budget")).toThrow(ConsoleBudgetRegistryError);
  });
});

// Negative controls. Every assertion above rests on the loader rejecting
// malformed input; these prove it does, on one known-bad input per rule.
describe("registry validation (negative controls)", () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "console-budget-registry-"));

  const loadFixture = (name: string, document: unknown): (() => ConsoleBudgetRegistry) => {
    const fixturePath = path.join(temporaryDirectory, `${name}.json`);
    writeFileSync(fixturePath, JSON.stringify(document), "utf8");
    return () => ConsoleBudgetRegistry.load(fixturePath);
  };

  const validEntry = {
    id: "example",
    label: "Example",
    subject: "An example budget.",
    specTarget: "≤ 1 kB",
    limit: { comparison: "<=", value: 1, unit: "kB", canonicalValue: 1000, canonicalUnit: "bytes" },
    scope: "product",
    status: "enforced",
    producedBy: "T-023p-1C-1",
    measuredBy: "apps/desktop/scripts/budget/measure-bundle.mjs",
    notes: "Example notes.",
  };
  const validDocument = { schemaVersion: 2, source: "spec", budgets: [validEntry] };

  it("accepts a well-formed registry (the positive control the rest are measured against)", () => {
    expect(loadFixture("valid", validDocument)().budgets).toHaveLength(1);
  });

  it("rejects a missing file", () => {
    expect(() => ConsoleBudgetRegistry.load(path.join(temporaryDirectory, "absent.json"))).toThrow(
      ConsoleBudgetRegistryError,
    );
  });

  it("rejects an unsupported schema version", () => {
    expect(loadFixture("bad-schema", { ...validDocument, schemaVersion: 1 })).toThrow(
      /schemaVersion/,
    );
  });

  it("rejects an `n/a` entry with no producing task", () => {
    const entry = { ...validEntry, status: "n/a", measuredBy: null, notMeasurableReason: "why" };
    const { producedBy: _omitted, ...withoutProducedBy } = entry;
    expect(
      loadFixture("no-produced-by", { ...validDocument, budgets: [withoutProducedBy] }),
    ).toThrow(/producedBy/);
  });

  it("rejects an `n/a` entry with no reason", () => {
    const entry = { ...validEntry, status: "n/a", measuredBy: null };
    expect(loadFixture("no-reason", { ...validDocument, budgets: [entry] })).toThrow(
      /notMeasurableReason/,
    );
  });

  it("rejects an `enforced` entry with no measuring harness", () => {
    const { measuredBy: _omitted, ...withoutHarness } = validEntry;
    expect(loadFixture("no-harness", { ...validDocument, budgets: [withoutHarness] })).toThrow(
      /measuredBy/,
    );
  });

  it("rejects a duplicate budget id", () => {
    expect(
      loadFixture("duplicate", { ...validDocument, budgets: [validEntry, { ...validEntry }] }),
    ).toThrow(/duplicate budget id/);
  });

  it("rejects a comparison that is not a ceiling", () => {
    const entry = { ...validEntry, limit: { ...validEntry.limit, comparison: ">=" } };
    expect(loadFixture("bad-comparison", { ...validDocument, budgets: [entry] })).toThrow(
      /comparison/,
    );
  });

  it("rejects a non-numeric limit", () => {
    const entry = { ...validEntry, limit: { ...validEntry.limit, canonicalValue: "450000" } };
    expect(loadFixture("bad-limit", { ...validDocument, budgets: [entry] })).toThrow(
      /canonicalValue/,
    );
  });

  it("rejects an unknown status", () => {
    const entry = { ...validEntry, status: "deferred" };
    expect(loadFixture("bad-status", { ...validDocument, budgets: [entry] })).toThrow(/status/);
  });

  it("rejects an unknown scope", () => {
    // A row that declares neither kind would be counted by neither completeness
    // claim above, which is the one way a budget can rejoin the set of numbers
    // nothing checks.
    const entry = { ...validEntry, scope: "internal" };
    expect(loadFixture("bad-scope", { ...validDocument, budgets: [entry] })).toThrow(/scope/);
  });

  it("rejects a row with no scope at all", () => {
    const { scope: _omitted, ...withoutScope } = validEntry;
    expect(loadFixture("no-scope", { ...validDocument, budgets: [withoutScope] })).toThrow(/scope/);
  });
});
