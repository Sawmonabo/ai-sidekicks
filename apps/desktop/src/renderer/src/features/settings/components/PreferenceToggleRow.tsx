// One preference and one switch, in the settings row. Written once for the settings pages that
// share it.
//
// The control is the app's one Switch, whose hidden `<input>` takes the row's id, so the row ties
// a real `<label>` to it and gets keyboard, label and focus-visible behavior for free. The row
// never decides whether a setting may change; `checked` and `isPending` come from the page.

import { useId, type ReactNode } from "react";

import { Switch } from "#renderer/components/Switch/Switch.js";
import type { SettingsControl } from "../types.js";
import { PreferenceRow } from "./PreferenceRow.js";

/** Props for {@link PreferenceToggleRow}. */
export interface PreferenceToggleRowProps {
  /** The findable control the row draws, whose label it shows. */
  readonly control: SettingsControl;
  /** The lines under the label, each its own paragraph, tied to the switch as its description. */
  readonly descriptionLines?: readonly ReactNode[] | undefined;
  readonly checked: boolean;
  /** The position the setting ships in; any other position draws the changed mark. */
  readonly checkedByDefault: boolean;
  /** True while a write for this key is in flight. The switch stops taking presses. */
  readonly isPending?: boolean | undefined;
  readonly onCheckedChange: (checked: boolean) => void;
}

/** A labeled switch for one preference; presses are ignored while `isPending`. */
export function PreferenceToggleRow(props: PreferenceToggleRowProps): React.JSX.Element {
  const switchId = useId();
  return (
    <PreferenceRow
      control={props.control}
      controlElementId={switchId}
      descriptionLines={props.descriptionLines ?? []}
      changedFromDefault={
        props.checked === props.checkedByDefault
          ? undefined
          : { isOnByDefault: props.checkedByDefault }
      }
      renderControl={(describedBy) => (
        <Switch
          id={switchId}
          aria-describedby={describedBy}
          checked={props.checked}
          disabled={props.isPending ?? false}
          onCheckedChange={props.onCheckedChange}
        />
      )}
    />
  );
}
