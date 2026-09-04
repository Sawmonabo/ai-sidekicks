// Filters and jumps over the loaded window.
//
// `Spec-023 §Console Design (Meridian)`: "Filter by participant and by event
// family, jump to event by id, scroll to tail: renderer-local over the loaded
// window and cursors."
//
// ONE RULE IS LOAD-BEARING AND IT IS NOT A CONVENIENCE: "a filtered subscription
// still receives `rollback_boundary` rows for any run whose rows the filter
// admits." A rollback boundary is what marks the rows around it superseded;
// a filter that hid the boundary while keeping its run's rows would render a
// history that had been corrected as though it never was. So the boundary rule is
// applied INSIDE the filter, not left to a caller to remember, and it is expressed
// as an admission over the run set the filter already computed rather than as an
// exemption a reviewer has to spot.
//
// Event FAMILY is the wire's own `EventCategory`, taken from the rows in the
// window rather than from a hand-written list of categories: the contract exports
// the union but no array of it, and a list re-typed here would be a second closed
// set that drifts from the first. Offering the families actually present is also
// the better surface — a filter menu of twenty categories, eighteen of which match
// nothing in this session, is a menu nobody reads.

import type { EventCategory, TimelineRow } from "@ai-sidekicks/contracts";

/**
 * What a person has narrowed the ledger to.
 *
 * Both axes are arrays rather than sets so the value is plain, comparable, and
 * safe to hold in a store; emptiness means "no narrowing on this axis", which is
 * what makes the default filter the empty object.
 */
export interface LedgerFilter {
  /** Participants whose rows are admitted. Empty admits every participant. */
  readonly participantIds: readonly string[];
  /** Event families admitted. Empty admits every family. */
  readonly categories: readonly EventCategory[];
}

/** The filter that narrows nothing. */
export const UNFILTERED_LEDGER: LedgerFilter = { participantIds: [], categories: [] };

/** Whether a filter narrows anything at all. Drives the "clear filters" affordance. */
export function isLedgerFiltered(filter: LedgerFilter): boolean {
  return filter.participantIds.length > 0 || filter.categories.length > 0;
}

/** One filterable value and how many rows in the window carry it. */
export interface LedgerFacet<TValue> {
  readonly value: TValue;
  readonly rowCount: number;
}

/**
 * What the filter menu offers, derived from the window itself.
 *
 * Counts are carried because a facet with a count is a choice a person can make;
 * a bare list of names makes them guess which one narrows to anything.
 */
export interface LedgerFacets {
  readonly participants: readonly LedgerFacet<string>[];
  readonly categories: readonly LedgerFacet<EventCategory>[];
}

/** Every value the window offers to filter on, in first-appearance order. */
export function deriveLedgerFacets(rows: readonly TimelineRow[]): LedgerFacets {
  const participantCounts = new Map<string, number>();
  const categoryCounts = new Map<EventCategory, number>();
  for (const row of rows) {
    if (row.actor !== undefined) {
      participantCounts.set(row.actor, (participantCounts.get(row.actor) ?? 0) + 1);
    }
    categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1);
  }
  return {
    participants: [...participantCounts].map(([value, rowCount]) => ({ value, rowCount })),
    categories: [...categoryCounts].map(([value, rowCount]) => ({ value, rowCount })),
  };
}

/**
 * Apply a filter to one loaded window.
 *
 * Two passes, and the second is the boundary rule: the first admits rows on their
 * own merits and records which runs were admitted, and the second re-admits every
 * `rollback_boundary` belonging to one of those runs. A single pass could not do
 * it — a boundary earlier in the window than any admitted row of its run would
 * have to be judged before the run was known.
 *
 * Order is preserved throughout: this narrows, it never sorts.
 */
export function applyLedgerFilter(
  rows: readonly TimelineRow[],
  filter: LedgerFilter,
): readonly TimelineRow[] {
  if (!isLedgerFiltered(filter)) {
    return rows;
  }
  const admittedParticipants = new Set(filter.participantIds);
  const admittedCategories = new Set<EventCategory>(filter.categories);
  const admittedRowIds = new Set<string>();
  const admittedRunIds = new Set<string>();

  for (const row of rows) {
    const participantAdmits =
      admittedParticipants.size === 0 ||
      (row.actor !== undefined && admittedParticipants.has(row.actor));
    const categoryAdmits = admittedCategories.size === 0 || admittedCategories.has(row.category);
    if (!participantAdmits || !categoryAdmits) {
      continue;
    }
    admittedRowIds.add(row.id);
    if (row.kind !== "general") {
      admittedRunIds.add(row.runId);
    }
  }

  for (const row of rows) {
    if (row.kind === "rollback_boundary" && admittedRunIds.has(row.runId)) {
      admittedRowIds.add(row.id);
    }
  }

  return rows.filter((row) => admittedRowIds.has(row.id));
}

