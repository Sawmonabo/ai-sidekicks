// Reading a stored preference record back, and saying why it could not be read.
//
// Three pure functions and one narrowed row type, split out of the writer beside
// them because they answer a different question. The writer owns a lifetime — a
// generation, a queue, a subscription — and these own none: each is total over its
// arguments, so a case that is awkward to reach through a queued flip is one line
// to assert directly.
//
// The refusal constructors are here rather than at their call sites for the reason
// `apps/desktop/AGENTS.md` gives for every chokepoint: two spellings of one refusal
// drift, and the drift is invisible because both render.

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { wireRejectionToError } from "../../../../../shared/wire-errors.js";
import {
  isToggleableValue,
  type AttentionPreferenceReadOutcome,
  type PreferenceRow,
} from "./attention-preference-model.js";

/** The subsystem name every refusal this pair of modules raises carries. */
export const NOTIFICATION_PREFERENCE_REFUSAL_ORIGIN = "notification-preferences";

/** One preference drawn as switches. Narrowed off the projection's own union. */
export type TogglePreferenceRow = Extract<PreferenceRow, { readonly kind: "toggles" }>;

/**
 * The stored record under `recordKey`, if the set still holds it as switches.
 *
 * `undefined` covers three different facts — the read refused, the record is gone,
 * the value stopped being a set of booleans — and they share one consequence: there
 * is no value a queued flip can be composed against.
 */
export function toggleableValueFor(
  outcome: AttentionPreferenceReadOutcome,
  recordKey: string,
): Readonly<Record<string, boolean>> | undefined {
  if (outcome.status !== "served") {
    return undefined;
  }
  const stored = outcome.value.preferences.find((preference) => preference.key === recordKey);
  if (stored === undefined || !isToggleableValue(stored.value)) {
    return undefined;
  }
  return stored.value;
}

/**
 * A rejection this seam is not supposed to raise, widened into the one refusal shape.
 *
 * Through the repository's single wire-rejection normalizer rather than a local
 * `instanceof Error` ladder: it puts a wire code on the name instead of rendering
 * `[object Object]`, and its total arm cannot throw while composing the sentence that
 * says something failed.
 */
export function rejectionRefusal(rejection: unknown): ConsoleRefusal {
  const normalized = wireRejectionToError(rejection, { total: true });
  return refuse(
    NOTIFICATION_PREFERENCE_REFUSAL_ORIGIN,
    normalized.name,
    `This change was not saved. ${normalized.message}`,
  );
}

/**
 * Why a queued toggle could not be composed.
 *
 * A refused re-read carries its own words verbatim — it IS the reason, and
 * paraphrasing the daemon is what rule 9 forbids. A served set that no longer holds
 * the record as switches is this console's own observation, so it says only what it
 * saw and never why the record changed.
 */
export function unwritableRecordRefusal(outcome: AttentionPreferenceReadOutcome): ConsoleRefusal {
  if (outcome.status === "unavailable") {
    return outcome;
  }
  return refuse(
    NOTIFICATION_PREFERENCE_REFUSAL_ORIGIN,
    "record-no-longer-switches",
    "This change was not saved. The stored record is no longer a set of switches, so there was nothing to write it against.",
  );
}
