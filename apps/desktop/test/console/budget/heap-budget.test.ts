// The renderer heap-at-rest budget gate — Plan-023 Phase 1C (T-023p-1C-1).
//
// Gates `Spec-023 §Console Design (Meridian)` §Budgets row 3 (≤ 120 MB with one
// session open at rest) against a real `heapUsed` reading taken with a
// console-shaped workload retained. This measures a Node process against a
// reference store, not an Electron renderer against the console's own, so
// passing is necessary and not sufficient — the harness prints that limitation
// with every reading and this file asserts it rather than trusting goodwill.
//
// Two readings are taken, deliberately. In-process, Vitest gives the worker no
// `--expose-gc`, so nothing forces a collection and the figure is an UPPER
// bound: sound as a gate, but it cannot show what the workload costs. The
// harness's own CLI re-executes itself under `--expose-gc`; that reading is
// settled, and it is the only one where 2,000 retained entities must appear as
// a positive delta rather than as a coincidence between two unforced readings.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  ConsoleBudgetRegistry,
  evaluateBudget,
  type ConsoleBudgetVerdict,
} from "../../../scripts/budget/budget-registry.mjs";
import {
  CONSOLE_ENTITY_KINDS,
  ConsoleHeapAtRestMeasurer,
  HEAP_AT_REST_BUDGET_ID,
  HEAP_AT_REST_ENTITY_COUNT,
  ReferencePartitionedEntityStore,
  buildReferenceConsoleEntity,
  formatHeapAtRestReport,
  type HeapAtRestMeasurement,
} from "../../../scripts/budget/measure-heap.mjs";

const registry = ConsoleBudgetRegistry.load();
const budget = registry.requireBudget(HEAP_AT_REST_BUDGET_ID);

const HEAP_HARNESS_PATH = fileURLToPath(
  new URL("../../../scripts/budget/measure-heap.mts", import.meta.url),
);

/**
 * Runs the harness as the CLI does, so the reading comes back GC-settled. The
 * harness re-executes itself under `--expose-gc`; `stdio: "pipe"` chains through
 * that re-exec's inherited stdout, so the child's JSON is what we parse. The
 * `--experimental-strip-types` flag is what makes the TypeScript harness
 * loadable on the 22.14 floor this package declares.
 */
function measureThroughHarnessCli(entityCount: number): {
  readonly verdict: ConsoleBudgetVerdict;
  readonly measurement: HeapAtRestMeasurement;
} {
  const stdout = execFileSync(
    process.execPath,
    ["--experimental-strip-types", HEAP_HARNESS_PATH, "--json", `--entities=${entityCount}`],
    { encoding: "utf8", cwd: path.dirname(HEAP_HARNESS_PATH), maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as {
    verdict: ConsoleBudgetVerdict;
    measurement: HeapAtRestMeasurement;
  };
}

describe("renderer heap-at-rest budget", () => {
  it(`stays within ${budget.specTarget}`, { timeout: 60_000 }, async () => {
    const measurement = await new ConsoleHeapAtRestMeasurer().measure();
    const verdict = evaluateBudget(budget, measurement.atRestHeapUsedBytes);

    console.log(formatHeapAtRestReport(measurement, budget, verdict, registry));

    expect(measurement.entityCount).toBe(HEAP_AT_REST_ENTITY_COUNT);
    expect(measurement.partitionCount).toBe(CONSOLE_ENTITY_KINDS.length);
    expect(measurement.atRestHeapUsedBytes).toBeGreaterThan(0);
    expect(
      verdict.withinBudget,
      `Heap at rest is ${verdict.measuredCanonicalValue.toLocaleString("en-US")} B against a ` +
        `${verdict.limitCanonicalValue.toLocaleString("en-US")} B budget. This process measures a ` +
        "Node heap against a reference store, so an over-budget reading is a serious signal, not a marginal one.",
    ).toBe(true);
  });

  it(
    "takes a GC-settled reading through the harness CLI, where the workload's cost is visible",
    { timeout: 120_000 },
    () => {
      const { measurement, verdict } = measureThroughHarnessCli(HEAP_AT_REST_ENTITY_COUNT);

      // If this is false the re-exec silently fell through and the CLI's headline
      // reading is an upper bound rather than the settled one it advertises.
      expect(
        measurement.garbageCollectionForced,
        "The harness CLI did not obtain `--expose-gc`; its reading is not settled.",
      ).toBe(true);
      expect(measurement.limitations.join("\n")).not.toContain("UPPER bound");

      // The claim the in-process reading cannot make: across a forced collection,
      // a retained workload of this size is visible as growth, not noise.
      expect(measurement.workloadHeapDeltaBytes).toBeGreaterThan(0);
      expect(measurement.entityCount).toBe(HEAP_AT_REST_ENTITY_COUNT);
      expect(verdict.withinBudget).toBe(true);
    },
  );

  it("states what the reading does not prove, on every run", async () => {
    const measurement = await new ConsoleHeapAtRestMeasurer(64).measure();

    expect(measurement.limitations.length).toBeGreaterThanOrEqual(3);
    expect(measurement.limitations.join("\n")).toContain("not an Electron renderer");
    expect(measurement.limitations.join("\n")).toContain("T-023p-1C-2");

    // The un-forced-GC arm must announce itself, because that reading is an
    // upper bound rather than a settled one. Which arm runs depends on whether
    // the runner exposes `gc`, so both are covered rather than one assumed.
    const upperBoundNotice = measurement.limitations.some((limitation) =>
      limitation.includes("UPPER bound"),
    );
    expect(upperBoundNotice).toBe(!measurement.garbageCollectionForced);
  });
});

describe("the reference session workload", () => {
  it("spreads entities across every partition, retains all of them, and replaces on re-apply", () => {
    const store = new ReferencePartitionedEntityStore();
    const entityCount = CONSOLE_ENTITY_KINDS.length * 7;
    for (let ordinal = 0; ordinal < entityCount; ordinal += 1) {
      store.apply(buildReferenceConsoleEntity(ordinal));
    }
    expect(store.partitionCount).toBe(CONSOLE_ENTITY_KINDS.length);
    expect(store.entityCount).toBe(entityCount);

    store.apply(buildReferenceConsoleEntity(1));
    expect(store.entityCount, "a re-applied entity was duplicated").toBe(entityCount);
  });

  it("builds a deterministic entity for a given ordinal, so two runs measure the same graph", () => {
    expect(buildReferenceConsoleEntity(42)).toStrictEqual(buildReferenceConsoleEntity(42));
    expect(buildReferenceConsoleEntity(42).id).not.toBe(buildReferenceConsoleEntity(43).id);
  });
});
