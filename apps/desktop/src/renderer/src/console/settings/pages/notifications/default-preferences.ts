// What this page shows for a trigger the daemon holds no record for.
//
// THE PAGE USED TO SHOW A SENTENCE AND NO CONTROLS. A participant with nothing stored
// read "the daemon holds no preference for you yet" and had no way to make one — which
// inverts the surface: the empty state is exactly the state a person arrives in, and
// the one where they most need a switch. So the empty arm now draws every preference
// at its default, tagged as a default, and flipping one writes it. The tag is what
// keeps rule 8's distinction intact: a default drawn without one reads as the person's
// own answer to a question nobody put to them.
//
// WHICH PREFERENCES, AND WHY THEY ARE NOT INVENTED HERE. `Spec-019` names no
// preference keys, and a page that made some up would be minting a vocabulary. What it
// DOES register — in the `AttentionItem` union, transcribed into
// `bridge/wire-shapes/attention-projection.ts` and closed at six — is the set of things
// that can earn a person's attention at all. A preference set keyed by those triggers
// therefore adds no vocabulary: every key here is a value the corpus already fixes, and
// a seventh trigger reaches this module by failing to compile.
//
// THE ONE THING THIS MODULE DOES NAME is the member inside the record, because a write
// carries `Record<string, unknown>` and cannot be performed without one. It is declared
// once below, it is the only member any default record carries, and it is deliberately
// not per-trigger: one name repeated six times is one claim, and six names would be six.
//
// A DEFAULT IS NEVER MERGED INTO A STORED RECORD. Where the daemon holds a key, that
// record is rendered exactly as it arrived, members and order untouched — the defaults
// fill gaps in the SET and never gaps inside a value. A console that completed a
// daemon's record would be showing a record the daemon does not hold.

import { ATTENTION_TRIGGERS, type AttentionTrigger } from "../../../bridge/index.js";
import type { AttentionPreference } from "./attention-preference-model.js";

/**
 * The one member a default record carries.
 *
 * Exported because the suite asserts the written record's shape directly: the claim is
 * that a flipped default writes THIS member and nothing beside it, and a case that
 * spelled the name again would agree with this module until one of them moved.
 */
export const DEFAULT_PREFERENCE_MEMBER = "notify";

/**
 * Every trigger notifies until somebody says otherwise.
 *
 * ON rather than off, because the alternative is a console that silently withholds
 * attention a person never asked it to withhold — and `Spec-019`'s own requirement is
 * that actionable attention survives even a denied operating system. A default of
 * `false` would make the quiet state the one nobody chose.
 */
const DEFAULT_PREFERENCE_ENABLED = true;

/** What one trigger's record is before anybody has stored one. */
export function defaultPreferenceFor(trigger: AttentionTrigger): AttentionPreference {
  return { key: trigger, value: { [DEFAULT_PREFERENCE_MEMBER]: DEFAULT_PREFERENCE_ENABLED } };
}

/** The stored set, and which of its rows this console supplied rather than read. */
export interface PreferencesWithDefaults {
  /** The daemon's own records first, in its order, then a default per missing trigger. */
  readonly preferences: readonly AttentionPreference[];
  /** The keys nobody has stored. Every one of them is tagged on screen. */
  readonly defaultedKeys: ReadonlySet<string>;
}

/**
 * The stored set with a default row for every trigger it does not mention.
 *
 * The daemon's rows keep their own order and come first, because they are the answer
 * to the question that was actually asked; the defaults follow in the registered
 * trigger order, which is the only order this console has for them. A stored record
 * whose key is not a registered trigger is still rendered — the store is keyed by an
 * opaque string and this page has never claimed otherwise.
 */
export function preferencesWithDefaults(
  stored: readonly AttentionPreference[],
): PreferencesWithDefaults {
  const storedKeys = new Set(stored.map((preference) => preference.key));
  const missing = ATTENTION_TRIGGERS.filter((trigger) => !storedKeys.has(trigger));
  return {
    preferences: [...stored, ...missing.map(defaultPreferenceFor)],
    defaultedKeys: new Set<string>(missing),
  };
}
