// The renderer heap-at-rest budget row — Plan-023 Phase 1C (T-023p-1C-1).
//
// `Spec-023 §Console Design (Meridian)` §Budgets row 3 bounds the renderer heap
// with ONE SESSION OPEN at 120 MB. The reading is taken by the endurance tier —
// `test/console/endurance/heap-at-rest.test.ts`, which launches the built console
// and reads its renderer's own heap — and this file pins what THIS tier can see
// about that arrangement, in both directions:
//
//   • the registry row is gated, names that harness, and its CEILING is
//     unchanged, so a re-pointed reading cannot quietly become a relaxed one;
//   • the budget CLI prints a `MEASURED ELSEWHERE` verdict and exits 0 rather
//     than printing a comparison of nothing, and REFUSES with exit 2 if the row
//     is ever re-pointed at the CLI itself, which is a Node process holding no
//     renderer.
//
// The second half is the negative control, and it is the arm with history. Until
// 2026-09-02 this row was `enforced` against `process.memoryUsage().heapUsed` in
// that CLI, with a stand-in entity map retained: no Chromium, no renderer
// isolate, no React, no DOM, no console store. That gate reported 5 % of budget
// and would have kept reporting it with the shipped renderer arbitrarily far over
// the limit, so the one behaviour worth pinning here is that naming the CLI as
// the measurer fails loudly instead of restoring the green.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ConsoleBudgetRegistry,
  type ConsoleBudget,
} from "../../../scripts/budget/budget-registry.mjs";
import {
  ConsoleHeapAtRestGate,
  HEAP_AT_REST_BUDGET_ID,
  HeapAtRestMeasurerMisattributedError,
  runHeapBudgetCommand,
  type HeapAtRestDelegationRecord,
} from "../../../scripts/budget/measure-heap.mjs";

const registry = ConsoleBudgetRegistry.load();
const budget = registry.requireBudget(HEAP_AT_REST_BUDGET_ID);

const HEAP_HARNESS_PATH = fileURLToPath(
  new URL("../../../scripts/budget/measure-heap.mts", import.meta.url),
);

/** The spec's own figure, restated so an edit to the ceiling fails here. */
const SPEC_CEILING_BYTES = 120_000_000;

/** The harness the row must NOT name, and the one the refusal below is about. */
const NODE_CLI_HARNESS_PATH = "apps/desktop/scripts/budget/measure-heap.mts";

/** The harness the row does name — the tier that holds a renderer. */
const ENDURANCE_HARNESS_PATH = "apps/desktop/test/console/endurance/heap-at-rest.test.ts";

/**
 * The registry as it would read if someone re-pointed this budget at the CLI.
 *
 * Built by rewriting the real file rather than by hand-authoring an entry, so the
 * fixture cannot drift into a shape the loader would reject for an unrelated
 * reason and pass this test for the wrong one.
 */
function registryClaimingTheNodeCliMeasuresTheHeap(): ConsoleBudgetRegistry {
  const document = JSON.parse(readFileSync(registry.budgetsFilePath, "utf8")) as {
    readonly budgets: readonly Record<string, unknown>[];
  };
  const budgets = document.budgets.map((entry) =>
    entry["id"] === HEAP_AT_REST_BUDGET_ID
      ? { ...entry, status: "enforced", measuredBy: NODE_CLI_HARNESS_PATH }
      : entry,
  );
  const directory = mkdtempSync(path.join(tmpdir(), "console-heap-budget-"));
  const fixturePath = path.join(directory, "budgets.json");
  writeFileSync(fixturePath, JSON.stringify({ ...document, budgets }), "utf8");
  return ConsoleBudgetRegistry.load(fixturePath);
}

