// The shell preference vocabulary: the key set, the readings, and the snapshot.
//
// Three toggles across three pages are the same kind of value — a boolean the SHELL
// owns rather than the daemon or the session: the OS-toast mute
// (`Spec-023 §Console Design (Meridian)` §Notifications, "Mute OS toasts for this
// machine, renderer-local"), automatic updates ("renderer-local preference"), and
// the crash-reporting opt-out ("through the shell-config preference carrier on the
// growth slate … held renderer-side until that carrier lands").
//
// WHAT THIS MODULE IS. The closed key set, what each key reads as before anybody
// chooses, the three answers a carrier can give, the snapshot those fold into, and
// the pure functions that read and rewrite one. Nothing here holds a bridge, a
// generation, or a subscription — every function is total over its arguments, which
// is what lets the precedence rule be asserted directly rather than through a
// rendered row.
//
// WHAT IS NEXT DOOR. `shell-preferences-store.ts` is the STATE MACHINE that folds a
// carrier's answers into these values; `shell-preferences-holder.ts` is the LIFETIME
// question — who owns a store for how long, and how React acquires one. Three
// modules because they are reviewed against three different questions, and the file
// that held the first two was long enough that neither was legible.
//
// NOTHING HERE PERSISTS, AND THE COPY SAYS SO
//
// `console/persistence/` admits a closed value-class enumeration and a preference is
// none of them. Widening that set is a spec amendment rather than a page's decision,
// so a held value lives for this window's lifetime and every consumer renders the
// note rather than implying a durable write nothing performed.

import type { ConsoleRefusal } from "../../../core/index.js";
import type { ConsoleBridge } from "../../../bridge/index.js";

/** What one carrier read answers. Derived off the port rather than restated. */
export type ShellConfigReadOutcome = Awaited<
  ReturnType<ConsoleBridge["growth"]["shellConfigRead"]>
>;

/**
 * The shell preferences this console has a control for. Closed, and the single
 * declaration: the defaults table below is keyed by the derived union, so a fourth
 * key without a default is a compile error rather than a silently-`false` toggle.
 *
 * The strings are the CONSOLE's names for its own controls, in the growth port's
 * terms — the port's header states its request types are the console's and not a
 * claim about an eventual wire shape — so nothing here composes a method string or
 * a field the corpus registers.
 */
export const SHELL_PREFERENCE_KEYS = [
  "notifications.osToastsMuted",
  "updates.automatic",
  "diagnostics.crashReports",
] as const;

/** One shell preference. Derived from the enumeration, never restated beside it. */
export type ShellPreferenceKey = (typeof SHELL_PREFERENCE_KEYS)[number];

/**
 * The latch key the opening read is on, in a space the preference keys share.
 *
 * Not a preference key, and checkably so rather than by inspection: every member of
 * {@link SHELL_PREFERENCE_KEYS} is a dotted `group.control` name and this one carries
 * no dot, so it collides with none of them however that enumeration grows. The store
 * asserts it.
 */
export const OPENING_READ_KEY = "opening-read";

/**
 * What each preference is before anybody has chosen.
 *
 * Automatic updates and crash reporting are ON by default because the corpus makes
 * them so — crash reporting is "enabled by default with PII-stripping; user may opt
 * out via settings" — and the toast mute is OFF because muting by default would
 * silence attention nobody asked to silence.
 */
export const SHELL_PREFERENCE_DEFAULTS: Readonly<Record<ShellPreferenceKey, boolean>> = {
  "notifications.osToastsMuted": false,
  "updates.automatic": true,
  "diagnostics.crashReports": true,
};

/** What the one carrier read answered. Total; every arm renders something. */
export type ShellPreferenceReading =
  | { readonly kind: "not-read" }
  | { readonly kind: "read"; readonly values: Readonly<Record<string, boolean>> }
  | { readonly kind: "unavailable"; readonly refusal: ConsoleRefusal };

/** Everything a toggle row needs, rebuilt on transition and held by identity. */
export interface ShellPreferenceSnapshot {
  readonly reading: ShellPreferenceReading;
  /** Values chosen in this window that no carrier has taken. */
  readonly heldLocally: Readonly<Record<string, boolean>>;
  /**
   * Every key whose write is in flight. A SET, because the carrier updates one key
   * per call and two keys chosen in quick succession are two independent acts: one
   * key here drew the second choice's spinner over the first and then cleared BOTH
   * on the first settlement, so a row still writing said it had finished.
   */
  readonly pendingKeys: ReadonlySet<ShellPreferenceKey>;
  /** The last refusal per key. Cleared when that key is attempted again. */
  readonly refusalByKey: Readonly<Record<string, ConsoleRefusal>>;
  /** Bumped on every transition, so `useSyncExternalStore` sees a new identity. */
  readonly revision: number;
}

/**
 * What a window reads before its store has been acquired or asked anything.
 *
 * Exported because the React binding next door renders it while its acquiring effect
 * settles: the opening arm a page draws has to be the SAME snapshot the store itself
 * opens on, and a second literal there would be a second answer to "nothing has
 * happened yet" that nothing keeps equal to this one.
 */
export const NOTHING_CHOSEN: ShellPreferenceSnapshot = {
  reading: { kind: "not-read" },
  heldLocally: {},
  pendingKeys: new Set(),
  refusalByKey: {},
  revision: 0,
};

/** The subsystem name every refusal this module raises carries. */
export const SHELL_PREFERENCE_REFUSAL_ORIGIN = "shell-preferences";

/**
 * What this store calls a rejection that named no code of its own.
 *
 * Declared once because both the write path and the opening read reach it, and a
 * second spelling in either place is a rename waiting to go half-applied.
 */
export const PREFERENCE_WRITE_FAILED = "preference-write-failed";

/**
 * The value a row shows: this window's choice, then the carrier's, then the default.
 *
 * Exported because the store's own test asserts the precedence directly rather than
 * through a rendered row — the ordering is the rule, and a test that saw it only
 * through a component would be asserting the component instead.
 */
export function effectivePreference(
  snapshot: ShellPreferenceSnapshot,
  key: ShellPreferenceKey,
): boolean {
  const held = snapshot.heldLocally[key];
  if (held !== undefined) {
    return held;
  }
  if (snapshot.reading.kind === "read") {
    const stored = snapshot.reading.values[key];
    if (stored !== undefined) {
      return stored;
    }
  }
  return SHELL_PREFERENCE_DEFAULTS[key];
}

/** The carrier's own record, with one key applied. Never a second copy beside it. */
export function appliedReading(
  reading: ShellPreferenceReading,
  key: ShellPreferenceKey,
  enabled: boolean,
): ShellPreferenceReading {
  return reading.kind === "read"
    ? { kind: "read", values: { ...reading.values, [key]: enabled } }
    : { kind: "read", values: { [key]: enabled } };
}

export function withoutKey<TValue>(
  entries: Readonly<Record<string, TValue>>,
  key: string,
): Readonly<Record<string, TValue>> {
  if (!Object.hasOwn(entries, key)) {
    return entries;
  }
  const remaining: Record<string, TValue> = {};
  for (const [heldKey, value] of Object.entries(entries)) {
    if (heldKey !== key) {
      remaining[heldKey] = value;
    }
  }
  return remaining;
}
