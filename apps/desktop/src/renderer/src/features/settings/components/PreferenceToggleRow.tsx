// One preference and one switch: a label, an optional sentence under it, and the control.
// Written once for the settings pages that share it.
//
// The control is `@base-ui/react`'s Switch: it renders a `<span>` plus a hidden `<input>`, so
// the row ties a real `<label>` to the input id and gets keyboard, label and focus-visible
// behavior for free. The row never decides whether a setting may change; `checked` and
// `isPending` come from the page.

import "./preference-toggle-row.css";

import { useId } from "react";

import { Switch } from "@base-ui/react/switch";

/** Props for {@link PreferenceToggleRow}. */
export interface PreferenceToggleRowProps {
  readonly label: string;
  /** The line under the label, tied to the switch as its description; absent draws none. */
  readonly description?: string | undefined;
  readonly checked: boolean;
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
        <label className="meridian-settings-row__label" htmlFor={switchId}>
          {props.label}
        </label>
        {props.description === undefined ? null : (
          <p className="meridian-settings-row__description" id={descriptionId}>
            {props.description}
          </p>
        )}
      </div>
      <Switch.Root
        id={switchId}
        className="meridian-settings-row__switch"
        aria-describedby={descriptionId}
        checked={props.checked}
        disabled={props.isPending ?? false}
        onCheckedChange={(checked) => {
          props.onCheckedChange(checked);
        }}
      >
        <Switch.Thumb className="meridian-settings-row__thumb" />
      </Switch.Root>
    </div>
  );
}
