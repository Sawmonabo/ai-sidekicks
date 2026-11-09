// The app's one on-and-off switch: `@base-ui/react`'s Switch under Meridian tokens. It renders a
// `<span role="switch">` with a hidden `<input>` beside it, so it takes the keyboard, focus and
// form behavior of a checkbox, and the caller only says what it is and what a press does.
//
// Its words sit in a `<label htmlFor>` beside the control, never around it: a span is not
// interactive content, so a label wrapping it would forward a press on the switch to the hidden
// input as a second click, and one press would ask for two positions.

import "./Switch.css";

import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { useId } from "react";

/** Props for {@link Switch}. */
export interface SwitchProps {
  readonly checked: boolean;
  /** Called with the position a press asks for; the caller decides whether it is taken. */
  readonly onCheckedChange: (checked: boolean) => void;
  /** The words drawn after the switch, which name it. Without them a caller names it. */
  readonly label?: string | undefined;
  readonly disabled?: boolean | undefined;
  /** The hidden input's id, for a caller's own `<label htmlFor>`. */
  readonly id?: string | undefined;
  readonly "aria-describedby"?: string | undefined;
}

/** A switch, with its words after it when `label` is given; one press sends one change. */
export function Switch(props: SwitchProps): React.JSX.Element {
  const ownId = useId();
  const id = props.id ?? ownId;
  const control = (
    <BaseSwitch.Root
      id={id}
      className="meridian-switch"
      aria-describedby={props["aria-describedby"]}
      checked={props.checked}
      disabled={props.disabled ?? false}
      onCheckedChange={(checked) => {
        props.onCheckedChange(checked);
      }}
    >
      <BaseSwitch.Thumb className="meridian-switch__thumb" />
    </BaseSwitch.Root>
  );
  if (props.label === undefined) {
    return control;
  }
  return (
    <span
      className="meridian-switch__label"
      data-disabled={props.disabled === true ? "" : undefined}
    >
      {control}
      <label className="meridian-switch__words" htmlFor={id}>
        {props.label}
      </label>
    </span>
  );
}
