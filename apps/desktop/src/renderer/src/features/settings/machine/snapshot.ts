// The machine settings as a window holds them: the service's last answer, the members a write
// is in flight for, and the members whose last write was refused. Pure values;
// `store.ts` folds answers into them and `holder.ts` owns a
// store's lifetime.

import {
  MACHINE_SETTINGS_DEFAULTS,
  type MachineSettings,
  type MachineSettingsChange,
  type MachineSettingsReading,
} from "@ai-sidekicks/contracts/machine/settings";

import type { Refusal } from "#renderer/lib/refusal/contract.js";

/**
 * One member a settings write changes. The provider members are written through the provider's
 * own update, so they are no member here.
 */
export type MachineSettingsMember = ChangeMemberOf<MachineSettingsChange>;

/** The members of the change arms in `Change`, taken arm by arm. */
type ChangeMemberOf<Change> = Change extends unknown ? keyof Change : never;

/**
 * The defaults typed as the settings. The generated defaults are a read-only literal, whose empty
 * environment rows a settings value cannot hold until they are copied into an array of its own.
 */
export const MACHINE_SETTINGS_AT_DEFAULTS: MachineSettings = {
  ...MACHINE_SETTINGS_DEFAULTS,
  environmentRows: [...MACHINE_SETTINGS_DEFAULTS.environmentRows],
};

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
  return snapshot.reading?.settings ?? MACHINE_SETTINGS_AT_DEFAULTS;
}
