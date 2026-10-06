// What a read answered: the record, its absence, or the failure to find out.
//
// `UiStateStore.read` resolves `undefined` both for a record never written and for a read the
// adapter could not perform, and a caller handed the second reads it as the first. A caller that
// writes a value derived from the absence back over the record would then destroy what the
// adapter still holds, so the outcomes are a closed union: no caller can read one half and
// forget the other. `failed` is a value, so the store's reads still never throw.

import { type StoredRecord } from "./adapter.js";

/** What one read answered. */
export type PersistenceReadOutcome =
  | { readonly outcome: "present"; readonly record: StoredRecord }
  | { readonly outcome: "absent" }
  | { readonly outcome: "failed" };

/**
 * The two answers that carry nothing, minted once each so callers that memoize on the outcome
 * do not see a new identity per read.
 */
export const PERSISTENCE_READ_ABSENT: PersistenceReadOutcome = Object.freeze({ outcome: "absent" });

/** The read outcome for a record that could not be read. */
export const PERSISTENCE_READ_FAILED: PersistenceReadOutcome = Object.freeze({ outcome: "failed" });

/**
 * The record a read found, or `undefined` for either kind of nothing.
 *
 * The one lossy projection, so `read` and `readGlobal` cannot become a second read path that
 * answers differently. A caller for which absent and failed decide differently takes the
 * outcome instead.
 */
export function recordFromReadOutcome(outcome: PersistenceReadOutcome): StoredRecord | undefined {
  return outcome.outcome === "present" ? outcome.record : undefined;
}
