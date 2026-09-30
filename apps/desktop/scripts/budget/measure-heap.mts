#!/usr/bin/env node
// Renderer heap-at-rest budget. This file measures nothing, on purpose: the subject is a renderer
// heap, and a Node process holds no Chromium, renderer isolate, React or DOM. `pnpm budget:heap`
// reports which harness holds the reading instead: `tests/endurance/heap-at-rest.test.ts`, which
// launches the built app, opens the concurrent-streaming scenario's session, and reads the
// renderer's own heap.
//
// The one behavior kept here is the refusal: if the registry names this harness as the row's
// measurer, no code here can honor that, so it exits 2 rather than print a report over a figure
// nobody took.
//
//   node --experimental-strip-types scripts/budget/measure-heap.mts [--json]
//
// Exit: 0 when the registry points the reading somewhere else and says where · 2 on
// bad usage, or when the registry names this harness as the measurer. There is no
// exit 1: no reading is taken here, so nothing can be over budget.

import process from "node:process";
import console from "node:console";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";

import { BudgetRegistry } from "./budget-registry.mts";
import { formatUnavailableBudgetReport } from "./budget-report.mts";
import { type Budget } from "./budget-document.mts";
import { BudgetSubjectMissingError, formatBytes } from "./budget-harness.mts";

/** Registry id of the heap-at-rest row. */
export const HEAP_AT_REST_BUDGET_ID: string = "renderer-heap-at-rest";

/**
 * The repo-relative path of this harness as the registry would spell it. It is compared with the
 * row's `measuredBy`, so the refusal is about this file and not about every non-null value.
 */
const THIS_HARNESS_PATH: string = "apps/desktop/scripts/budget/measure-heap.mts";

/**
 * Thrown when the registry names this harness as the row's measurer. It is a
 * `BudgetSubjectMissingError`: the subject does not exist in this process, and the message names
 * what holds it. Without it, re-pointing the row here would let the CLI exit 0 over a gate no code
 * here performs.
 */
export class HeapAtRestMeasurerMisattributedError extends BudgetSubjectMissingError {
  public constructor(budget: Budget) {
    super(
      `The budget registry names \`${THIS_HARNESS_PATH}\` as the measurer of ` +
        `\`${budget.id}\`, and nothing in this process can take that reading.\n` +
        "The figure this budget bounds is a renderer heap with one session open. This is a Node " +
        "process: no Chromium, no renderer isolate, no React, no DOM, no console store. The " +
        "reading belongs to the endurance tier, which launches the built console — see " +
        "`apps/desktop/tests/endurance/heap-at-rest.test.ts`.\n",
    );
    this.name = "HeapAtRestMeasurerMisattributedError";
  }
}

/** What a `--json` run emits in place of a measurement and a verdict. */
export interface HeapAtRestDelegationRecord {
  readonly budgetId: string;
  /** Literal, so a consumer can discriminate this from a verdict without guessing. */
  readonly status: "measured-elsewhere";
  /** The harness the registry names, verbatim. */
  readonly measuredBy: string;
  readonly limitCanonicalValue: number;
  readonly canonicalUnit: string;
}

/**
 * The heap budget's row, and the one thing this process can say about it: which harness takes the
 * reading. The registry is injected so the refusal arm is reachable from a test against a fixture
 * registry.
 */
export class HeapAtRestGate {
  readonly #registry: BudgetRegistry;
  readonly #budget: Budget;

  public constructor(registry: BudgetRegistry = BudgetRegistry.load()) {
    this.#registry = registry;
    this.#budget = registry.requireBudget(HEAP_AT_REST_BUDGET_ID);
  }

  public get budget(): Budget {
    return this.#budget;
  }

  /** @throws {HeapAtRestMeasurerMisattributedError} when the row names this file. */
  #requireMeasurerElsewhere(): string {
    const measuredBy = this.#budget.measuredBy;
    if (measuredBy === THIS_HARNESS_PATH) {
      throw new HeapAtRestMeasurerMisattributedError(this.#budget);
    }
    // An `n/a` row carries no measurer, so its reason is reported instead of leaving the reader to
    // guess where a reading went.
    return measuredBy ?? `— none; ${this.#budget.notMeasurableReason ?? "no reason recorded"}`;
  }

