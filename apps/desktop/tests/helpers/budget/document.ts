// Reads `tests/budget/document.json` and validates it into a `BudgetDocument`. It refuses with
// `BudgetRegistryError` rather than return a partial document: a budget that silently vanishes is
// a gate nobody notices is off.

import { readFileSync } from "node:fs";

import { z } from "zod";

import { describeFailure } from "#shared/failure-message.js";

/**
 * The only registry revision this reader accepts. An older document is refused rather than
 * defaulted, because a default would answer registry queries wrongly instead of loudly.
 */
const SUPPORTED_SCHEMA_VERSION = 3;

const NonEmptyStringSchema = z.string().refine((value) => value.trim() !== "", {
  error: "must be a non-empty string",
});

/** An optional text field; an absent, `null` or empty value reads as `null`. */
const OptionalStringSchema = z
  .string()
  .nullish()
  .transform((value) => (value === undefined || value === null || value === "" ? null : value));

interface BudgetLimit {
  /** Every budget is a ceiling. A floor would need a different verdict shape. */
  readonly comparison: "<=";
  /** The target figure as the row states it, in `unit`. */
  readonly value: number;
  readonly unit: string;
  /** The same figure reduced to `canonicalUnit`; the only figure compared. */
  readonly canonicalValue: number;
  readonly canonicalUnit: string;
}

/** One row of `tests/budget/document.json`, validated. */
export interface Budget {
  readonly id: string;
  readonly label: string;
  readonly subject: string;
  /** The figure as its source writes it: the product figure, or a `harness` row's derivation. */
  readonly specTarget: string;
  readonly limit: BudgetLimit;
  /**
   * `product` rows are the app's own product budgets, a closed list. `harness` rows bound the test
   * scaffolding or what the endurance tier reads off the app.
   */
  readonly scope: "product" | "harness";
  readonly status: "enforced" | "n/a";
  /** Repo-relative harness path; `null` exactly when `status` is `"n/a"`. */
  readonly measuredBy: string | null;
  /**
   * The exported symbol `measuredBy` must hold; `null` exactly when `status` is `"n/a"`. A path
   * alone is not evidence that a harness touches the row's subject.
   */
  readonly subjectSymbol: string | null;
  /** Why it is not measurable yet; non-null exactly when `status` is `"n/a"`. */
  readonly notMeasurableReason: string | null;
  readonly notes: string;
}

/** A validated `tests/budget/document.json`, before anything is asked of it. */
export interface BudgetDocument {
  readonly schemaVersion: number;
  /**
   * Why the `harness` rows carry the figures they do, stated once for the set. Required when any
   * `harness` row exists.
   */
  readonly harnessBudgetDerivation: string | null;
  readonly budgets: readonly Budget[];
}

const BudgetSchema = z
  .object({
    id: NonEmptyStringSchema,
    label: NonEmptyStringSchema,
    subject: NonEmptyStringSchema,
    specTarget: NonEmptyStringSchema,
    limit: z.object({
      comparison: z.literal("<="),
      value: z.number(),
      unit: NonEmptyStringSchema,
      canonicalValue: z.number(),
      canonicalUnit: NonEmptyStringSchema,
    }),
    scope: z.enum(["product", "harness"]),
    status: z.enum(["enforced", "n/a"]),
    measuredBy: OptionalStringSchema,
    subjectSymbol: OptionalStringSchema,
    notMeasurableReason: OptionalStringSchema,
    notes: NonEmptyStringSchema,
  })
  .superRefine((budget, context) => {
    const enforced = budget.status === "enforced";
    if (enforced && budget.measuredBy === null) {
      context.addIssue("an `enforced` budget must name its harness in `measuredBy`");
    }
    if (enforced && budget.subjectSymbol === null) {
      context.addIssue(
        "an `enforced` budget must name the symbol its harness holds in `subjectSymbol`: " +
          "a path that exists is not evidence that it measures anything",
      );
    }
    if (!enforced && budget.measuredBy !== null) {
      context.addIssue("an `n/a` budget must set `measuredBy` to null");
    }
    if (!enforced && budget.subjectSymbol !== null) {
      context.addIssue("an `n/a` budget must set `subjectSymbol` to null");
    }
    if (!enforced && budget.notMeasurableReason === null) {
      context.addIssue("an `n/a` budget must say why in `notMeasurableReason`");
    }
  });

const BudgetDocumentSchema: z.ZodType<BudgetDocument> = z
  .object({
    schemaVersion: z.literal(SUPPORTED_SCHEMA_VERSION),
    harnessBudgetDerivation: OptionalStringSchema,
    budgets: z.array(BudgetSchema).min(1),
  })
  .superRefine((document, context) => {
    const seenIds = new Set<string>();
    for (const budget of document.budgets) {
      if (seenIds.has(budget.id)) {
        context.addIssue(`duplicate budget id \`${budget.id}\``);
      }
      seenIds.add(budget.id);
    }
    // A `harness` row's figure is ours, so a document that declares one and never says why has a
    // bound with no reviewable source.
    const declaresHarnessRow = document.budgets.some((budget) => budget.scope === "harness");
    if (declaresHarnessRow && document.harnessBudgetDerivation === null) {
      context.addIssue(
        "a `harness` row needs `harnessBudgetDerivation`, stated once for the set rather than " +
          "copied into each row",
      );
    }
  });

/** Thrown when the budget registry is unreadable, malformed, or breaks a rule of the format. */
export class BudgetRegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BudgetRegistryError";
  }
}

/**
 * Read and validate the document at `budgetsFilePath`.
 *
 * @throws {BudgetRegistryError} on a missing, unreadable, or malformed registry.
 */
export function readBudgetDocument(budgetsFilePath: string): BudgetDocument {
  let text: string;
  try {
    text = readFileSync(budgetsFilePath, "utf8");
  } catch (readError) {
    throw new BudgetRegistryError(
      `Cannot read the budget registry at ${budgetsFilePath}: ${describeFailure(readError)}`,
      { cause: readError },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (parseError) {
    throw new BudgetRegistryError(
      `${budgetsFilePath} is not valid JSON: ${describeFailure(parseError)}`,
      { cause: parseError },
    );
  }

  const result = BudgetDocumentSchema.safeParse(parsed);
  if (!result.success) {
    throw new BudgetRegistryError(
      `${budgetsFilePath} breaks the registry format:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
