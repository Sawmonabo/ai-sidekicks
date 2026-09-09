// The two halves of every growth-operation row, held against each other.
//
// A row's `slateRow` and the sentence describing it live in two declarations now, so
// that the half no running console reads stays off the initial import graph. The
// compiler already pairs them — each plane's summary table is a `Record` over the same
// closed id set its entry table is keyed by, and the composition is annotated over the
// whole union — and what a compile error cannot say is what a reader of the plan needs:
// that every operation's sentence is actually there and actually says something. So the
// checks below read both halves and compare them, with a holed copy as the control that
// they can fail.
//
// THE SHAPE IS `growth-slate-consumers.test.ts`'S, for the split it is the same split
// as. Read that file for the rule; this one applies it to the operations ledger.

import { describe, expect, it } from "vitest";

import type { GrowthOperationId } from "../growth-port/growth-entry.js";
import { GROWTH_OPERATIONS, growthOperationSummaries } from "./index.js";

/**
 * Which operation ids the summary table does not answer for, over any candidate table.
 *
 * Takes the table as an argument rather than reading the composition directly, so the
 * same reading answers for the real table and for the holed copy the control builds — a
 * check written against the import would have no failing input to offer.
 */
function operationIdsWithNoSummary(
  summaries: Readonly<Partial<Record<GrowthOperationId, string>>>,
): readonly GrowthOperationId[] {
  return (Object.keys(GROWTH_OPERATIONS) as GrowthOperationId[]).filter((operationId) => {
    const summary = summaries[operationId];
    return summary === undefined || summary.trim().length === 0;
  });
}

describe("the growth ledger's operation summaries", () => {
  it("answers for every operation in the table", () => {
    expect(operationIdsWithNoSummary(growthOperationSummaries())).toEqual([]);
  });

  it("negative control: an operation whose sentence is missing is reported", () => {
    const [firstOperationId] = Object.keys(GROWTH_OPERATIONS) as GrowthOperationId[];
    if (firstOperationId === undefined) {
      throw new Error("The growth ledger is empty, so this control has nothing to hole.");
    }
    const holed: Partial<Record<GrowthOperationId, string>> = { ...growthOperationSummaries() };
    delete holed[firstOperationId];

    expect(operationIdsWithNoSummary(holed)).toEqual([firstOperationId]);
  });

  it("names no sentence for an id the table does not carry", () => {
    // The other direction, which the records' own key types also hold statically. Read
    // at run time as well because the two halves are edited in different diffs: an
    // operation deleted from a plane's entry table leaves its sentence behind, and a
    // stale sentence describes a wire nothing asks for any more.
    const operationIds = new Set<string>(Object.keys(GROWTH_OPERATIONS));
    const unknownKeys = Object.keys(growthOperationSummaries()).filter(
      (key) => !operationIds.has(key),
    );

    expect(unknownKeys).toEqual([]);
  });

  it("composes one sentence per operation, losing none to a duplicate key", () => {
    // The planes' entry tables are asserted pairwise disjoint next door; this is the
    // same claim for the half beside them, and it is the one a copied row breaks
    // silently — a later spread overrides an earlier one with no compile error, so two
    // planes claiming one id would leave the count short rather than fail.
    expect(Object.keys(growthOperationSummaries()).length).toBe(
      Object.keys(GROWTH_OPERATIONS).length,
    );
  });
});
