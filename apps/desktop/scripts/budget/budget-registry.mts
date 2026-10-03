// Query layer over `tests/budget/budgets.json`, the one place every numeric budget the app is
// gated on is written down. Validation is `budget-document.mts`, comparing a measurement is
// `budget-evaluation.mts`, and formatting the un-measured rows is `budget-report.mts`.

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Budget,
  type BudgetDocument,
  BudgetRegistryError,
  readBudgetDocument,
} from "./budget-document.mts";

const THIS_DIRECTORY: string = path.dirname(fileURLToPath(import.meta.url));

/** `apps/desktop`, resolved from this file so every default path is absolute. */
export const DESKTOP_PACKAGE_ROOT: string = path.resolve(THIS_DIRECTORY, "..", "..");

/** Absolute path of the checked-in `budgets.json`. */
export const DEFAULT_BUDGETS_FILE_PATH: string = path.join(
  DESKTOP_PACKAGE_ROOT,
  "tests",
  "budget",
  "budgets.json",
);

/** The parsed `budgets.json`. Construct with `BudgetRegistry.load()`. */
export class BudgetRegistry {
  readonly budgetsFilePath: string;
  readonly schemaVersion: number;
  /** Why the `harness` rows carry the figures they do, stated once for the set. */
  readonly harnessBudgetDerivation: string | null;
  readonly budgets: readonly Budget[];

  private constructor(budgetsFilePath: string, document: BudgetDocument) {
    this.budgetsFilePath = budgetsFilePath;
    this.schemaVersion = document.schemaVersion;
    this.harnessBudgetDerivation = document.harnessBudgetDerivation;
    this.budgets = document.budgets;
  }

  /** @throws {BudgetRegistryError} on a missing, unreadable, or malformed registry. */
  static load(budgetsFilePath: string = DEFAULT_BUDGETS_FILE_PATH): BudgetRegistry {
    return new BudgetRegistry(budgetsFilePath, readBudgetDocument(budgetsFilePath));
  }

  /** @throws {BudgetRegistryError} rather than returning a vacuous pass. */
  requireBudget(budgetId: string): Budget {
    const budget = this.budgets.find((candidate) => candidate.id === budgetId);
    if (budget === undefined) {
      throw new BudgetRegistryError(
        `No budget \`${budgetId}\` in ${this.budgetsFilePath}. ` +
          `Known ids: ${this.budgets.map((candidate) => candidate.id).join(", ")}.`,
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

  /** The rows a harness measures and gates. */
  enforcedBudgets(): readonly Budget[] {
    return this.budgets.filter((budget) => budget.status === "enforced");
  }

  /** The rows nothing measures yet, each carrying its reason. */
  unavailableBudgets(): readonly Budget[] {
    return this.budgets.filter((budget) => budget.status === "n/a");
  }
}
