// How every sidebar section body splits its rows into groups, in one place.
//
// `Spec-023 §The surface set` makes each sidebar section "a composition of its own
// read, opening panes", and the sidebar's own density rule is counts, not lists,
// until a section is open. What each body then draws is the same three things — a
// count, a heading per group, and a row that opens a pane — over rows of its own
// shape. THE GROUPING IS THE PART THAT IS IDENTICAL, so it lives here rather than
// once per body: three near-copies of a fold is how the fourth section gets a
// different sort order than its neighbours and nobody notices.
//
// WHAT IS THIS MODULE'S AND WHAT IS THE SECTION'S. This module owns the SHAPE of the
// fold — filter first, then group, then order within a group, with absent rather than
// empty entries so a caller draws a heading only for a group that has rows. Which
// group a row belongs to, what a filter matches, and what a row is ordered by are the
// section's own answers, because only the section knows what its rows are called and
// what its wire vocabulary means.
//
// IN `seats/` FOR `SidebarSectionList.tsx`'s REASON: three families own the three
// bodies and one view family may not import another, so a fold parked in any one of
// them would have been reachable by exactly one of its callers.
//
// GENERIC OVER THE ROW, because the three bodies do not share one. Runs and approvals
// read projected `ConsoleEntity` rows out of the session store; the agent roster reads
// wire rows off a growth reply. A fold written against the store's entity would have
// left the third body with a copy.

import { compareInstants, parseInstant } from "../../core/index.js";

/** What a body tells this fold about its own rows. */
export interface RowGroupingRules<TRow, TGroup extends string> {
  /** Which group this row sorts into. Total by construction: the caller's own table. */
  readonly groupOf: (row: TRow) => TGroup;
  /**
   * Whether the sidebar's filter keeps this row.
   *
   * Already bound to the query by the caller, because what a filter matches — a title,
   * a path, an identifier, a state — is the section's own vocabulary. A section with
   * no filtering to do passes a predicate that always answers true, which is a claim
   * rather than an omission.
   */
  readonly matches: (row: TRow) => boolean;
  /**
   * The instant this row is ordered by, wire-verbatim, or `undefined` where the wire
   * carried none.
   *
   * Ordered as MOMENTS and never lexically: lexical order agrees with instant order
   * only while every stamp carries the same offset, and no section gets to assume the
   * wire never sends another one. A row with no instant sorts after the ones that have
   * one rather than being dropped — a row is a row whether or not it is stamped.
   */
  readonly orderedBy: (row: TRow) => string | undefined;
}

/**
 * Split rows into their groups, newest first inside each, dropping what the filter
 * excludes.
 *
 * A `Map` with ABSENT rather than empty entries, so a caller renders a heading only
 * for a group that has rows — the alternative, four headings of which three say
 * nothing, is the chrome the sidebar's counts-not-lists density rule exists to avoid.
 */
export function groupSectionRows<TRow, TGroup extends string>(
  rows: readonly TRow[],
  rules: RowGroupingRules<TRow, TGroup>,
): ReadonlyMap<TGroup, readonly TRow[]> {
  const grouped = new Map<TGroup, TRow[]>();
  for (const row of rows) {
    if (!rules.matches(row)) {
      continue;
    }
    const group = rules.groupOf(row);
    const existing = grouped.get(group);
    if (existing === undefined) {
      grouped.set(group, [row]);
    } else {
      existing.push(row);
    }
  }
  for (const groupRows of grouped.values()) {
    groupRows.sort((left, right) =>
      compareInstants(
        parseInstant(rules.orderedBy(left) ?? ""),
        parseInstant(rules.orderedBy(right) ?? ""),
        "newest-first",
      ),
    );
  }
  return grouped;
}

/** How many rows survived the filter, across every group. */
export function groupedRowCount<TGroup extends string, TRow>(
  grouped: ReadonlyMap<TGroup, readonly TRow[]>,
): number {
  let total = 0;
  for (const rows of grouped.values()) {
    total += rows.length;
  }
  return total;
}

/**
 * Normalise the sidebar's filter field for matching, once per render rather than per
 * row.
 *
 * `toLocaleLowerCase` and not `toLowerCase`, because the field takes whatever a person
 * types and the two disagree on more alphabets than they agree on.
 */
export function normaliseFilterQuery(filterQuery: string | undefined): string {
  return (filterQuery ?? "").trim().toLocaleLowerCase();
}
