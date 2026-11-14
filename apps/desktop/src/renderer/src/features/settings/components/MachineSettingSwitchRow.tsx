// One switch kept in the machine's settings file: its row stands from the first frame, as every
// settings-file control's does, and once the file is read it is the switch over its member, the
// changed mark against the member's shipped default, and a refused write's strip under it.

import type { ReactNode } from "react";

import {
  MACHINE_SETTINGS_DEFAULTS,
  type MachineSettings,
} from "@ai-sidekicks/contracts/machine/settings";
import type { Clock } from "#renderer/lib/clock.js";
import type { MachineSettingsBinding } from "../machine/hooks/useMachineSettings.js";
import type { MachineSettingsMember } from "../machine/snapshot.js";
import type { SettingsControl } from "../types.js";
import { MachineSettingRow } from "./MachineSettingRow.js";
import { PreferenceToggleRow } from "./PreferenceToggleRow.js";

/** A settings-file member a switch writes: one whose value is on or off. */
export type MachineSettingsSwitchMember = {
  [Member in MachineSettingsMember]: MachineSettings[Member] extends boolean ? Member : never;
}[MachineSettingsMember];

/** Props for {@link MachineSettingSwitchRow}. */
export interface MachineSettingSwitchRowProps {
  /** The window's machine settings the switch reads and writes. */
  readonly preferences: Pick<
    MachineSettingsBinding,
    "snapshot" | "settings" | "isPending" | "refusalFor" | "choose" | "retry" | "readAgain"
  >;
  readonly member: MachineSettingsSwitchMember;
  /** The findable control the row draws, whose label it shows. */
  readonly control: SettingsControl;
  /** The lines under the label, each its own paragraph. */
  readonly descriptionLines?: readonly ReactNode[] | undefined;
  /** The window's clock, which the loading line's delay runs on. */
  readonly clock: Clock;
}

/** A switch over one settings-file member, standing with its label while the file is read. */
export function MachineSettingSwitchRow(props: MachineSettingSwitchRowProps): React.JSX.Element {
  const { preferences, member } = props;
  const descriptionLines = props.descriptionLines ?? [];
  return (
    <MachineSettingRow
      preferences={preferences}
      member={member}
      control={props.control}
      descriptionLines={descriptionLines}
      clock={props.clock}
      renderControlRow={() => (
        <PreferenceToggleRow
          control={props.control}
          descriptionLines={descriptionLines}
          checked={preferences.settings[member]}
          checkedByDefault={MACHINE_SETTINGS_DEFAULTS[member]}
          isPending={preferences.isPending(member)}
          onCheckedChange={(checked) => {
            preferences.choose(member, checked);
          }}
        />
      )}
    />
  );
}
