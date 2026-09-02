// The console budget registry — Plan-023 Phase 1C (T-023p-1C-1).
//
// Reads `test/console/budget/budgets.json`, the one place every numeric budget
// in `Spec-023 §Console Design (Meridian)` §Budgets is written down. Every entry
// is either `enforced` (names the harness that measures it) or `n/a` (names the
// Plan-023 task that will, and why it cannot yet); malformed input throws
// `ConsoleBudgetRegistryError` rather than parsing to a partial registry, because
// a budget that silently vanishes is a gate nobody notices is off.
//
// A registry of budgets and nothing else: it parses, validates, and compares.
// Printing a reading and exiting on one belong to `budget-harness.mts`, the
// shell the two measuring harnesses run inside.
//
// Imported by that shell and by `test/console/budget/*.test.ts`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/** Every budget is a ceiling. A floor would need a different verdict shape. */
type ConsoleBudgetComparison = "<=";

type ConsoleBudgetStatus = "enforced" | "n/a";

const BUDGET_STATUS_VALUES: readonly ConsoleBudgetStatus[] = Object.freeze(["enforced", "n/a"]);

interface ConsoleBudgetLimit {
  readonly comparison: ConsoleBudgetComparison;
  /** The figure as the spec writes it, in `unit`. */
  readonly value: number;
  readonly unit: string;
  /** The same figure reduced to `canonicalUnit`; the only figure compared. */
  readonly canonicalValue: number;
  readonly canonicalUnit: string;
}

export interface ConsoleBudget {
  readonly id: string;
  readonly label: string;
  readonly subject: string;
  readonly specTarget: string;
  readonly limit: ConsoleBudgetLimit;
  readonly status: ConsoleBudgetStatus;
  /** The Plan-023 task that produces (or produced) the measurement. */
  readonly producedBy: string;
  /** Repo-relative harness path; `null` exactly when `status` is `"n/a"`. */
  readonly measuredBy: string | null;
  /** Why it is not measurable yet; non-null exactly when `status` is `"n/a"`. */
  readonly notMeasurableReason: string | null;
  readonly notes: string;
  /** Non-numeric conditions the budget also carries; gated elsewhere. */
  readonly additionalCriteria: readonly string[];
}

export interface ConsoleBudgetVerdict {
  readonly budgetId: string;
  readonly measuredCanonicalValue: number;
  readonly limitCanonicalValue: number;
  readonly canonicalUnit: string;
  readonly withinBudget: boolean;
  readonly headroomCanonicalValue: number;
  readonly utilizationFraction: number;
}

export class ConsoleBudgetRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsoleBudgetRegistryError";
  }
}

function refuse(message: string): never {
  throw new ConsoleBudgetRegistryError(message);
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

function parseBudget(rawEntry: unknown, entryIndex: number): ConsoleBudget {
  const entry = requireObject(rawEntry, `budgets[${entryIndex}]`);
  const id = requireString(entry, "id", `budgets[${entryIndex}]`);
  const where = `budgets[${entryIndex}] (${id})`;

  const status = requireString(entry, "status", where);
  if (!BUDGET_STATUS_VALUES.includes(status as ConsoleBudgetStatus)) {
    refuse(`${where}: \`status\` must be one of ${BUDGET_STATUS_VALUES.join(", ")}.`);
  }

  const rawLimit = requireObject(entry["limit"], `${where}.limit`);
  const comparison = requireString(rawLimit, "comparison", `${where}.limit`);
  if (comparison !== "<=") {
    refuse(`${where}.limit: \`comparison\` must be "<=" — every budget is a ceiling.`);
  }

  const measuredBy = optionalString(entry, "measuredBy");
  const notMeasurableReason = optionalString(entry, "notMeasurableReason");
  if (status === "enforced" && measuredBy === null) {
    refuse(`${where}: an \`enforced\` budget must name its harness in \`measuredBy\`.`);
  }
  if (status === "n/a" && measuredBy !== null) {
    refuse(`${where}: an \`n/a\` budget must set \`measuredBy\` to null.`);
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
    status: status as ConsoleBudgetStatus,
    producedBy: requireString(entry, "producedBy", where),
    measuredBy,
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

/** The parsed `budgets.json`. Construct with `ConsoleBudgetRegistry.load()`. */
export class ConsoleBudgetRegistry {
  readonly budgetsFilePath: string;
  readonly schemaVersion: number;
  readonly source: string;
  readonly budgets: readonly ConsoleBudget[];

  private constructor(
    budgetsFilePath: string,
    schemaVersion: number,
    source: string,
    budgets: readonly ConsoleBudget[],
  ) {
    this.budgetsFilePath = budgetsFilePath;
    this.schemaVersion = schemaVersion;
    this.source = source;
    this.budgets = budgets;
  }

  /** @throws {ConsoleBudgetRegistryError} on a missing, unreadable, or malformed registry. */
  static load(budgetsFilePath: string = DEFAULT_BUDGETS_FILE_PATH): ConsoleBudgetRegistry {
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
    if (schemaVersion !== 1) {
      refuse(`${budgetsFilePath}: unsupported \`schemaVersion\` ${schemaVersion} (expected 1).`);
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

    return new ConsoleBudgetRegistry(
      budgetsFilePath,
      schemaVersion,
      requireString(document, "source", budgetsFilePath),
      Object.freeze(budgets),
    );
  }

  /** @throws {ConsoleBudgetRegistryError} rather than returning a vacuous pass. */
  requireBudget(budgetId: string): ConsoleBudget {
    const budget = this.budgets.find((candidate) => candidate.id === budgetId);
    if (budget === undefined) {
      refuse(
        `No budget \`${budgetId}\` in ${this.budgetsFilePath}. ` +
          `Known ids: ${this.budgets.map((candidate) => candidate.id).join(", ")}.`,
      );
    }
    return budget;
  }

  enforcedBudgets(): readonly ConsoleBudget[] {
    return this.budgets.filter((budget) => budget.status === "enforced");
  }

  unavailableBudgets(): readonly ConsoleBudget[] {
    return this.budgets.filter((budget) => budget.status === "n/a");
  }
}

/**
 * One line per budget this revision does not measure, printed by every harness
 * so an ungated budget stays visible instead of being absent from every report.
 */
export function formatUnavailableBudgetReport(registry: ConsoleBudgetRegistry): string {
  const unavailable = registry.unavailableBudgets();
  if (unavailable.length === 0) {
    return "Every budget in the registry is measured at this revision.";
  }
  const lines = [`Budgets NOT gated at this revision (${unavailable.length}):`];
  for (const budget of unavailable) {
    lines.push(
      `  ${budget.id} — ${budget.specTarget}`,
      `      produced by ${budget.producedBy}: ${budget.notMeasurableReason ?? ""}`,
    );
  }
  return lines.join("\n");
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
