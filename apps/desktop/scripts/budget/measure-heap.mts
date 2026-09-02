#!/usr/bin/env node
// Renderer heap-at-rest budget — Plan-023 Phase 1C (T-023p-1C-1).
//
// This budget is NOT gated at this revision, and this file is where a person who
// runs `pnpm budget:heap` is told so by name, with the reason and the task that
// lifts it, rather than being handed a green verdict nobody measured.
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
// WHY IT IS RECORDED UNGATED RATHER THAN RE-AIMED AT THE BUILT RENDERER
//
// `Spec-023 §Console Design (Meridian)` §Budgets bounds "renderer heap, ONE
// SESSION OPEN at rest" at 120 MB, and that subject is out of reach here:
//
//   • **No session has content.** A session route opens a real `SessionStore`,
//     and nothing delivers events into it — the session-read wire is a
//     `Plan-023 §Console growth slate` row the growth port refuses, and the
//     ledger surface that would render a timeline is T-023p-1C-2's. A reading
//     over an empty session measures the substrate, not this budget's subject.
//   • **The flagship scenario has neither a consumer nor a selector.** The
//     renderer root mounts the console with no scenario, so a fixture build
//     plays the first-run scenario; a runtime switch is one of the architecture
//     tier's static tripwires, and the scenario picker is T-023p-1C-8's.
//
// So the honest renderer reading is the endurance tier's — taken over CDP
// against the built console, which is where `Spec-023 §Console Test Tiers` puts
// heap snapshots — and `budgets.json` records this row against the task that
// takes it. Every harness prints one line per ungated budget, so the row stays
// visible instead of vanishing.
//
//   node --experimental-strip-types scripts/budget/measure-heap.mts [--json]
//
// Exit: 0 when the registry declares this budget ungated and says why · 2 on bad
// usage, or when the registry claims the budget IS gated, which nothing here can
// honour. There is deliberately no exit 1 at this revision: no reading is taken,
// so nothing can be over budget. It returns when the reading does.

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
 * Thrown when the registry says this budget is gated and this harness has no
 * reading to gate it with.
 *
 * A `BudgetSubjectMissingError`, on the same reasoning its sibling
 * `RendererBundleOutputMissingError` carries: the subject a verdict would be
 * about does not exist, and the refusal names what produces it. The day someone
 * flips the row back to `enforced` — the obvious way to "fix" a budget that
 * reports nothing — this fires instead of letting the CLI exit 0 over a row that
 * now claims a gate no code performs.
 */
export class HeapAtRestMeasurementMissingError extends BudgetSubjectMissingError {
  public constructor(budget: ConsoleBudget) {
    super(
      `The budget registry marks \`${budget.id}\` as \`${budget.status}\`, but nothing measures it ` +
        "at this revision.\n" +
        "The reading this budget wants is a renderer heap read over CDP against the built console " +
        `with one session open, which is ${budget.producedBy}'s. Until it is taken, this row stays ` +
        "`n/a` with its `notMeasurableReason` — a gate reported green over a renderer nobody read " +
        "is worse than a recorded absence.\n",
    );
    this.name = "HeapAtRestMeasurementMissingError";
  }
}

/** What a `--json` run emits where a measurement and a verdict used to go. */
export interface HeapAtRestUnenforcedRecord {
  readonly budgetId: string;
  /** Literal, so a consumer can discriminate this from a verdict without guessing. */
  readonly status: "unenforced";
  /** The registry's own `notMeasurableReason`, verbatim. */
  readonly reason: string;
  /** The Plan-023 task that takes the reading. */
  readonly producedBy: string;
  readonly limitCanonicalValue: number;
  readonly canonicalUnit: string;
}

/**
 * The heap budget's row, and the two things this revision can honestly say about
 * it: that it is ungated, and why.
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

  /** @throws {HeapAtRestMeasurementMissingError} when the row claims a gate. */
  #requireRecordedReason(): string {
    const reason = this.#budget.notMeasurableReason;
    if (this.#budget.status !== "n/a" || reason === null) {
      throw new HeapAtRestMeasurementMissingError(this.#budget);
    }
    return reason;
  }

  /** @throws {HeapAtRestMeasurementMissingError} when the row claims a gate. */
  public record(): HeapAtRestUnenforcedRecord {
    return Object.freeze({
      budgetId: this.#budget.id,
      status: "unenforced",
      reason: this.#requireRecordedReason(),
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
   * does, and reads `UNENFORCED` rather than a comparison of nothing.
   *
   * @throws {HeapAtRestMeasurementMissingError} when the row claims a gate.
   */
  public report(): string {
    const budget = this.#budget;
    return [
      "Renderer heap-at-rest budget — Plan-023 T-023p-1C-1",
      `  registry:      ${this.#registry.budgetsFilePath}`,
      `  spec source:   ${this.#registry.source}`,
      `  subject:       ${budget.subject}`,
      "",
      "Reading — none taken. This harness measures nothing, by design: the figure this",
      "budget bounds is a renderer heap, and no process here holds one.",
      "",
      `Budget — ${budget.label}`,
      `  spec target:   ${budget.specTarget}`,
      `  limit:         ${formatBytes(budget.limit.canonicalValue)} (${budget.limit.value} ${budget.limit.unit})`,
      "  measured:      — nothing measured, so there is no figure to compare",
      "  verdict:       UNENFORCED",
      `  produced by:   ${budget.producedBy}`,
      `  reason:        ${this.#requireRecordedReason()}`,
      "",
      formatUnavailableBudgetReport(this.#registry),
    ].join("\n");
  }
}

const USAGE = `measure-heap.mts — renderer heap-at-rest budget (Plan-023 T-023p-1C-1)

  --json             emit the budget row and its ungated record as JSON on stdout
  -h, --help         this text

This budget is not gated at this revision; the reading is the endurance tier's.
exit 0 declared ungated · 2 bad usage, or the registry claims a gate nothing here performs`;

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
        ? JSON.stringify({ budget: gate.budget, unenforced: gate.record() }, null, 2)
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
