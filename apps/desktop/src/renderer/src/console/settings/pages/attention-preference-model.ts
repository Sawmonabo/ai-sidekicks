// One rule for showing a preference whose keys nobody has named, and the one edit
// that rule permits.
//
// The stored value is `Record<string, unknown>` on purpose. `Spec-019` requires the
// preference pair to support per-surface preferences and scopes the store itself to
// global-per-participant, and it names no keys — so the console's shape is an opaque
// keyed value and stays one "until a document names the keys". A page that hardcoded
// a key would be naming a preference nothing registers, and a page that drew a
// default for a key the daemon did not send would be showing its own answer as the
// person's.
//
// SO THE PAGE HAS EXACTLY ONE RULE, AND IT IS STRUCTURAL
//
// A value every member of which is a boolean is a set of switches, and it is drawn
// as switches — one per member, labelled with the member's own name and nothing
// else. Any other value is shown read-only, exactly as it arrived. That decision is
// made HERE rather than in the page, because it is the whole of what the page knows
// about a vocabulary it was never given, and it has to be checkable without a
// browser.
//
// AN EMPTY RECORD IS NOT A SET OF SWITCHES
//
// Vacuously, every member of `{}` is a boolean. Drawing it as switches would render
// a key with nothing under it, which reads as a control that failed to paint. So the
// predicate requires at least one member and `{}` takes the read-only arm, where it
// renders as itself and says plainly that this is what the daemon holds.

import type { ConsoleBridge } from "../../bridge/index.js";
import { formatCount } from "../../primitives/index.js";

/**
 * What each of the three calls this page makes answers.
 *
 * Derived off the port rather than restated, on `collaboration/SentInvites.tsx`'s
 * rule: the bridge door exports the bridge and not the port's vocabulary, and a
 * hand-written copy of a reply shape is a second declaration nothing checks against
 * the first.
 */
export type CallerParticipantOutcome = Awaited<
  ReturnType<ConsoleBridge["growth"]["callerParticipantRead"]>
>;

export type AttentionPreferenceReadOutcome = Awaited<
  ReturnType<ConsoleBridge["growth"]["attentionPreferenceRead"]>
>;

/** One stored preference: an opaque key, and the record held under it. */
export type AttentionPreference = Extract<
  AttentionPreferenceReadOutcome,
  { readonly status: "served" }
>["value"]["preferences"][number];

/** One switch inside a preference whose members are all booleans. */
export interface PreferenceToggleMember {
  /**
   * Stable and unique across the whole set, so a pending write and a refusal can be
   * held against one switch rather than one preference. Two members of two different
   * preferences may share a name, which is why the key carries both — and why it is
   * a JSON pair rather than a joined string, which two keys containing the separator
   * could collide on.
   */
  readonly memberKey: string;
  /** The member's own name, verbatim. The page's label, and no other copy. */
  readonly name: string;
  readonly isEnabled: boolean;
}

/** How one stored preference is shown. Two arms, and the rule picks between them. */
export type PreferenceRow =
  | {
      readonly kind: "toggles";
      readonly key: string;
      /** The whole record, so an edit writes it back rather than a fragment of it. */
      readonly value: Readonly<Record<string, boolean>>;
      readonly members: readonly PreferenceToggleMember[];
    }
  | {
      readonly kind: "opaque";
      readonly key: string;
      /** The value as it arrived, rendered for reading and never for editing. */
      readonly rendering: string;
    };

/**
 * Whether a stored value is a set of switches.
 *
 * A type predicate rather than a boolean, so {@link flipMember} takes the narrowed
 * record and calling it on a value that was never checked is a compile error rather
 * than a convention.
 */
export function isToggleableValue(
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, boolean>> {
  const memberNames = Object.keys(value);
  return memberNames.length > 0 && memberNames.every((name) => typeof value[name] === "boolean");
}

/**
 * The whole value back, with one member flipped.
 *
 * The WHOLE value, because the update carries a record and not a patch — returning
 * one member would have the write erase every member beside it. A member the record
 * does not hold is returned unchanged rather than written as `true`: adding a key
 * would be this console putting a preference into a record the daemon owns, and the
 * projection never produces such a member, so this arm exists to make that
 * impossible rather than to be reached.
 */
export function flipMember(
  value: Readonly<Record<string, boolean>>,
  memberName: string,
): Readonly<Record<string, boolean>> {
  if (!Object.hasOwn(value, memberName)) {
    return value;
  }
  return { ...value, [memberName]: value[memberName] !== true };
}

/**
 * Project the stored set into rows, in the order the daemon sent them.
 *
 * Neither the preferences nor a value's members are re-ordered. Sorting would be the
 * console rearranging a record it does not understand, and a person comparing this
 * screen with the daemon's own record would find two different orders with nothing
 * to say which was the real one.
 */
export function projectPreferenceRows(
  preferences: readonly AttentionPreference[],
): readonly PreferenceRow[] {
  return preferences.map((preference) => {
    if (!isToggleableValue(preference.value)) {
      return {
        kind: "opaque",
        key: preference.key,
        rendering: renderOpaqueValue(preference.value),
      };
    }
    const toggleableValue = preference.value;
    return {
      kind: "toggles",
      key: preference.key,
      value: toggleableValue,
      members: Object.keys(toggleableValue).map((name) => ({
        memberKey: JSON.stringify([preference.key, name]),
        name,
        isEnabled: toggleableValue[name] === true,
      })),
    };
  });
}

/**
 * What a settled read says out loud, once.
 *
 * A refusal is carried VERBATIM — the daemon's own sentence, never paraphrased. The
 * served arm is phrased so no count needs a plural: "Stored: 0." and "Stored: 1."
 * both read as English.
 */
export function announcementFor(outcome: AttentionPreferenceReadOutcome): string {
  if (outcome.status === "unavailable") {
    return outcome.detail;
  }
  return `Your notification preferences were read. Stored: ${formatCount(outcome.value.preferences.length)}.`;
}

/**
 * A value shown for reading rather than editing.
 *
 * JSON, because the value arrived as JSON: what is rendered is the record the daemon
 * sent, in the notation it was sent in, with nothing summarised away. It is
 * serializable by construction for the same reason — it came off a JSON wire — so
 * there is no unrepresentable-value arm to handle here.
 */
function renderOpaqueValue(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(value);
}
