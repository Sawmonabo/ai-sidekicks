// Query layer over `tests/budget/document.json`, where every numeric budget the app is gated on is
// written down except the bundle sizes, which `.size-limit.ts` holds. Validation is
// `document.ts`, and comparing a measurement is `evaluation.ts`.

import path from "node:path";

import { PACKAGE_ROOT } from "../fixture/bundle.ts";
import { type Budget, BudgetRegistryError, readBudgetDocument } from "./document.ts";

/** Absolute path of the checked-in `tests/budget/document.json`. */
const BUDGETS_FILE_PATH: string = path.join(PACKAGE_ROOT, "tests", "budget", "document.json");

/** The parsed `tests/budget/document.json`. Construct with `BudgetRegistry.load()`. */
export class BudgetRegistry {
  readonly #budgets: readonly Budget[];

  private constructor(budgets: readonly Budget[]) {
    this.#budgets = budgets;
  }

  /** @throws {BudgetRegistryError} on a missing, unreadable, or malformed registry. */
  static load(): BudgetRegistry {
    return new BudgetRegistry(readBudgetDocument(BUDGETS_FILE_PATH).budgets);
  }

  /** @throws {BudgetRegistryError} rather than returning a vacuous pass. */
  requireBudget(budgetId: string): Budget {
    const budget = this.#budgets.find((candidate) => candidate.id === budgetId);
    if (budget === undefined) {
      throw new BudgetRegistryError(
        `No budget \`${budgetId}\` in ${BUDGETS_FILE_PATH}. ` +
          `Known ids: ${this.#budgets.map((candidate) => candidate.id).join(", ")}.`,
      );
    }
    return budget;
  }

  /**
   * The canonical figure for `budgetId`, in its canonical unit, for a harness that needs the number
   * rather than a verdict.
   *
   * @throws {BudgetRegistryError} on an unknown id, never a default.
   */
  requireCanonicalValue(budgetId: string): number {
    return this.requireBudget(budgetId).limit.canonicalValue;
  }
}
