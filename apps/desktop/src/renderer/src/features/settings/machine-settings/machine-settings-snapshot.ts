// The machine settings vocabulary: the key set, the readings, and the snapshot.
//
// Three toggles across three pages are the same kind of value, a boolean the main process owns
// rather than the daemon or the session: the OS-toast mute, automatic updates, and the
// crash-reporting opt-out. Nothing here holds a bridge, a generation or a subscription;
// every function is total over its arguments, so the precedence rule can be asserted
// directly. `machine-settings-store.ts` folds a settings file's answers into these values and
// `machine-settings-holder.ts` owns a store's lifetime.

/**
 * The machine settings this console has a control for. Closed, and the single
 * declaration: the defaults table below is keyed by the derived union, so a fourth
 * key without a default is a compile error rather than a silently-`false` toggle.
 */
export const MACHINE_SETTING_KEYS = [
  "notifications.osToastsMuted",
  "updates.automatic",
  "diagnostics.crashReports",
] as const;

/** One machine setting. Derived from the enumeration, never restated beside it. */
export type MachineSettingKey = (typeof MACHINE_SETTING_KEYS)[number];

/**
 * The latch key the opening read is on, in a space the preference keys share.
 *
 * Not a preference key, and checkably so rather than by inspection: every member of
 * {@link MACHINE_SETTING_KEYS} is a dotted `group.control` name and this one carries
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
export const MACHINE_SETTING_DEFAULTS: Readonly<Record<MachineSettingKey, boolean>> = {
  "notifications.osToastsMuted": false,
  "updates.automatic": true,
  "diagnostics.crashReports": true,
};

/** What the one settings file read answered. */
export type MachineSettingReading =
  | { readonly kind: "not-read" }
  | { readonly kind: "read"; readonly values: Readonly<Record<string, boolean>> };

/** Everything a toggle row needs, rebuilt on transition and held by identity. */
export interface MachineSettingsSnapshot {
  readonly reading: MachineSettingReading;
  /**
   * Every key whose write is in flight. A SET, because the settings file updates one key
   * per call and two keys chosen in quick succession are two independent acts.
   */
  readonly pendingKeys: ReadonlySet<MachineSettingKey>;
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
export const NOTHING_CHOSEN: MachineSettingsSnapshot = {
  reading: { kind: "not-read" },
  pendingKeys: new Set(),
  revision: 0,
};

/** The value a row shows: the settings file's, then the default. */
export function effectivePreference(
  snapshot: MachineSettingsSnapshot,
  key: MachineSettingKey,
): boolean {
  if (snapshot.reading.kind === "read") {
    const stored = snapshot.reading.values[key];
    if (stored !== undefined) {
      return stored;
    }
  }
  return MACHINE_SETTING_DEFAULTS[key];
}

/** The settings file's own record, with one key applied. Never a second copy beside it. */
export function appliedReading(
  reading: MachineSettingReading,
  key: MachineSettingKey,
  enabled: boolean,
): MachineSettingReading {
  return reading.kind === "read"
    ? { kind: "read", values: { ...reading.values, [key]: enabled } }
    : { kind: "read", values: { [key]: enabled } };
}
