// Reads `budgets.json` and validates it into a `BudgetDocument`. It refuses with
// `BudgetRegistryError` rather than return a partial document: a budget that silently vanishes is
// a gate nobody notices is off.

import { readFileSync } from "node:fs";

/**
 * The only registry revision this reader accepts. An older document is refused rather than
 * defaulted, because a default would answer registry queries wrongly instead of loudly.
 */
const SUPPORTED_SCHEMA_VERSION = 3;

/** Every budget is a ceiling. A floor would need a different verdict shape. */
type BudgetComparison = "<=";

type BudgetStatus = "enforced" | "n/a";

const BUDGET_STATUS_VALUES: readonly BudgetStatus[] = Object.freeze(["enforced", "n/a"]);

/**
 * Where a budget's figure comes from. `product` rows are the console's own product budgets, a
 * closed list. `harness` rows bound the test scaffolding or a shipped artifact the product list
 * does not cover; they stay a separate scope so the product list can be checked by counting.
 */
type BudgetScope = "product" | "harness";

const BUDGET_SCOPE_VALUES: readonly BudgetScope[] = Object.freeze(["product", "harness"]);

interface BudgetLimit {
  readonly comparison: BudgetComparison;
  /** The figure as the spec writes it, in `unit`. */
  readonly value: number;
  readonly unit: string;
  /** The same figure reduced to `canonicalUnit`; the only figure compared. */
  readonly canonicalValue: number;
  readonly canonicalUnit: string;
}

/** One row of `budgets.json`, validated. */
export interface Budget {
  readonly id: string;
  readonly label: string;
  readonly subject: string;
  /** The figure as its source writes it: the product figure, or a `harness` row's derivation. */
  readonly specTarget: string;
  readonly limit: BudgetLimit;
  readonly scope: BudgetScope;
  readonly status: BudgetStatus;
  /** Repo-relative harness path; `null` exactly when `status` is `"n/a"`. */
  readonly measuredBy: string | null;
  /**
   * The exported symbol `measuredBy` must hold; `null` exactly when `status` is `"n/a"`. A path
   * alone is not evidence that a harness touches the row's subject, so an `enforced` row that
   * names no symbol is refused.
   */
  readonly subjectSymbol: string | null;
  /** Why it is not measurable yet; non-null exactly when `status` is `"n/a"`. */
  readonly notMeasurableReason: string | null;
  readonly notes: string;
  /** Non-numeric conditions the budget also carries; gated elsewhere. */
  readonly additionalCriteria: readonly string[];
}

/** A validated `budgets.json`, before anything is asked of it. */
export interface BudgetDocument {
  readonly schemaVersion: number;
  /**
   * Why the `harness` rows carry the figures they do, stated once for the set. Required when any
   * `harness` row exists.
   */
  readonly harnessBudgetDerivation: string | null;
  readonly budgets: readonly Budget[];
}

/** Thrown when the budget registry is unreadable, malformed, or breaks a rule of the format. */
export class BudgetRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetRegistryError";
  }
}

function refuse(message: string): never {
  throw new BudgetRegistryError(message);
}

function requireObject(candidate: unknown, where: string): Record<string, unknown> {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    refuse(`${where} must be an object.`);
  }
  return candidate as Record<string, unknown>;
}

function requireString(owner: Record<string, unknown>, field: string, where: string): string {
  const value = owner[field];
  if (typeof value !== "string" || value.trim() === "") {
    refuse(`${where}: \`${field}\` must be a non-empty string.`);
  }
  return value;
}

function optionalString(owner: Record<string, unknown>, field: string): string | null {
  const value = owner[field];
  return typeof value === "string" && value !== "" ? value : null;
}

function requireNumber(owner: Record<string, unknown>, field: string, where: string): number {
  const value = owner[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    refuse(`${where}: \`${field}\` must be a finite number.`);
  }
  return value;
}

