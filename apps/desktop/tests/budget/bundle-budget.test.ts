// The renderer initial-graph budget gates.
//
// One walk of the built `out/renderer` tree, held against two rows of `budgets.json`:
// `renderer-initial-bundle` over the code it emits, gzipped (≤ 450 kB excluding lazy chunks),
// and `renderer-initial-fonts` over the font files on the same graph, raw. The split is a change
// of unit, not an exclusion.
//
// This test never skips itself: a gate that turns off when its subject is missing reports green
// for a bundle nobody measured. The Turbo task depends on `build`, so the build is present in CI
// and in `pnpm test`; a bare `vitest run` without one fails with the command that produces it.
// The measurer's refusals are in `scripts/budget/measure-bundle.test.ts`.

import process from "node:process";
import { describe, expect, it } from "vitest";

import { BudgetRegistry } from "../../scripts/budget/budget-registry.mjs";
import { evaluateBudget } from "../../scripts/budget/budget-evaluation.mjs";
import { formatUnavailableBudgetReport } from "../../scripts/budget/budget-report.mjs";
import { type Budget } from "../../scripts/budget/budget-document.mjs";
import {
  DEFAULT_RENDERER_OUTPUT_DIRECTORY,
  RENDERER_BUNDLE_GATES,
  RendererBundleMeasurer,
  RendererBundleOutputMissingError,
  type RendererBundleMeasurement,
} from "../../scripts/budget/measure-bundle.mjs";

const registry = BudgetRegistry.load();

/** Lets an out-of-tree build be measured; it is not a way to skip measuring. */
const rendererOutputDirectory: string =
  process.env["SIDEKICKS_BUDGET_RENDERER_OUT_DIR"] ?? DEFAULT_RENDERER_OUTPUT_DIRECTORY;

function measureOrFailLoudly(): RendererBundleMeasurement {
  try {
    return new RendererBundleMeasurer(rendererOutputDirectory).measure();
  } catch (measurementError) {
    if (measurementError instanceof RendererBundleOutputMissingError) {
      throw new Error(
        `${measurementError.message}\nThis gate fails rather than skips when its subject is ` +
          `missing. Budgets not gated at this revision, so the full set stays ` +
          `visible:\n\n${formatUnavailableBudgetReport(registry)}`,
        { cause: measurementError },
      );
    }
    throw measurementError;
  }
}

/** One walk, read by every gate below; two measurements could disagree. */
const measurement: RendererBundleMeasurement = measureOrFailLoudly();

describe("renderer initial-graph budgets", () => {
  const gateReadings = RENDERER_BUNDLE_GATES.map((gate) => {
    const budget: Budget = registry.requireBudget(gate.budgetId);
    return {
      budget,
      verdict: evaluateBudget(budget, gate.compare(measurement)),
      measuredDescription: gate.measuredDescription(measurement),
    };
  });

  it.each(gateReadings.map((gateReading) => [gateReading.budget.id, gateReading] as const))(
    "%s stays within its ceiling",
    (_budgetId, gateReading) => {
      expect(
        gateReading.verdict.withinBudget,
        `${gateReading.budget.label} is ` +
          `${gateReading.verdict.measuredCanonicalValue.toLocaleString("en-US")} B ` +
          `(${gateReading.measuredDescription}) against a ` +
          `${gateReading.verdict.limitCanonicalValue.toLocaleString("en-US")} B budget ` +
          `(${(gateReading.verdict.utilizationFraction * 100).toFixed(1)} % of budget). ` +
          "Move code behind a dynamic import so it lands in a lazy chunk, or drop a face — and " +
          "amend `budgets.json` only with the reasoning its row and `harnessBudgetDerivation` " +
          "already carry, since the registry mirrors its sources rather than setting them.",
      ).toBe(true);
    },
  );
});