/**
 * The narrowings a row passes through between the loaded log and the viewport, in
 * the order the feed applies them.
 *
 * DECLARED AS A TUPLE BECAUSE THE ORDER IS THE VALUE. A row absent from the
 * viewport is absent for exactly one reason — the FIRST stage that did not admit
 * it — and the stages are strictly nested, so any other order would report a later
 * cause for an earlier one. The set the classifier walks and the set a renderer
 * must have words for are therefore the same set, derived from this line rather
 * than restated beside it.
 */
export const LEDGER_JUMP_ABSENCES = [
  "hidden-by-filter",
  "folded-into-chapter",
  "withheld-by-replay",
  "outside-window",
] as const;

/** Which narrowing took a row out of the viewport. */
export type LedgerJumpAbsence = (typeof LEDGER_JUMP_ABSENCES)[number];

/**
 * What one stage kept, asked by row id.
 *
 * An interface rather than `ReadonlySet<string>` so a caller passes whichever
 * lookup it already holds — the projection's `rowsByKey` map, the viewport's key
 * set — instead of copying one into the other shape on every keystroke.
 */
export interface LedgerRowIdMembership {
  readonly has: (rowId: string) => boolean;
}

/**
 * What each stage admitted, for one classification.
 *
 * Total over the absence tuple by construction: a fifth narrowing added to
 * `LEDGER_JUMP_ABSENCES` fails to compile at every caller until that caller says
 * what the new stage kept, which is the whole reason the stages arrive as a record
 * rather than as an array a caller could pass short or out of order.
 */
export type LedgerJumpStages = Readonly<Record<LedgerJumpAbsence, LedgerRowIdMembership>>;

/**
 * Where a jump lands, or why it did not.
 *
 * A discriminated result rather than `TimelineRow | undefined`, because each
 * failure calls for different words AND a different act: a narrowed-away row is
 * reached by clearing the filter, a folded one by opening its chapter, a withheld
 * one by leaving the replay, and a row the cap took by nothing this build can
 * press. Collapsing any two tells somebody to perform an act that cannot reach the
 * row they asked for — which is what one arm for every absence after the filter
 * did: it read "clear a filter" over a ledger with no filter on it.
 *
 * `not-in-loaded-log` is the one absence that is not a stage of the pipeline: no
 * narrowing dropped the row, because this window never held it.
 */
export type LedgerJumpOutcome =
  | { readonly status: "found"; readonly row: TimelineRow }
  | { readonly status: LedgerJumpAbsence; readonly row: TimelineRow }
  | { readonly status: "not-in-loaded-log" };

/**
 * Jump to an event by id — the design's second offer over this window.
 *
 * Takes the loaded rows and what every stage between them and the viewport kept,
 * which is the only reason it takes more than one window: the answer is not
 * whether the row is on screen but WHICH narrowing is the reason it is not, and
 * that is a question about the stages rather than about either end of them.
 */
export function jumpToEventId(
  loadedRows: readonly TimelineRow[],
  stages: LedgerJumpStages,
  eventId: string,
): LedgerJumpOutcome {
  const row = loadedRows.find((candidate) => candidate.id === eventId);
  if (row === undefined) {
    return { status: "not-in-loaded-log" };
  }
  for (const absence of LEDGER_JUMP_ABSENCES) {
    if (!stages[absence].has(eventId)) {
      return { status: absence, row };
    }
  }
  return { status: "found", row };
}

/**
 * Narrow or widen one participant, from a facet the bar rendered.
 *
 * A pure value in, a pure value out: the bar holds no filter of its own, so a chip
 * press is a derivation of the next filter rather than a mutation of the current
 * one. That is what lets the whole narrowing be driven by a test with no DOM.
 */
export function withToggledParticipant(filter: LedgerFilter, participantId: string): LedgerFilter {
  return { ...filter, participantIds: toggledMembership(filter.participantIds, participantId) };
}

/** Narrow or widen one event family, from a facet the bar rendered. */
export function withToggledCategory(filter: LedgerFilter, category: EventCategory): LedgerFilter {
  return { ...filter, categories: toggledMembership(filter.categories, category) };
}

/**
 * One axis' membership, toggled.
 *
 * Shared by both axes rather than written twice, because the rule is the axis-blind
 * half: present means admitted, and pressing an admitted value widens back. The two
 * wrappers above exist only to keep each axis' element type its own — a single
 * axis-keyed helper would have had to widen `EventCategory` to `string` and the
 * filter would have stopped refusing a family the contract does not carry.
 */
function toggledMembership<TValue extends string>(
  values: readonly TValue[],
  value: TValue,
): readonly TValue[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}
