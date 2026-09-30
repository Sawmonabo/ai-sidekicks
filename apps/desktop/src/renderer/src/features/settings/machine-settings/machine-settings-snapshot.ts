// The machine settings as a window holds them: the service's last answer, and which
// members a write is still in flight for.
//
// The settings are the machine's own file, which the background service alone writes
// and every window reads through its live feed. Nothing here holds a bridge or a
// subscription; every function is total over its arguments. `machine-settings-store.ts`
// folds the service's answers into these values and `machine-settings-holder.ts` owns a
// store's lifetime.

import {
  MACHINE_SETTINGS_DEFAULTS,
  type MachineSettings,
  type MachineSettingsReading,
} from "@ai-sidekicks/contracts";

/** One member of the settings file, which is what one write changes. */
export type MachineSettingsMember = keyof MachineSettings;

/** Everything a settings row needs, rebuilt on transition and held by identity. */
export interface MachineSettingsSnapshot {
  /** The service's last answer, or `undefined` before its feed first delivered. */
  readonly reading: MachineSettingsReading | undefined;
  /**
   * Every member whose write is in flight. A SET, because one write changes one member
   * and two members chosen in quick succession are two independent acts.
   */
  readonly pendingMembers: ReadonlySet<MachineSettingsMember>;
  /** Bumped on every transition, so `useSyncExternalStore` sees a new identity. */
  readonly revision: number;
}

/**
 * What a window reads before its store has been acquired or answered.
 *
 * Exported because the React binding beside this module renders it while its acquiring
 * effect settles: the opening arm a page draws has to be the SAME snapshot the store
 * itself opens on.
 */
export const NOTHING_CHOSEN: MachineSettingsSnapshot = {
  reading: undefined,
  pendingMembers: new Set(),
  revision: 0,
};

/** The settings a row shows: the service's answer, or the defaults before it answered. */
export function effectiveSettings(snapshot: MachineSettingsSnapshot): MachineSettings {
  return snapshot.reading?.settings ?? MACHINE_SETTINGS_DEFAULTS;
}
