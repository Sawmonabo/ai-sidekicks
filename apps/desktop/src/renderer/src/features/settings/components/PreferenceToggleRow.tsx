// One preference and one switch: a label, an optional sentence under it, and the control.
// Written once for the settings pages that share it. While the value differs from its default the
// label carries the changed mark, kept outside the `<label>` so the switch's name stays the label.
//
// The control is the app's one Switch, whose hidden `<input>` takes the row's id, so the row ties
// a real `<label>` to it and gets keyboard, label and focus-visible behavior for free. The row
// never decides whether a setting may change; `checked` and `isPending` come from the page.

import "./PreferenceToggleRow.css";

import { useId } from "react";

import { Switch } from "#renderer/components/Switch/Switch.js";
import { ChangedFromDefaultMark } from "./ChangedFromDefaultMark.js";

/** Props for {@link PreferenceToggleRow}. */
export interface PreferenceToggleRowProps {
  readonly label: string;
  /** The line under the label, tied to the switch as its description; absent draws none. */
  readonly description?: string | undefined;
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
  const descriptionId = props.description === undefined ? undefined : `${switchId}-description`;
  return (
    <div className="meridian-settings-row">
      <div className="meridian-settings-row__text">
        <span className="meridian-settings-row__name">
          <label className="meridian-settings-row__label" htmlFor={switchId}>
            {props.label}
          </label>
          {props.checked === props.checkedByDefault ? null : (
            <ChangedFromDefaultMark isOnByDefault={props.checkedByDefault} />
          )}
        </span>
        {props.description === undefined ? null : (
          <p className="meridian-settings-row__description" id={descriptionId}>
            {props.description}
          </p>
        )}
      </div>
      <Switch
        id={switchId}
        aria-describedby={descriptionId}
        checked={props.checked}
        disabled={props.isPending ?? false}
        onCheckedChange={props.onCheckedChange}
      />
    </div>
  );
}
