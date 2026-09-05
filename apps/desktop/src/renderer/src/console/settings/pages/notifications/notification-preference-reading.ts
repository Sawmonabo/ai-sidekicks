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

import {
  normalizeWireRejection,
  refuse,
  type ConsoleRefusal,
  type WireRefusal,
} from "../../../core/index.js";
import {
  isToggleableValue,
  type AttentionPreferenceReadOutcome,
  type PreferenceRow,
} from "./attention-preference-model.js";

/** The subsystem name every refusal this pair of modules raises carries. */
export const NOTIFICATION_PREFERENCE_REFUSAL_ORIGIN = "notification-preferences";

/**
 * Every code this pair of modules mints, declared once.
 *
 * A refusal the DAEMON codes never appears here — that code is the daemon's and
 * reaches the surface verbatim. These two are the console's own observations: a
 * rejection that carried no code at all, and a stored record this console read and
 * found unwritable.
 */
export const NOTIFICATION_PREFERENCE_REFUSAL_CODES: readonly [
  "write-rejected",
  "record-no-longer-switches",
] = ["write-rejected", "record-no-longer-switches"];

/** One code this pair of modules mints. */
export type NotificationPreferenceRefusalCode =
  (typeof NOTIFICATION_PREFERENCE_REFUSAL_CODES)[number];

const [
  WRITE_REJECTED_CODE,
  RECORD_NO_LONGER_SWITCHES_CODE,
]: typeof NOTIFICATION_PREFERENCE_REFUSAL_CODES = NOTIFICATION_PREFERENCE_REFUSAL_CODES;

/** What this seam says about its own half of a failed write. Never the daemon's words. */
const WRITE_NOT_SAVED_SENTENCE = "This change was not saved.";

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
 * Through `normalizeWireRejection`, the console's single door, and not through
 * `wireRejectionToError` — the repository carries two functions whose descriptions
 * both read "normalize a wire rejection", and the second flattens everything onto
 * `Error.name`. A daemon refusing a preference write over JSON-RPC carries the
 * numeric JSON-RPC code at `code` and the registered dotted one at `data.type`, so
 * the flattening arm put the JS CLASS NAME — `JsonRpcRemoteError` — where rule 9
 * requires the refuser's own code, for the pressed switch and every queued flip
 * behind it. It also dropped the retry bounds `error-contracts.md §Rate Limiting`
 * registers, so a rate-limited write could not say when to try again.
 *
 * The fallback is reached only where the rejection carries no code of its own, and
 * its code comes from {@link NOTIFICATION_PREFERENCE_REFUSAL_CODES} rather than
 * being spelled here, so this module's vocabulary is one closed set.
 */
export function rejectionRefusal(rejection: unknown): WireRefusal {
  return normalizeWireRejection(NOTIFICATION_PREFERENCE_REFUSAL_ORIGIN, rejection, {
    code: WRITE_REJECTED_CODE,
    detail: WRITE_NOT_SAVED_SENTENCE,
  });
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
    RECORD_NO_LONGER_SWITCHES_CODE,
    `${WRITE_NOT_SAVED_SENTENCE} The stored record is no longer a set of switches, so there was nothing to write it against.`,
  );
}
