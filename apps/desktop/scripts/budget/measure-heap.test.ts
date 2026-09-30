// Pins what this tier can see of the heap-at-rest row: it is gated, names the endurance harness
// that reads a renderer heap, and keeps its ceiling. The budget CLI prints a `MEASURED ELSEWHERE`
// verdict and exits 0, and refuses with exit 2 if the row is re-pointed at the CLI, a Node process
// with no renderer. That refusal is the negative control: a gate reading this process's heap would
// stay green with the shipped renderer far over the limit.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { BudgetRegistry } from "./budget-registry.mjs";
import { type Budget } from "./budget-document.mjs";
import {
  HeapAtRestGate,
  HEAP_AT_REST_BUDGET_ID,
  HeapAtRestMeasurerMisattributedError,
  runHeapBudgetCommand,
  type HeapAtRestDelegationRecord,
} from "./measure-heap.mjs";
import { TemporaryDirectoryTrail } from "../../tests/helpers/temporary-directory.js";

const registry = BudgetRegistry.load();
const budget = registry.requireBudget(HEAP_AT_REST_BUDGET_ID);

const HEAP_HARNESS_PATH = fileURLToPath(new URL("./measure-heap.mts", import.meta.url));

/** The spec's own figure, restated so an edit to the ceiling fails here. */
const SPEC_CEILING_BYTES = 120_000_000;

/** The harness the row must NOT name, and the one the refusal below is about. */
const NODE_CLI_HARNESS_PATH = "apps/desktop/scripts/budget/measure-heap.mts";

/** The harness the row does name — the tier that holds a renderer. */
const ENDURANCE_HARNESS_PATH = "apps/desktop/tests/endurance/heap-at-rest.test.ts";

/** The fixture tree the misattribution case plants, removed after it. */
const plantedFixtures = new TemporaryDirectoryTrail();

afterEach(() => {
  plantedFixtures.removeAll();
});

/**
 * The registry as it would read if someone re-pointed this budget at the CLI. Built by rewriting
 * the real file, so the fixture cannot drift into a shape the loader rejects for another reason.
 */
function registryClaimingTheNodeCliMeasuresTheHeap(): BudgetRegistry {
  const document = JSON.parse(readFileSync(registry.budgetsFilePath, "utf8")) as {
    readonly budgets: readonly Record<string, unknown>[];
  };
  const budgets = document.budgets.map((entry) =>
    entry["id"] === HEAP_AT_REST_BUDGET_ID
      ? { ...entry, status: "enforced", measuredBy: NODE_CLI_HARNESS_PATH }
      : entry,
  );
  const directory = plantedFixtures.create("console-heap-budget-");
  const fixturePath = path.join(directory, "budgets.json");
  writeFileSync(fixturePath, JSON.stringify({ ...document, budgets }), "utf8");
  return BudgetRegistry.load(fixturePath);
}

describe("the renderer heap-at-rest budget row", () => {
  it("is recorded gated, and names the harness that holds a renderer", () => {
    expect(budget.status).toBe("enforced");
    expect(budget.measuredBy).toBe(ENDURANCE_HARNESS_PATH);
    expect(budget.notMeasurableReason).toBeNull();
  });

  it("keeps the spec's ceiling, so a re-pointed reading never relaxes the budget", () => {
    expect(budget.limit.canonicalValue).toBe(SPEC_CEILING_BYTES);
    expect(budget.limit.canonicalUnit).toBe("bytes");
    expect(budget.specTarget).toBe("≤ 120 MB");
  });
});

describe("the heap budget CLI's delegation", () => {
  it("reports MEASURED ELSEWHERE with the ceiling and the harness, and no verdict over a figure", () => {
    const report = new HeapAtRestGate(registry).report();
    console.log(report);

    expect(report).toContain("MEASURED ELSEWHERE");
    expect(report).toContain(ENDURANCE_HARNESS_PATH);
    expect(report).toContain(SPEC_CEILING_BYTES.toLocaleString("en-US"));
    // Either verdict would be a comparison against a figure this process never took.
    expect(report).not.toContain("WITHIN BUDGET");
    expect(report).not.toContain("OVER BUDGET");
  });

  it("emits a discriminable delegation record rather than a verdict", () => {
    const record = new HeapAtRestGate(registry).record();
    expect(record).toStrictEqual({
      budgetId: HEAP_AT_REST_BUDGET_ID,
      status: "measured-elsewhere",
      measuredBy: ENDURANCE_HARNESS_PATH,
      limitCanonicalValue: SPEC_CEILING_BYTES,
      canonicalUnit: "bytes",
    } satisfies HeapAtRestDelegationRecord);
  });

  // The negative control: the gate must tell "measured where a renderer lives" from "measured
  // here", on the known-bad input where the row names the Node process.
  it("refuses a registry that names this Node harness as the measurer", () => {
    const misattributedRegistry = registryClaimingTheNodeCliMeasuresTheHeap();
    const gate = new HeapAtRestGate(misattributedRegistry);

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
      readonly budget: Budget;
      readonly delegation: HeapAtRestDelegationRecord;
    };
    expect(emitted.budget.id).toBe(HEAP_AT_REST_BUDGET_ID);
    expect(emitted.budget.status).toBe("enforced");
    expect(emitted.delegation.status).toBe("measured-elsewhere");
    expect(emitted.delegation.limitCanonicalValue).toBe(SPEC_CEILING_BYTES);
  });
});
