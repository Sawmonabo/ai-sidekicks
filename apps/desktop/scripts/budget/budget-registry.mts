// The console budget registry — Plan-023 Phase 1C (T-023p-1C-1).
//
// The QUERY surface over `test/console/budget/budgets.json`, the one place every
// numeric budget in `Spec-023 §Console Design (Meridian)` §Budgets is written
// down. Load it, then ask it things: which rows the spec's table owns, which the
// scaffolding applies to itself, which are enforced, and what one row's canonical
// figure is.
//
// FOUR CONCERNS, FOUR MODULES
//
// This file held all four until it reached 406 lines, and the seam is the file's
// own vocabulary rather than a line count:
//
//   • `budget-document.mts` — bytes to a validated document. The only half that
//     reads the filesystem and the only half that refuses.
//   • this module — the document, queried.
//   • `budget-evaluation.mts` — a measurement against one row's ceiling.
//   • `budget-report.mts` — the un-measured rows, formatted for a harness to print.
//
// Every importer still reaches all four through this module: nine of them name
// `budget-registry.mjs`, and the split is a change of where the code lives rather
// than of what it publishes. `budget-report.mts` therefore takes its rows through
// a structural port instead of importing the class here — a cycle would fail
// `structure:layering`, and the shape it asks for is the shape this class has.
//
// Printing a reading and exiting on one belong to `budget-harness.mts`, the shell
// the two measuring harnesses run inside.

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ConsoleBudget,
  type ConsoleBudgetDocument,
  ConsoleBudgetRegistryError,
  readBudgetDocument,
} from "./budget-document.mts";

export {
  ConsoleBudgetRegistryError,
  type ConsoleBudget,
  type ConsoleBudgetDocument,
} from "./budget-document.mts";
export { evaluateBudget, type ConsoleBudgetVerdict } from "./budget-evaluation.mts";
export { formatUnavailableBudgetReport } from "./budget-report.mts";

const THIS_DIRECTORY: string = path.dirname(fileURLToPath(import.meta.url));

/** `apps/desktop`, resolved from this file so every default path is absolute. */
export const DESKTOP_PACKAGE_ROOT: string = path.resolve(THIS_DIRECTORY, "..", "..");

export const DEFAULT_BUDGETS_FILE_PATH: string = path.join(
  DESKTOP_PACKAGE_ROOT,
  "test",
  "console",
  "budget",
  "budgets.json",
);

/** The parsed `budgets.json`. Construct with `ConsoleBudgetRegistry.load()`. */
export class ConsoleBudgetRegistry {
  readonly budgetsFilePath: string;
  readonly schemaVersion: number;
  readonly source: string;
  /**
   * Why the `harness` rows carry the figures they do, stated once for the set.
   *
   * `null` exactly when the document declares no `harness` row at all; see
   * `ConsoleBudgetDocument` for why it is a document field rather than a
   * sentence per row.
   */
  readonly harnessBudgetDerivation: string | null;
  readonly budgets: readonly ConsoleBudget[];

  private constructor(budgetsFilePath: string, document: ConsoleBudgetDocument) {
    this.budgetsFilePath = budgetsFilePath;
    this.schemaVersion = document.schemaVersion;
    this.source = document.source;
    this.harnessBudgetDerivation = document.harnessBudgetDerivation;
    this.budgets = document.budgets;
  }

  /** @throws {ConsoleBudgetRegistryError} on a missing, unreadable, or malformed registry. */
  static load(budgetsFilePath: string = DEFAULT_BUDGETS_FILE_PATH): ConsoleBudgetRegistry {
    return new ConsoleBudgetRegistry(budgetsFilePath, readBudgetDocument(budgetsFilePath));
  }

  /** @throws {ConsoleBudgetRegistryError} rather than returning a vacuous pass. */
  requireBudget(budgetId: string): ConsoleBudget {
    const budget = this.budgets.find((candidate) => candidate.id === budgetId);
    if (budget === undefined) {
      throw new ConsoleBudgetRegistryError(
        `No budget \`${budgetId}\` in ${this.budgetsFilePath}. ` +
          `Known ids: ${this.budgets.map((candidate) => candidate.id).join(", ")}.`,
      );
    }
    return budget;
  }

  /** The rows `Spec-023 §Budgets` names — the set that table closes. */
  productBudgets(): readonly ConsoleBudget[] {
    return this.budgets.filter((budget) => budget.scope === "product");
  }

  /** The bounds the test scaffolding applies to itself. */
  harnessBudgets(): readonly ConsoleBudget[] {
    return this.budgets.filter((budget) => budget.scope === "harness");
  }

  /**
   * The canonical figure for `budgetId`, in its canonical unit.
   *
   * The read path for a harness that needs the NUMBER rather than a verdict, so
   * a timeout constant is one line derived from the registry instead of a
   * literal typed a second time beside it.
   *
   * @throws {ConsoleBudgetRegistryError} on an unknown id, never a default.
   */
  requireCanonicalValue(budgetId: string): number {
    return this.requireBudget(budgetId).limit.canonicalValue;
  }

  enforcedBudgets(): readonly ConsoleBudget[] {
    return this.budgets.filter((budget) => budget.status === "enforced");
  }

  unavailableBudgets(): readonly ConsoleBudget[] {
    return this.budgets.filter((budget) => budget.status === "n/a");
  }
}
