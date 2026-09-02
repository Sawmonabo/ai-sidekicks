#!/usr/bin/env node
// Renderer heap-at-rest budget — Plan-023 Phase 1C (T-023p-1C-1).
//
// This file measures nothing, and that is its whole point. The budget's subject
// is a RENDERER heap, and a person who runs `pnpm budget:heap` is told here which
// harness holds one rather than being handed a figure from a process that does
// not.
//
// WHAT THIS FILE USED TO DO, AND WHY IT NO LONGER DOES IT
//
// It read `process.memoryUsage().heapUsed` in THIS Node process with a stand-in
// entity map retained, and compared that figure against the 120 MB renderer
// ceiling. No Chromium, no V8 renderer isolate, no React, no DOM, no console
// store — so the reading was short of the shipped renderer by everything that
// makes a renderer, and the gate could report green over a renderer that was
// well past the limit. A gate that cannot fail for the reason it exists is worse
// than a recorded absence, so the reading is deleted rather than re-pointed.
//
// WHERE THE READING LIVES INSTEAD
//
// `apps/desktop/test/console/endurance/heap-at-rest.test.ts`, which is what the
// registry row names. `Spec-023 §Console Test Tiers` puts heap readings on the
// endurance tier, and that tier launches the built console in the Electron shell:
// it opens the flagship scenario's own session, walks the frozen clock over the
// whole script so the session has content, asserts the store admitted it through
// a live subscription, and reads the renderer's own heap. Every condition in the
// budget's subject — one session open, with content, at rest — is established
// there and none of them can be established here.
//
// So the one behaviour worth keeping in this file is the refusal: if the registry
// ever names THIS harness as the row's measurer, that is a claim no code here can
// honour, and it exits 2 rather than printing a report over a figure nobody took.
//
//   node --experimental-strip-types scripts/budget/measure-heap.mts [--json]
//
// Exit: 0 when the registry points the reading somewhere else and says where · 2
// on bad usage, or when the registry names this harness as the measurer. There is
// deliberately no exit 1: no reading is taken here, so nothing can be over budget.

import process from "node:process";
import console from "node:console";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  ConsoleBudgetRegistry,
  formatUnavailableBudgetReport,
  type ConsoleBudget,
} from "./budget-registry.mts";
import { BudgetSubjectMissingError, formatBytes } from "./budget-harness.mts";

export const HEAP_AT_REST_BUDGET_ID: string = "renderer-heap-at-rest";

/**
 * The repo-relative path of this harness, as the registry would spell it.
 *
 * Compared against the row's `measuredBy` rather than assumed absent, so the
 * refusal below is a claim about THIS file and not about every non-null value.
 */
const THIS_HARNESS_PATH: string = "apps/desktop/scripts/budget/measure-heap.mts";

/**
 * Thrown when the registry names this harness as the row's measurer.
 *
 * A `BudgetSubjectMissingError`, on the same reasoning its sibling
 * `RendererBundleOutputMissingError` carries: the subject a verdict would be
 * about does not exist in this process, and the refusal names what does hold it.
 * The day someone re-points the row back at this file — the obvious way to "fix"
 * a budget whose reading is somewhere less convenient — this fires instead of
 * letting the CLI exit 0 over a gate no code here performs.
 */
export class HeapAtRestMeasurerMisattributedError extends BudgetSubjectMissingError {
  public constructor(budget: ConsoleBudget) {
    super(
      `The budget registry names \`${THIS_HARNESS_PATH}\` as the measurer of ` +
        `\`${budget.id}\`, and nothing in this process can take that reading.\n` +
        "The figure this budget bounds is a renderer heap with one session open. This is a Node " +
        "process: no Chromium, no renderer isolate, no React, no DOM, no console store. The " +
        "reading belongs to the endurance tier, which launches the built console — see " +
        "`apps/desktop/test/console/endurance/heap-at-rest.test.ts`.\n",
    );
    this.name = "HeapAtRestMeasurerMisattributedError";
  }
}

/** What a `--json` run emits where a measurement and a verdict used to go. */
export interface HeapAtRestDelegationRecord {
  readonly budgetId: string;
  /** Literal, so a consumer can discriminate this from a verdict without guessing. */
  readonly status: "measured-elsewhere";
  /** The harness the registry names, verbatim. */
  readonly measuredBy: string;
  /** The Plan-023 task that took the reading. */
  readonly producedBy: string;
  readonly limitCanonicalValue: number;
  readonly canonicalUnit: string;
}

/**
 * The heap budget's row, and the one thing this process can honestly say about
 * it: which harness takes the reading.
 *
 * The registry is injected rather than loaded at every call site so the refusal
 * arm above is reachable from a test against a fixture registry. Its default is
 * the one file every harness reads.
 */
