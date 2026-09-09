// The shell both budget harnesses run inside — Plan-023 Phase 1C (T-023p-1C-1).
//
// A measuring harness owns its own reading and nothing else: this file owns the
// report skeleton every reading prints inside, and the mapping from a verdict to
// a process exit code. Two harnesses therefore cannot drift apart on how a
// budget verdict reads, or on what "over budget" exits with.
//
// ONE MEASUREMENT, N GATES. A harness declares a list of gates rather than a
// single budget id, because one walk of one subject can answer more than one row
// and re-walking it per row is both slower and a second reading that can disagree
// with the first. The renderer bundle is the case that forced it: its initial
// graph carries two classes of byte measured in two units — compressed code
// against `renderer-initial-bundle`, raw font files against `renderer-initial-fonts`
// — and gzip over a `woff2` is not a measurement of anything, since the container
// is Brotli-compressed already. A harness bounding one row passes a one-gate list.
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

/** One gate, resolved against the registry and evaluated against a reading. */
export interface BudgetGateReading {
  readonly budget: ConsoleBudget;
  readonly verdict: ConsoleBudgetVerdict;
  /** What the compared figure is a figure of, for the verdict line. */
  readonly measuredDescription: string;
}

/** The verdict block every harness prints below its own reading, one per gate. */
function formatBudgetVerdictBlock(gateReading: BudgetGateReading): readonly string[] {
  const { budget, verdict } = gateReading;
  return [
    `Budget — ${budget.label}`,
    `  spec target:   ${budget.specTarget}`,
    `  limit:         ${formatBytes(verdict.limitCanonicalValue)} (${budget.limit.value} ${budget.limit.unit})`,
    `  measured:      ${formatBytes(verdict.measuredCanonicalValue)} — ${gateReading.measuredDescription}`,
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
}

/** The skeleton every budget report prints, so two harnesses cannot drift apart. */
export function formatBudgetReport(
  sections: BudgetReportSections,
  gateReadings: readonly BudgetGateReading[],
  registry: ConsoleBudgetRegistry,
): string {
  return [
    sections.title,
    ...formatBudgetRegistryHeaderLines(registry),
    ...sections.provenance,
    "",
    ...sections.readings,
    ...gateReadings.flatMap((gateReading) => ["", ...formatBudgetVerdictBlock(gateReading)]),
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

/** One row a harness gates, and the figure it reads off its own measurement. */
export interface BudgetGate<TMeasurement> {
  readonly budgetId: string;
  /** The figure compared against that row's canonical limit. */
  readonly compare: (measurement: TMeasurement) => number;
  /** What the compared figure is a figure of, for the verdict line. */
  readonly measuredDescription: (measurement: TMeasurement) => string;
}

/** A gate paired with the row it named, so no later step re-looks one up by index. */
interface ResolvedBudgetGate<TMeasurement> {
  readonly gate: BudgetGate<TMeasurement>;
  readonly budget: ConsoleBudget;
}

interface BudgetHarness<TMeasurement> {
  /** Every row this one reading is held against; at least one. */
  readonly gates: readonly BudgetGate<TMeasurement>[];
  /** @throws {BudgetSubjectMissingError} when there is nothing to measure. */
  readonly measure: () => TMeasurement | Promise<TMeasurement>;
  readonly format: (
    measurement: TMeasurement,
    gateReadings: readonly BudgetGateReading[],
    registry: ConsoleBudgetRegistry,
  ) => string;
}

/**
 * The tail both budget CLIs share: resolve every row, take the one reading,
 * print it, and map the outcome to the exit code — 0 within budget, 1 over, 2
 * when there was nothing to read. A harness's own usage errors are its own exit
 * 2, raised before this is reached.
 *
 * Every row is resolved BEFORE the subject is measured, so an id no registry row
 * carries refuses at once rather than after the walk; and every gate is evaluated
 * even once one is over, so a run reports the whole picture rather than the first
 * failure.
 */
export async function runBudgetHarness<TMeasurement>(
  harness: BudgetHarness<TMeasurement>,
): Promise<number> {
  const registry = ConsoleBudgetRegistry.load();
  if (harness.gates.length === 0) {
    // `every` over an empty list is true, so a gate-less harness would print a
    // reading and exit 0 having compared it against nothing.
    throw new Error("A budget harness must declare at least one gate.");
  }
  const resolvedGates: readonly ResolvedBudgetGate<TMeasurement>[] = harness.gates.map((gate) => ({
    gate,
    budget: registry.requireBudget(gate.budgetId),
  }));

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

  const gateReadings: readonly BudgetGateReading[] = resolvedGates.map(({ gate, budget }) => ({
    budget,
    verdict: evaluateBudget(budget, gate.compare(measurement)),
    measuredDescription: gate.measuredDescription(measurement),
  }));
  console.log(harness.format(measurement, gateReadings, registry));
  return gateReadings.every((gateReading) => gateReading.verdict.withinBudget) ? 0 : 1;
}
