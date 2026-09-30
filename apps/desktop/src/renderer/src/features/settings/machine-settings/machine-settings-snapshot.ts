// The machine settings as a window holds them: the service's last answer and the members a
// write is in flight for. Pure values; `machine-settings-store.ts` folds answers into them and
// `machine-settings-holder.ts` owns a store's lifetime.

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
  /** Every member whose write is in flight; a set, since two quick writes are independent. */
  readonly pendingMembers: ReadonlySet<MachineSettingsMember>;
  /** Bumped on every transition, so `useSyncExternalStore` sees a new identity. */
  readonly revision: number;
}

/**
 * What a window reads before its store has been acquired or answered. The binding renders it
 * while the acquiring effect settles, so it must equal the store's own opening snapshot.
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
