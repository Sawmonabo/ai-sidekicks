// How one ledger row is built, shared by every plane module beside it.
//
// The row constructor and nothing else. It sits in its own module because nine plane
// modules call it and a helper declared in one of them would make the other eight
// import a sibling for something none of them owns — the edge `growth-entry.ts`
// already refuses for the row's TYPE, refused again here for its construction.
//
// `liveStatus` is not a parameter. Every operation in this ledger is fixture-only by
// definition: a row that went live left the ledger for `daemon-reply-registry.ts` in
// the same change. A parameter here would be a knob whose only correct argument is
// the default.

import type {
  GrowthOperationEntry,
  GrowthOperationId,
  GrowthOperationKind,
} from "../growth-entry.js";
import type { GrowthSlateRowId } from "../growth-slate.js";

/**
 * One ledger row.
 *
 * Named for its call sites rather than for itself: it appears once per row in tables
 * whose whole subject is the rows, and a longer name would be the widest column in
 * every one of them. The name is the single table's own and is kept rather than
 * renamed, per the local-convention clause of the repo's identifier rule.
 */
export function op(
  id: GrowthOperationId,
  slateRow: GrowthSlateRowId,
  kind: GrowthOperationKind,
  summary: string,
  expectedWireMethod?: string,
): GrowthOperationEntry {
  return { id, slateRow, kind, summary, expectedWireMethod, liveStatus: "fixture-only" };
}
