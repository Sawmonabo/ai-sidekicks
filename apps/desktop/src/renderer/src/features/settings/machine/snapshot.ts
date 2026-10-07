// The machine settings as a window holds them: the service's last answer, the members a write
// is in flight for, and the members whose last write was refused. Pure values;
// `store.ts` folds answers into them and `holder.ts` owns a
// store's lifetime.

import {
  MACHINE_SETTINGS_DEFAULTS,
  type MachineSettings,
  type MachineSettingsReading,
} from "@ai-sidekicks/contracts/machine-settings";

import type { Refusal } from "#renderer/lib/refusal/contract.js";

/** One member of the settings file, which is what one write changes. */
export type MachineSettingsMember = keyof MachineSettings;

/** Everything a settings row needs, rebuilt on transition and held by identity. */
export interface MachineSettingsSnapshot {
  /** The service's last answer, or `undefined` before its feed first delivered. */
  readonly reading: MachineSettingsReading | undefined;
  /** Every member whose write is in flight; a set, since two quick writes are independent. */
  readonly pendingMembers: ReadonlySet<MachineSettingsMember>;
  /** The refusal each member's last write was answered with, dropped when it is written again. */
  readonly refusalByMember: ReadonlyMap<MachineSettingsMember, Refusal>;
  /** Why the feed could not be opened, until it opens again or delivers. */
  readonly readRefusal: Refusal | undefined;
}

/**
 * What a window reads before its store has been acquired or answered. The binding renders it
 * while the acquiring effect settles, so it must equal the store's own opening snapshot.
 */
export const NOTHING_CHOSEN: MachineSettingsSnapshot = {
  reading: undefined,
  pendingMembers: new Set(),
  refusalByMember: new Map(),
  readRefusal: undefined,
};

/** The settings a row shows: the service's answer, or the defaults before it answered. */
export function effectiveSettings(snapshot: MachineSettingsSnapshot): MachineSettings {
  return snapshot.reading?.settings ?? MACHINE_SETTINGS_DEFAULTS;
}
