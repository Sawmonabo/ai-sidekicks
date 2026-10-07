// Query layer over `tests/budget/document.json`, where every numeric budget the app is gated on is
// written down except the bundle sizes, which `.size-limit.ts` holds. Validation is
// `document.mts`, and comparing a measurement is `evaluation.mts`.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { type Budget, BudgetRegistryError, readBudgetDocument } from "./document.mts";

const THIS_DIRECTORY: string = path.dirname(fileURLToPath(import.meta.url));

/** `apps/desktop`, resolved from this file so every default path is absolute. */
export const DESKTOP_PACKAGE_ROOT: string = path.resolve(THIS_DIRECTORY, "..", "..");

/** Absolute path of the checked-in `tests/budget/document.json`. */
export const DEFAULT_BUDGETS_FILE_PATH: string = path.join(
  DESKTOP_PACKAGE_ROOT,
  "tests",
  "budget",
  "document.json",
);

/** The parsed `tests/budget/document.json`. Construct with `BudgetRegistry.load()`. */
export class BudgetRegistry {
  readonly #budgetsFilePath: string;
  readonly #budgets: readonly Budget[];

  private constructor(budgetsFilePath: string, budgets: readonly Budget[]) {
    this.#budgetsFilePath = budgetsFilePath;
    this.#budgets = budgets;
  }

  /** @throws {BudgetRegistryError} on a missing, unreadable, or malformed registry. */
  static load(budgetsFilePath: string = DEFAULT_BUDGETS_FILE_PATH): BudgetRegistry {
    return new BudgetRegistry(budgetsFilePath, readBudgetDocument(budgetsFilePath).budgets);
  }

  /** @throws {BudgetRegistryError} rather than returning a vacuous pass. */
  requireBudget(budgetId: string): Budget {
    const budget = this.#budgets.find((candidate) => candidate.id === budgetId);
    if (budget === undefined) {
      throw new BudgetRegistryError(
        `No budget \`${budgetId}\` in ${this.#budgetsFilePath}. ` +
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