  /** @throws {HeapAtRestMeasurerMisattributedError} when the row names this file. */
  public record(): HeapAtRestDelegationRecord {
    return Object.freeze({
      budgetId: this.#budget.id,
      status: "measured-elsewhere",
      measuredBy: this.#requireMeasurerElsewhere(),
      limitCanonicalValue: this.#budget.limit.canonicalValue,
      canonicalUnit: this.#budget.limit.canonicalUnit,
    });
  }

  /**
   * The report a person reads. Not built through `formatBudgetReport`, whose skeleton assumes a
   * verdict over a measured figure; the verdict line keeps its position and names the harness that
   * does compare.
   *
   * @throws {HeapAtRestMeasurerMisattributedError} when the row names this file.
   */
  public report(): string {
    const budget = this.#budget;
    return [
      "Renderer heap-at-rest budget",
      // The row's own id: a gated row is absent from the ungated block below, so the report would
      // otherwise stop naming its budget.
      `  budget id:     ${this.#budget.id}`,
      `  registry:      ${this.#registry.budgetsFilePath}`,
      `  subject:       ${budget.subject}`,
      "",
      "Reading — none taken here. This harness measures nothing, by design: the figure",
      "this budget bounds is a renderer heap, and no process here holds one.",
      "",
      `Budget — ${budget.label}`,
      `  spec target:   ${budget.specTarget}`,
      `  limit:         ${formatBytes(budget.limit.canonicalValue)} (${budget.limit.value} ${budget.limit.unit})`,
      "  measured:      — nothing measured here, so there is no figure to compare",
      "  verdict:       MEASURED ELSEWHERE",
      `  measured by:   ${this.#requireMeasurerElsewhere()}`,
      "",
      formatUnavailableBudgetReport(this.#registry),
    ].join("\n");
  }
}

const USAGE = `measure-heap.mts — renderer heap-at-rest budget

  --json             emit the budget row and its delegation record as JSON on stdout
  -h, --help         this text

This budget's reading is the endurance tier's; nothing is measured in this process.
exit 0 measured elsewhere · 2 bad usage, or the registry names this harness as the measurer`;

/**
 * CLI entry point; returns the process exit code. The registry is a parameter so a test can drive
 * the exit-2 arm.
 */
export function runHeapBudgetCommand(
  argumentList: readonly string[],
  registry?: BudgetRegistry,
): number {
  let values: { json?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argumentList],
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (usageError) {
    console.error(usageError instanceof Error ? usageError.message : String(usageError));
    console.error(USAGE);
    return 2;
  }

  if (values.help === true) {
    console.log(USAGE);
    return 0;
  }

  const resolvedRegistry = registry ?? BudgetRegistry.load();
  const gate = new HeapAtRestGate(resolvedRegistry);
  try {
    console.log(
      values.json === true
        ? JSON.stringify({ budget: gate.budget, delegation: gate.record() }, null, 2)
        : gate.report(),
    );
  } catch (gateError) {
    if (gateError instanceof BudgetSubjectMissingError) {
      // Same shape `runBudgetHarness` gives a missing subject: name what is absent, then reprint
      // the ungated set.
      console.error(gateError.message);
      console.error(formatUnavailableBudgetReport(resolvedRegistry));
      return 2;
    }
    throw gateError;
  }
  return 0;
}

// CLI only when this file is the entry point, so Vitest can import it without side effects. Both
// sides go through `realpathSync`: Node resolves the module URL through symlinks while argv[1]
// keeps the path as typed, so the naive comparison silently no-ops through a symlinked or spaced
// checkout and exits 0 over an unrun gate (`tools/__tests__/entry-guard.test.mjs` pins this).
const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = runHeapBudgetCommand(process.argv.slice(2));
}
