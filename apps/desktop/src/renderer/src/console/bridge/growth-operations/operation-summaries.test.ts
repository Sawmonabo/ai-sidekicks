// Does every growth operation's sentence actually say something?
//
// The sentences live in `operation-summaries.ts` and the rows in `index.ts`, split by
// CONSUMER so the half no running console reads stays off the initial import graph —
// `growth-slate-consumers.test.ts` checks the slate's own `consumingSurface` under the
// same rule, and this file is that rule applied to the operations ledger.
//
// WHAT THE COMPILER ALREADY HOLDS, AND IS NOT RESTATED BELOW. The sentences are one
// object literal annotated `Readonly<Record<GrowthOperationId, string>>`, so a missing
// operation, a key the union does not carry, and a duplicate key are all three compile
// errors — the last one because a duplicate inside a single literal is an error where
// the same key in two spread sources is a silent override. A runtime case for any of
// them would assert against a program that cannot be built, and would go on passing
// while saying nothing. What the annotation cannot say is that a sentence is a
// SENTENCE: `string` admits `""`, and an operation added with an empty summary compiles
// and describes nothing. That is the one property left, and it is the one checked here.

import { describe, expect, it } from "vitest";

import type { GrowthOperationId } from "../growth-port/growth-entry.js";
import { GROWTH_OPERATIONS } from "./index.js";
import { GROWTH_OPERATION_SUMMARIES } from "./operation-summaries.js";

/**
 * Which operation ids the summary table does not answer for, over any candidate table.
 *
 * Takes the table as an argument rather than reading the import directly, so the same
 * reading answers for the real table and for the holed copy the control builds — a check
 * written against the import would have no failing input to offer.
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
    expect(operationIdsWithNoSummary(GROWTH_OPERATION_SUMMARIES)).toEqual([]);
  });

  it("negative control: an operation whose sentence is missing is reported", () => {
    const [firstOperationId] = Object.keys(GROWTH_OPERATIONS) as GrowthOperationId[];
    if (firstOperationId === undefined) {
      throw new Error("The growth ledger is empty, so this control has nothing to hole.");
    }
    const holed: Partial<Record<GrowthOperationId, string>> = { ...GROWTH_OPERATION_SUMMARIES };
    delete holed[firstOperationId];

    expect(operationIdsWithNoSummary(holed)).toEqual([firstOperationId]);
  });
});