function parseBudget(rawEntry: unknown, entryIndex: number): Budget {
  const entry = requireObject(rawEntry, `budgets[${entryIndex}]`);
  const id = requireString(entry, "id", `budgets[${entryIndex}]`);
  const where = `budgets[${entryIndex}] (${id})`;

  const status = requireString(entry, "status", where);
  if (!BUDGET_STATUS_VALUES.includes(status as BudgetStatus)) {
    refuse(`${where}: \`status\` must be one of ${BUDGET_STATUS_VALUES.join(", ")}.`);
  }

  const scope = requireString(entry, "scope", where);
  if (!BUDGET_SCOPE_VALUES.includes(scope as BudgetScope)) {
    refuse(`${where}: \`scope\` must be one of ${BUDGET_SCOPE_VALUES.join(", ")}.`);
  }

  const rawLimit = requireObject(entry["limit"], `${where}.limit`);
  const comparison = requireString(rawLimit, "comparison", `${where}.limit`);
  if (comparison !== "<=") {
    refuse(`${where}.limit: \`comparison\` must be "<=" — every budget is a ceiling.`);
  }

  const measuredBy = optionalString(entry, "measuredBy");
  const subjectSymbol = optionalString(entry, "subjectSymbol");
  const notMeasurableReason = optionalString(entry, "notMeasurableReason");
  if (status === "enforced" && measuredBy === null) {
    refuse(`${where}: an \`enforced\` budget must name its harness in \`measuredBy\`.`);
  }
  if (status === "enforced" && subjectSymbol === null) {
    refuse(
      `${where}: an \`enforced\` budget must name the symbol its harness holds in ` +
        "`subjectSymbol` — a path that exists is not evidence that it measures anything.",
    );
  }
  if (status === "n/a" && measuredBy !== null) {
    refuse(`${where}: an \`n/a\` budget must set \`measuredBy\` to null.`);
  }
  if (status === "n/a" && subjectSymbol !== null) {
    refuse(`${where}: an \`n/a\` budget must set \`subjectSymbol\` to null.`);
  }
  if (status === "n/a" && notMeasurableReason === null) {
    refuse(`${where}: an \`n/a\` budget must say why in \`notMeasurableReason\`.`);
  }

  const additionalCriteria = entry["additionalCriteria"];
  return Object.freeze({
    id,
    label: requireString(entry, "label", where),
    subject: requireString(entry, "subject", where),
    specTarget: requireString(entry, "specTarget", where),
    limit: Object.freeze({
      comparison,
      value: requireNumber(rawLimit, "value", `${where}.limit`),
      unit: requireString(rawLimit, "unit", `${where}.limit`),
      canonicalValue: requireNumber(rawLimit, "canonicalValue", `${where}.limit`),
      canonicalUnit: requireString(rawLimit, "canonicalUnit", `${where}.limit`),
    }),
    scope: scope as BudgetScope,
    status: status as BudgetStatus,
    measuredBy,
    subjectSymbol,
    notMeasurableReason,
    notes: requireString(entry, "notes", where),
    additionalCriteria: Object.freeze(
      Array.isArray(additionalCriteria)
        ? additionalCriteria.filter(
            (criterion): criterion is string => typeof criterion === "string",
          )
        : [],
    ),
  });
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
    refuse(
      `Cannot read the budget registry at ${budgetsFilePath}: ` +
        `${readError instanceof Error ? readError.message : String(readError)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (parseError) {
    refuse(
      `${budgetsFilePath} is not valid JSON: ` +
        `${parseError instanceof Error ? parseError.message : String(parseError)}`,
    );
  }

  const document = requireObject(parsed, budgetsFilePath);
  const schemaVersion = requireNumber(document, "schemaVersion", budgetsFilePath);
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    refuse(
      `${budgetsFilePath}: unsupported \`schemaVersion\` ${schemaVersion} ` +
        `(expected ${SUPPORTED_SCHEMA_VERSION}).`,
    );
  }
  const rawBudgets = document["budgets"];
  if (!Array.isArray(rawBudgets) || rawBudgets.length === 0) {
    refuse(`${budgetsFilePath}: \`budgets\` must be a non-empty array.`);
  }

  const budgets = rawBudgets.map(parseBudget);
  const seenIds = new Set<string>();
  for (const budget of budgets) {
    if (seenIds.has(budget.id)) {
      refuse(`${budgetsFilePath}: duplicate budget id \`${budget.id}\`.`);
    }
    seenIds.add(budget.id);
  }

  // A `harness` row's figure is ours, so a document that declares one and never says why has a
  // bound with no reviewable source. The derivation is required once for the set, not per row.
  const harnessBudgetDerivation = optionalString(document, "harnessBudgetDerivation");
  if (budgets.some((budget) => budget.scope === "harness") && harnessBudgetDerivation === null) {
    refuse(
      `${budgetsFilePath}: a \`harness\` row needs \`harnessBudgetDerivation\` — ` +
        "the derivation is stated once for the set, never copied into each row.",
    );
  }

  return Object.freeze({
    schemaVersion,
    harnessBudgetDerivation,
    budgets: Object.freeze(budgets),
  });
}