export class ConsoleHeapAtRestGate {
  readonly #registry: ConsoleBudgetRegistry;
  readonly #budget: ConsoleBudget;

  public constructor(registry: ConsoleBudgetRegistry = ConsoleBudgetRegistry.load()) {
    this.#registry = registry;
    this.#budget = registry.requireBudget(HEAP_AT_REST_BUDGET_ID);
  }

  public get budget(): ConsoleBudget {
    return this.#budget;
  }

  /** @throws {HeapAtRestMeasurerMisattributedError} when the row names this file. */
  #requireMeasurerElsewhere(): string {
    const measuredBy = this.#budget.measuredBy;
    if (measuredBy === THIS_HARNESS_PATH) {
      throw new HeapAtRestMeasurerMisattributedError(this.#budget);
    }
    // An `n/a` row carries no measurer at all, which is the registry's own
    // consistency rule rather than this file's. Reported as the row's reason so
    // a reader of this report is not left to guess where a reading went.
    return measuredBy ?? `— none; ${this.#budget.notMeasurableReason ?? "no reason recorded"}`;
  }

  /** @throws {HeapAtRestMeasurerMisattributedError} when the row names this file. */
  public record(): HeapAtRestDelegationRecord {
    return Object.freeze({
      budgetId: this.#budget.id,
      status: "measured-elsewhere",
      measuredBy: this.#requireMeasurerElsewhere(),
      producedBy: this.#budget.producedBy,
      limitCanonicalValue: this.#budget.limit.canonicalValue,
      canonicalUnit: this.#budget.limit.canonicalUnit,
    });
  }

  /**
   * The report a person reads.
   *
   * Not composed through `formatBudgetReport`: that skeleton is built around a
   * verdict over a measured figure, and there is no figure here. The verdict line
   * keeps its position and its label so a reader's eye lands where it always
   * does, and names the harness that does compare rather than a comparison of
   * nothing.
   *
   * @throws {HeapAtRestMeasurerMisattributedError} when the row names this file.
   */
  public report(): string {
    const budget = this.#budget;
    return [
      "Renderer heap-at-rest budget — Plan-023 T-023p-1C-1",
      // The row's own id, printed rather than left to the reader to infer from
      // the heading. It used to reach this report only through the ungated block
      // below, which a gated row is correctly absent from — so a report about a
      // budget stopped naming it exactly when the budget started being enforced.
      `  budget id:     ${this.#budget.id}`,
      `  registry:      ${this.#registry.budgetsFilePath}`,
      `  spec source:   ${this.#registry.source}`,
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
      `  produced by:   ${budget.producedBy}`,
      `  measured by:   ${this.#requireMeasurerElsewhere()}`,
      "",
      formatUnavailableBudgetReport(this.#registry),
    ].join("\n");
  }
}

const USAGE = `measure-heap.mts — renderer heap-at-rest budget (Plan-023 T-023p-1C-1)

  --json             emit the budget row and its delegation record as JSON on stdout
  -h, --help         this text

This budget's reading is the endurance tier's; nothing is measured in this process.
exit 0 measured elsewhere · 2 bad usage, or the registry names this harness as the measurer`;

/**
 * CLI entry point; returns the process exit code.
 *
 * The registry is a parameter for the same reason the gate takes one: the exit-2
 * arm is a claim about behaviour, and a claim no test can drive is a claim
 * rather than evidence.
 */
export function runHeapBudgetCommand(
  argumentList: readonly string[],
  registry?: ConsoleBudgetRegistry,
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

  const resolvedRegistry = registry ?? ConsoleBudgetRegistry.load();
  const gate = new ConsoleHeapAtRestGate(resolvedRegistry);
  try {
    console.log(
      values.json === true
        ? JSON.stringify({ budget: gate.budget, delegation: gate.record() }, null, 2)
        : gate.report(),
    );
  } catch (gateError) {
    if (gateError instanceof BudgetSubjectMissingError) {
      // Same shape `runBudgetHarness` gives a missing subject: say what is
      // absent, then reprint the ungated set so the refusal does not shrink the
      // report to one line about one row.
      console.error(gateError.message);
      console.error(formatUnavailableBudgetReport(resolvedRegistry));
      return 2;
    }
    throw gateError;
  }
  return 0;
}

// CLI only when this file is the entry point, so the Vitest project can import
// it without side effects.
// Compared through `realpathSync` on BOTH sides, never `import.meta.url ===
// pathToFileURL(argv[1])`: Node resolves the module URL through symlinks while
// argv[1] keeps the path as typed, so the naive form silently no-ops through a
// symlinked or spaced checkout and exits 0 over an unrun budget gate
// (`tools/__tests__/entry-guard.test.mjs` pins exactly this).
const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = runHeapBudgetCommand(process.argv.slice(2));
}
