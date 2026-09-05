// A measurement against a budget's ceiling — Plan-023 Phase 1C.
//
// The comparison, alone, so that every harness runs the SAME one: `<=` written a
// second time in a measuring script is a second place a budget can be loosened,
// and `endurance/heap-at-rest.test.ts` plants a ceiling one byte under its own
// reading to prove this function bites rather than returning `withinBudget: true`
// unconditionally.
//
// It takes a row rather than a registry, so it depends on the document's shape
// and on nothing that reads a file — which is what keeps `budget-registry.mts`
// free to re-export it without the two modules importing each other.

import { type ConsoleBudget } from "./budget-document.mts";

export interface ConsoleBudgetVerdict {
  readonly budgetId: string;
  readonly measuredCanonicalValue: number;
  readonly limitCanonicalValue: number;
  readonly canonicalUnit: string;
  readonly withinBudget: boolean;
  readonly headroomCanonicalValue: number;
  readonly utilizationFraction: number;
}

export function evaluateBudget(
  budget: ConsoleBudget,
  measuredCanonicalValue: number,
): ConsoleBudgetVerdict {
  const limitCanonicalValue = budget.limit.canonicalValue;
  return Object.freeze({
    budgetId: budget.id,
    measuredCanonicalValue,
    limitCanonicalValue,
    canonicalUnit: budget.limit.canonicalUnit,
    withinBudget: measuredCanonicalValue <= limitCanonicalValue,
    headroomCanonicalValue: limitCanonicalValue - measuredCanonicalValue,
    utilizationFraction:
      limitCanonicalValue === 0 ? 0 : measuredCanonicalValue / limitCanonicalValue,
  });
}
