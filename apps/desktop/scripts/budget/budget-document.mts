// `budgets.json` as bytes, validated into a document — Plan-023 Phase 1C.
//
// One half of what `budget-registry.mts` used to be. This module answers "is this
// file a budget document, and what does it say?" and nothing else: it reads the
// bytes, parses the JSON, checks every field a row must carry and every rule the
// envelope must satisfy, and refuses with `ConsoleBudgetRegistryError` rather
// than producing a partial document — because a budget that silently vanishes is
// a gate nobody notices is off.
//
// Querying that document, comparing a measurement against one of its rows, and
// printing a report over it are three other jobs, and they are three other
// modules (`budget-registry.mts`, `budget-evaluation.mts`, `budget-report.mts`).
// The split is by concern rather than by size: validation is the only half that
// reads the filesystem and the only half that refuses, so it is the half a reader
// checking "can a malformed row get through?" should be able to read alone.

import { readFileSync } from "node:fs";

/**
 * The only registry revision this reader accepts.
 *
 * 2 added the required `scope` field. 3 added the required `subjectSymbol`, which
 * is what turns `measuredBy` from a path that merely EXISTS into a claim a test
 * can check: the harness has to hold the symbol the row is about. Older documents
 * parse into a registry that would answer "which rows are the spec's?" or "does
 * this harness touch its subject?" wrongly rather than loudly, so they are
 * refused instead of defaulted.
 */
const SUPPORTED_SCHEMA_VERSION = 3;

/** Every budget is a ceiling. A floor would need a different verdict shape. */
type ConsoleBudgetComparison = "<=";

type ConsoleBudgetStatus = "enforced" | "n/a";

const BUDGET_STATUS_VALUES: readonly ConsoleBudgetStatus[] = Object.freeze(["enforced", "n/a"]);

/**
 * Where a budget's figure comes from, and what it is therefore a claim about.
 *
 * `product` rows are `Spec-023 §Console Design (Meridian)` §Budgets' own, and
 * their set is closed: the spec table names them all and nothing else may join.
 * `harness` rows are bounds the test scaffolding applies to itself, with no spec
 * figure behind them. They share this file rather than getting one of their own
 * because a budget with a second home is a budget that will disagree with
 * itself — and they are discriminated rather than merged so the completeness
 * claim over the spec table stays checkable by counting.
 */
type ConsoleBudgetScope = "product" | "harness";

const BUDGET_SCOPE_VALUES: readonly ConsoleBudgetScope[] = Object.freeze(["product", "harness"]);

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
  /** The figure as its own source writes it: the spec's text for a `product` row, the derivation for a `harness` one. */
  readonly specTarget: string;
  readonly limit: ConsoleBudgetLimit;
  readonly scope: ConsoleBudgetScope;
  readonly status: ConsoleBudgetStatus;
  /** The Plan-023 task that produces (or produced) the measurement. */
  readonly producedBy: string;
  /** Repo-relative harness path; `null` exactly when `status` is `"n/a"`. */
  readonly measuredBy: string | null;
  /**
   * The exported symbol `measuredBy` must hold; `null` exactly when `status` is `"n/a"`.
   *
   * `existsSync` over `measuredBy` passed for two rows that named a file which
   * never touches their subject — the frame-witness and cleanup bounds both
   * pointed at `architecture/launch-deadline.test.ts`, which compares registry
   * figures with imported constants and drives neither `FrameWitness` nor
   * `BoundedCleanup`. A path is not evidence; the symbol the harness has to hold
   * is, and `budget/measured-by.test.ts` reads the file and checks it.
   */
  readonly subjectSymbol: string | null;
  /** Why it is not measurable yet; non-null exactly when `status` is `"n/a"`. */
  readonly notMeasurableReason: string | null;
  readonly notes: string;
  /** Non-numeric conditions the budget also carries; gated elsewhere. */
  readonly additionalCriteria: readonly string[];
}

/** A validated `budgets.json`, before anything is asked of it. */
export interface ConsoleBudgetDocument {
  readonly schemaVersion: number;
  readonly source: string;
  /**
   * Why the `harness` rows carry the figures they do, stated once for the set.
   *
   * A document-level field rather than a sentence per row, because those bounds
   * are slices of one deadline: the derivation is a property of the set, and a
   * rule restated per row is a rule with as many places to drift as there are
   * rows — which is what it did, three copies deep and already imprecise about
   * which tier the sum is held against. `null` exactly when the document
   * declares no `harness` row at all.
   */
  readonly harnessBudgetDerivation: string | null;
  readonly budgets: readonly ConsoleBudget[];
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

  const scope = requireString(entry, "scope", where);
  if (!BUDGET_SCOPE_VALUES.includes(scope as ConsoleBudgetScope)) {
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
    scope: scope as ConsoleBudgetScope,
    status: status as ConsoleBudgetStatus,
    producedBy: requireString(entry, "producedBy", where),
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
 * @throws {ConsoleBudgetRegistryError} on a missing, unreadable, or malformed registry.
 */
export function readBudgetDocument(budgetsFilePath: string): ConsoleBudgetDocument {
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

  // A `product` row's figure is the spec's and needs no derivation here; a
  // `harness` row's figure is ours, so a document that declares one and says
  // nowhere why is a bound with no reviewable source — the shape this file
  // exists to refuse. Required for the SET rather than per row, which is what
  // keeps it stated once.
  const harnessBudgetDerivation = optionalString(document, "harnessBudgetDerivation");
  if (budgets.some((budget) => budget.scope === "harness") && harnessBudgetDerivation === null) {
    refuse(
      `${budgetsFilePath}: a \`harness\` row needs \`harnessBudgetDerivation\` — ` +
        "the derivation is stated once for the set, never copied into each row.",
    );
  }

  return Object.freeze({
    schemaVersion,
    source: requireString(document, "source", budgetsFilePath),
    harnessBudgetDerivation,
    budgets: Object.freeze(budgets),
  });
}
