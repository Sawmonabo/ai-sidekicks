// Compares a measurement with a budget's ceiling. Every harness runs this one comparison, so no
// harness writes `<=` a second time, where a budget could be loosened.

import { type Budget } from "./document.js";

/** The outcome of comparing one measurement with one budget, in the canonical unit. */
export interface BudgetVerdict {
  readonly budgetId: string;
  readonly measuredCanonicalValue: number;
  readonly limitCanonicalValue: number;
  readonly canonicalUnit: string;
  readonly withinBudget: boolean;
  readonly headroomCanonicalValue: number;
  readonly utilizationFraction: number;
}

/** Compares a measurement with the budget's canonical limit; a value equal to it passes. */
export function evaluateBudget(budget: Budget, measuredCanonicalValue: number): BudgetVerdict {
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
