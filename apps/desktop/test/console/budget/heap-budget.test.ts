// The renderer heap-at-rest budget row — Plan-023 Phase 1C (T-023p-1C-1).
//
// `Spec-023 §Console Design (Meridian)` §Budgets row 3 bounds the renderer heap
// with ONE SESSION OPEN at 120 MB. This revision measures nothing against it, and
// this file pins that absence in both directions, because an ungated budget is
// only safe while it is loud:
//
//   • the registry row says `n/a`, names the task that takes the reading, and
//     gives a reason — and its CEILING is unchanged, so "ungated" cannot quietly
//     become "relaxed";
//   • the CLI prints an `UNENFORCED` verdict and exits 0 rather than printing a
//     comparison of nothing, and REFUSES with exit 2 if the row is ever flipped
//     back to `enforced` while no code takes a reading.
//
// The second half is the negative control. Until 2026-09-02 this row was
// `enforced` against `process.memoryUsage().heapUsed` in the budget CLI, with a
// stand-in entity map retained: no Chromium, no renderer isolate, no React, no
// DOM, no console store. That gate reported 5 % of budget and would have kept
// reporting it with the shipped renderer arbitrarily far over the limit, so the
// one behaviour worth pinning here is that re-declaring the gate without the
// measurement fails loudly instead of restoring the green.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ConsoleBudgetRegistry,
  formatUnavailableBudgetReport,
  type ConsoleBudget,
} from "../../../scripts/budget/budget-registry.mjs";
import {
  ConsoleHeapAtRestGate,
  HEAP_AT_REST_BUDGET_ID,
  HeapAtRestMeasurementMissingError,
  runHeapBudgetCommand,
  type HeapAtRestUnenforcedRecord,
} from "../../../scripts/budget/measure-heap.mjs";

const registry = ConsoleBudgetRegistry.load();
const budget = registry.requireBudget(HEAP_AT_REST_BUDGET_ID);

const HEAP_HARNESS_PATH = fileURLToPath(
  new URL("../../../scripts/budget/measure-heap.mts", import.meta.url),
);

/** The spec's own figure, restated so an edit to the ceiling fails here. */
const SPEC_CEILING_BYTES = 120_000_000;

/**
 * The registry as it would read if someone re-declared this budget gated.
 *
 * Built by rewriting the real file rather than by hand-authoring an entry, so the
 * fixture cannot drift into a shape the loader would reject for an unrelated
 * reason and pass this test for the wrong one.
 */
function registryClaimingTheHeapBudgetIsGated(): ConsoleBudgetRegistry {
  const document = JSON.parse(readFileSync(registry.budgetsFilePath, "utf8")) as {
    readonly budgets: readonly Record<string, unknown>[];
  };
  const budgets = document.budgets.map((entry) =>
    entry["id"] === HEAP_AT_REST_BUDGET_ID
      ? {
          ...entry,
          status: "enforced",
          measuredBy: "apps/desktop/scripts/budget/measure-heap.mts",
          notMeasurableReason: null,
        }
      : entry,
  );
  const directory = mkdtempSync(path.join(tmpdir(), "console-heap-budget-"));
  const fixturePath = path.join(directory, "budgets.json");
  writeFileSync(fixturePath, JSON.stringify({ ...document, budgets }), "utf8");
  return ConsoleBudgetRegistry.load(fixturePath);
}

describe("the renderer heap-at-rest budget row", () => {
  it("is recorded ungated, with a reason and the task that lifts it", () => {
    expect(budget.status).toBe("n/a");
    expect(budget.measuredBy).toBeNull();
    expect(budget.producedBy).toBe("T-023p-1C-8");
    expect(budget.notMeasurableReason ?? "").toContain("session");
    expect((budget.notMeasurableReason ?? "").length).toBeGreaterThan(40);
  });

  it("keeps the spec's ceiling, so ungated never quietly becomes relaxed", () => {
    expect(budget.limit.canonicalValue).toBe(SPEC_CEILING_BYTES);
    expect(budget.limit.canonicalUnit).toBe("bytes");
    expect(budget.specTarget).toBe("≤ 120 MB");
  });

  it("appears in the ungated block every harness prints, so it stays visible", () => {
    const report = formatUnavailableBudgetReport(registry);
    expect(report).toContain(HEAP_AT_REST_BUDGET_ID);
    expect(report).toContain(budget.producedBy);
    expect(report).toContain(budget.notMeasurableReason ?? "");
  });
});

