// How one ledger row is built, shared by every plane module beside it.
//
// The row constructor and nothing else. It sits in its own module because eighteen
// plane modules call it and a helper declared in one of them would make the other
// seventeen import a sibling for something none of them owns — the edge
// `growth-entry.ts` already refuses for the row's TYPE, refused again here for its
// construction.
//
// `liveStatus` is not a parameter. Every operation in this ledger is fixture-only by
// definition: a row that went live left the ledger for `daemon-reply-registry.ts` in
// the same change. A parameter here would be a knob whose only correct argument is
// the default.
//
// THE SENTENCE DESCRIBING AN OPERATION IS NOT A PARAMETER EITHER, and that is a
// different reason: it is not this row's member at all. Every sentence lives in
// `operation-summaries.ts`, one `Record` over the same closed id set, in a module no
// production module imports — the split is by CONSUMER, and that file states the
// reading. Passing one through here would put it back on the row this constructor
// builds, which is the object the initial import graph carries.

import type {
  GrowthOperationEntry,
  GrowthOperationId,
  GrowthOperationKind,
} from "../growth-port/growth-entry.js";
import type { GrowthSlateRowId } from "../growth-port/growth-slate-row.js";

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
  expectedWireMethod?: string,
): GrowthOperationEntry {
  return { id, slateRow, kind, expectedWireMethod, liveStatus: "fixture-only" };
}
