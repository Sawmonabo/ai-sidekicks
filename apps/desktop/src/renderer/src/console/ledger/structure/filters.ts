// Filters and jumps over the loaded window.
//
// `Spec-023 §Console Design (Meridian)` §5.19: "Filter by participant and by event
// family, jump to event by id, scroll to tail: renderer-local over the loaded
// window and cursors."
//
// ONE RULE IS LOAD-BEARING AND IT IS NOT A CONVENIENCE. §5.19: "a filtered
// subscription still receives `rollback_boundary` rows for any run whose rows the
// filter admits." A rollback boundary is what marks the rows around it superseded;
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
 * Where a jump lands, or why it did not.
 *
 * A discriminated result rather than `TimelineRow | undefined`, because the two
 * failures call for different words: an id nobody in this window carries may still
 * be a real event earlier in the session ("load earlier"), while an id the filter
 * is currently hiding is reachable by clearing the filter. Collapsing them would
 * tell a person to load rows they already have.
 */
export type LedgerJumpOutcome =
  | { readonly status: "found"; readonly row: TimelineRow }
  | { readonly status: "hidden-by-filter"; readonly row: TimelineRow }
  | { readonly status: "outside-window" };

/**
 * Jump to an event by id. §5.19's second offer.
 *
 * Takes the whole window and the filtered view so it can tell the two failures
 * apart — which is the only reason it takes both.
 */
export function jumpToEventId(
  rows: readonly TimelineRow[],
  visibleRows: readonly TimelineRow[],
  eventId: string,
): LedgerJumpOutcome {
  const row = rows.find((candidate) => candidate.id === eventId);
  if (row === undefined) {
    return { status: "outside-window" };
  }
  return visibleRows.some((candidate) => candidate.id === eventId)
    ? { status: "found", row }
    : { status: "hidden-by-filter", row };
}

/**
 * The window's last row, which "scroll to tail" scrolls to. §5.19's third offer.
 *
 * A function over the visible rows rather than a stored "at tail" flag: the tail
 * moves whenever a row lands, and a stored flag would be a second record of where
 * the log ends.
 */
export function tailRowId(visibleRows: readonly TimelineRow[]): string | undefined {
  return visibleRows[visibleRows.length - 1]?.id;
}
