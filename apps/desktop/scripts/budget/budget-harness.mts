// The shell both budget harnesses run inside — Plan-023 Phase 1C (T-023p-1C-1).
//
// A measuring harness owns its own reading and nothing else: this file owns the
// report skeleton every reading prints inside, and the mapping from a verdict to
// a process exit code. Two harnesses therefore cannot drift apart on how a
// budget verdict reads, or on what "over budget" exits with.
//
// Split from `budget-registry.mts`, which parses `budgets.json` and is a
// registry of budgets and nothing else. This module reads that one; nothing
// reads this one but the two harnesses.

import console from "node:console";

import {
  ConsoleBudgetRegistry,
  evaluateBudget,
  formatUnavailableBudgetReport,
  type ConsoleBudget,
  type ConsoleBudgetVerdict,
} from "./budget-registry.mts";

export function formatBytes(byteCount: number): string {
  return `${byteCount.toLocaleString("en-US")} B`;
}

/** Signed, for the headroom line — the one place a byte figure can go negative. */
function formatByteDelta(byteDelta: number): string {
  return `${byteDelta >= 0 ? "+" : "−"}${formatBytes(Math.abs(byteDelta))}`;
}

/** The two provenance lines every harness prints above its own reading. */
function formatBudgetRegistryHeaderLines(registry: ConsoleBudgetRegistry): readonly string[] {
  return [`  registry:      ${registry.budgetsFilePath}`, `  spec source:   ${registry.source}`];
}

/** The verdict block every harness prints below its own reading. */
function formatBudgetVerdictBlock(
  budget: ConsoleBudget,
  verdict: ConsoleBudgetVerdict,
  measuredDescription: string,
): readonly string[] {
  return [
    `Budget — ${budget.label}`,
    `  spec target:   ${budget.specTarget}`,
    `  limit:         ${formatBytes(verdict.limitCanonicalValue)} (${budget.limit.value} ${budget.limit.unit})`,
    `  measured:      ${formatBytes(verdict.measuredCanonicalValue)} — ${measuredDescription}`,
    `  headroom:      ${formatByteDelta(verdict.headroomCanonicalValue)}`,
    `  utilization:   ${(verdict.utilizationFraction * 100).toFixed(1)} % of budget`,
    `  verdict:       ${verdict.withinBudget ? "WITHIN BUDGET" : "OVER BUDGET"}`,
  ];
}

/** The parts of a budget report only the measuring harness can supply. */
interface BudgetReportSections {
  readonly title: string;
  /** Lines naming what was measured, printed under the registry's provenance. */
  readonly provenance: readonly string[];
  /** The harness's own readings. */
  readonly readings: readonly string[];
  /** What the compared figure is a figure of, for the verdict line. */
  readonly measuredDescription: string;
}

/** The skeleton every budget report prints, so two harnesses cannot drift apart. */
export function formatBudgetReport(
  sections: BudgetReportSections,
  budget: ConsoleBudget,
  verdict: ConsoleBudgetVerdict,
  registry: ConsoleBudgetRegistry,
): string {
  return [
    sections.title,
    ...formatBudgetRegistryHeaderLines(registry),
    ...sections.provenance,
    "",
    ...sections.readings,
    "",
    ...formatBudgetVerdictBlock(budget, verdict, sections.measuredDescription),
    "",
    formatUnavailableBudgetReport(registry),
  ].join("\n");
}

/**
 * Thrown by a harness whose subject does not exist — no build to measure. The
 * shell prints it and exits 2, so a budget is never reported green for a
 * subject nobody read.
 */
export class BudgetSubjectMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetSubjectMissingError";
  }
}

interface BudgetHarness<TMeasurement> {
  readonly budgetId: string;
  /** @throws {BudgetSubjectMissingError} when there is nothing to measure. */
  readonly measure: () => TMeasurement | Promise<TMeasurement>;
  /** The figure compared against the budget's canonical limit. */
  readonly compare: (measurement: TMeasurement) => number;
  readonly format: (
    measurement: TMeasurement,
    budget: ConsoleBudget,
    verdict: ConsoleBudgetVerdict,
    registry: ConsoleBudgetRegistry,
  ) => string;
  readonly emitJson: boolean;
}

/**
 * The tail both budget CLIs share: resolve the row, take the reading, print it,
 * and map the outcome to the exit code — 0 within budget, 1 over, 2 when there
 * was nothing to read. A harness's own usage errors are its own exit 2, raised
 * before this is reached.
 */
export async function runBudgetHarness<TMeasurement>(
  harness: BudgetHarness<TMeasurement>,
): Promise<number> {
  const registry = ConsoleBudgetRegistry.load();
  const budget = registry.requireBudget(harness.budgetId);

  let measurement: TMeasurement;
  try {
    measurement = await harness.measure();
  } catch (measurementError) {
    if (measurementError instanceof BudgetSubjectMissingError) {
      console.error(measurementError.message);
      console.error(formatUnavailableBudgetReport(registry));
      return 2;
    }
    throw measurementError;
  }

  const verdict = evaluateBudget(budget, harness.compare(measurement));
  console.log(
    harness.emitJson
      ? JSON.stringify({ budget, verdict, measurement }, null, 2)
      : harness.format(measurement, budget, verdict, registry),
  );
  return verdict.withinBudget ? 0 : 1;
}
