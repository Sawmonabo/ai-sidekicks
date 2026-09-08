// What a read answered: the record, its absence, or the failure to find out.
//
// THREE OUTCOMES, BECAUSE TWO OF THEM DECIDE DIFFERENT THINGS. `UiStateStore.read`
// resolves `undefined` for a record that was never written AND for a read the adapter
// could not perform, and a caller handed the second reads it as the first: a store
// that does not know has told it nothing was ever saved. The deck's layout restore is
// the case that made it matter — it read `undefined`, opened its fallback ledger pane,
// counted zero restored panes, and wrote that fallback, so one transient read failure
// replaced a saved arrangement the adapter was still holding.
//
// A CLOSED UNION RATHER THAN A RECORD BESIDE A FLAG, so no caller can read one half
// and forget the other: every arm is named, the discriminant is total, and a fourth
// answer would have to be decided here before any surface could render it.
//
// THE STORE STILL NEVER THROWS. `failed` is a VALUE — `ui-state-store.ts` rule 3 is
// widened by this module, not withdrawn by it.

import { type StoredRecord } from "./adapter.js";

/** What one read answered. */
export type PersistenceReadOutcome =
  | { readonly outcome: "present"; readonly record: StoredRecord }
  | { readonly outcome: "absent" }
  | { readonly outcome: "failed" };

/**
 * The two answers that carry nothing, minted once each.
 *
 * A fresh object per read would be a new identity for a value with no fields, which
 * is a re-render for callers that memoise on the outcome and tells nobody anything.
 */
export const PERSISTENCE_READ_ABSENT: PersistenceReadOutcome = Object.freeze({ outcome: "absent" });

export const PERSISTENCE_READ_FAILED: PersistenceReadOutcome = Object.freeze({ outcome: "failed" });

/**
 * The record a read found, or `undefined` for either kind of nothing.
 *
 * The lossy projection written ONCE, so `read` and `readGlobal` are derived from the
 * outcome rather than being a second read path that could answer differently. A caller
 * for which absent and failed decide the same thing takes those two rather than
 * flattening the union itself.
 */
export function recordFromReadOutcome(outcome: PersistenceReadOutcome): StoredRecord | undefined {
  return outcome.outcome === "present" ? outcome.record : undefined;
}
