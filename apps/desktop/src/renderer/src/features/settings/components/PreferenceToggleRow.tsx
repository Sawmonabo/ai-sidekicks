// One preference and one switch: a label, where the design draws one a sentence under it,
// and the control. Three pages need it, so it is written once and each page supplies text.
//
// THE CONTROL IS `@base-ui/react`'s SWITCH, not a bare checkbox and not our own.
// That package is the console's one adopted widget library; it renders a `<span>` plus
// a hidden `<input>`, so the row associates a
// real `<label>` with the input's id and the switch is reachable by keyboard,
// labeled, and focus-visible without this file re-deriving any of it.
//
// The row never decides whether a setting may change: `checked` and `isPending` arrive as
// props from the page, which reads them off the carrier.

import "./preference-toggle-row.css";

import { useId } from "react";

import { Switch } from "@base-ui/react/switch";

export interface PreferenceToggleRowProps {
  readonly label: string;
  /**
   * The line under the label, rendered as its description. Absent where the design
   * draws the switch with no line under it.
   */
  readonly description?: string | undefined;
  readonly checked: boolean;
  /** True while a write for this key is in flight. The switch stops taking presses. */
  readonly isPending?: boolean | undefined;
  readonly onCheckedChange: (checked: boolean) => void;
}

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