describe("the heap budget gate", () => {
  it("reports UNENFORCED with the ceiling and the reason, and no verdict over a figure", () => {
    const report = new ConsoleHeapAtRestGate(registry).report();
    console.log(report);

    expect(report).toContain("UNENFORCED");
    expect(report).toContain(budget.notMeasurableReason ?? "");
    expect(report).toContain(budget.producedBy);
    expect(report).toContain(SPEC_CEILING_BYTES.toLocaleString("en-US"));
    // The two verdicts a measured budget prints. Either one here would be a
    // comparison against a figure nothing produced.
    expect(report).not.toContain("WITHIN BUDGET");
    expect(report).not.toContain("OVER BUDGET");
  });

  it("emits a discriminable ungated record rather than a verdict", () => {
    const record = new ConsoleHeapAtRestGate(registry).record();
    expect(budget.notMeasurableReason).not.toBeNull();
    expect(record).toStrictEqual({
      budgetId: HEAP_AT_REST_BUDGET_ID,
      status: "unenforced",
      reason: budget.notMeasurableReason ?? "",
      producedBy: budget.producedBy,
      limitCanonicalValue: SPEC_CEILING_BYTES,
      canonicalUnit: "bytes",
    } satisfies HeapAtRestUnenforcedRecord);
  });

  // The negative control. Every assertion above rests on the gate distinguishing
  // "declared ungated" from "gated"; this proves it does, on the one known-bad
  // input that matters — the row re-declared gated with nothing measuring it.
  it("refuses a registry that claims this budget is gated", () => {
    const gatedRegistry = registryClaimingTheHeapBudgetIsGated();
    const gate = new ConsoleHeapAtRestGate(gatedRegistry);

    expect(gate.budget.status).toBe("enforced");
    expect(() => gate.report()).toThrow(HeapAtRestMeasurementMissingError);
    expect(() => gate.record()).toThrow(/nothing measures it/);
    expect(runHeapBudgetCommand([], gatedRegistry)).toBe(2);
  });
});

describe("the heap budget CLI", () => {
  it("exits 0 on the declared-ungated row and 2 on an unknown flag", () => {
    expect(runHeapBudgetCommand([], registry)).toBe(0);
    expect(runHeapBudgetCommand(["--no-such-flag"], registry)).toBe(2);
    expect(runHeapBudgetCommand(["--help"], registry)).toBe(0);
  });

  it("prints the UNENFORCED report from a real invocation, and exits 0", () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", HEAP_HARNESS_PATH], {
      encoding: "utf8",
      cwd: path.dirname(HEAP_HARNESS_PATH),
      maxBuffer: 8 * 1024 * 1024,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("UNENFORCED");
    expect(result.stdout).toContain(HEAP_AT_REST_BUDGET_ID);
    expect(result.stdout).not.toContain("WITHIN BUDGET");
  });

  it("emits the row and its ungated record as JSON", () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", HEAP_HARNESS_PATH, "--json"],
      {
        encoding: "utf8",
        cwd: path.dirname(HEAP_HARNESS_PATH),
        maxBuffer: 8 * 1024 * 1024,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const emitted = JSON.parse(result.stdout) as {
      readonly budget: ConsoleBudget;
      readonly unenforced: HeapAtRestUnenforcedRecord;
    };
    expect(emitted.budget.id).toBe(HEAP_AT_REST_BUDGET_ID);
    expect(emitted.budget.status).toBe("n/a");
    expect(emitted.unenforced.status).toBe("unenforced");
    expect(emitted.unenforced.limitCanonicalValue).toBe(SPEC_CEILING_BYTES);
  });
});