describe("the renderer heap-at-rest budget row", () => {
  it("is recorded gated, and names the harness that holds a renderer", () => {
    expect(budget.status).toBe("enforced");
    expect(budget.measuredBy).toBe(ENDURANCE_HARNESS_PATH);
    expect(budget.notMeasurableReason).toBeNull();
    expect(budget.producedBy).toBe("T-023p-1C-8");
  });

  it("keeps the spec's ceiling, so a re-pointed reading never relaxes the budget", () => {
    expect(budget.limit.canonicalValue).toBe(SPEC_CEILING_BYTES);
    expect(budget.limit.canonicalUnit).toBe("bytes");
    expect(budget.specTarget).toBe("≤ 120 MB");
  });
});

describe("the heap budget CLI's delegation", () => {
  it("reports MEASURED ELSEWHERE with the ceiling and the harness, and no verdict over a figure", () => {
    const report = new ConsoleHeapAtRestGate(registry).report();
    console.log(report);

    expect(report).toContain("MEASURED ELSEWHERE");
    expect(report).toContain(ENDURANCE_HARNESS_PATH);
    expect(report).toContain(budget.producedBy);
    expect(report).toContain(SPEC_CEILING_BYTES.toLocaleString("en-US"));
    // The two verdicts a measured budget prints. Either one here would be a
    // comparison against a figure this process never took.
    expect(report).not.toContain("WITHIN BUDGET");
    expect(report).not.toContain("OVER BUDGET");
  });

  it("emits a discriminable delegation record rather than a verdict", () => {
    const record = new ConsoleHeapAtRestGate(registry).record();
    expect(record).toStrictEqual({
      budgetId: HEAP_AT_REST_BUDGET_ID,
      status: "measured-elsewhere",
      measuredBy: ENDURANCE_HARNESS_PATH,
      producedBy: budget.producedBy,
      limitCanonicalValue: SPEC_CEILING_BYTES,
      canonicalUnit: "bytes",
    } satisfies HeapAtRestDelegationRecord);
  });

  // The negative control. Every assertion above rests on the gate distinguishing
  // "measured somewhere that holds a renderer" from "measured here"; this proves
  // it does, on the one known-bad input that matters — the row re-pointed at the
  // Node process, which is the shape this budget was falsely green under.
  it("refuses a registry that names this Node harness as the measurer", () => {
    const misattributedRegistry = registryClaimingTheNodeCliMeasuresTheHeap();
    const gate = new ConsoleHeapAtRestGate(misattributedRegistry);

    expect(gate.budget.measuredBy).toBe(NODE_CLI_HARNESS_PATH);
    expect(() => gate.report()).toThrow(HeapAtRestMeasurerMisattributedError);
    expect(() => gate.record()).toThrow(/nothing in this process can take that reading/);
    expect(runHeapBudgetCommand([], misattributedRegistry)).toBe(2);
  });
});

describe("the heap budget CLI", () => {
  it("exits 0 on the delegated row and 2 on an unknown flag", () => {
    expect(runHeapBudgetCommand([], registry)).toBe(0);
    expect(runHeapBudgetCommand(["--no-such-flag"], registry)).toBe(2);
    expect(runHeapBudgetCommand(["--help"], registry)).toBe(0);
  });

  it("prints the MEASURED ELSEWHERE report from a real invocation, and exits 0", () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", HEAP_HARNESS_PATH], {
      encoding: "utf8",
      cwd: path.dirname(HEAP_HARNESS_PATH),
      maxBuffer: 8 * 1024 * 1024,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("MEASURED ELSEWHERE");
    expect(result.stdout).toContain(HEAP_AT_REST_BUDGET_ID);
    expect(result.stdout).not.toContain("WITHIN BUDGET");
  });

  it("emits the row and its delegation record as JSON", () => {
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
      readonly delegation: HeapAtRestDelegationRecord;
    };
    expect(emitted.budget.id).toBe(HEAP_AT_REST_BUDGET_ID);
    expect(emitted.budget.status).toBe("enforced");
    expect(emitted.delegation.status).toBe("measured-elsewhere");
    expect(emitted.delegation.limitCanonicalValue).toBe(SPEC_CEILING_BYTES);
  });
});
