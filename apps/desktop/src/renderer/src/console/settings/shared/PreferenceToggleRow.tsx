// One preference, one switch, and the three things that can be true beside it.
//
// Every settings toggle in this console renders the same four regions — a label, a
// sentence saying what the setting governs, the control, and whatever the carrier
// had to say about the last attempt. Three pages need it, so it is written once
// (`apps/desktop/AGENTS.md` hoists on the second use) and each page supplies text.
//
// THE CONTROL IS `@base-ui/react`'s SWITCH, not a bare checkbox and not our own.
// `Spec-023 §Console Libraries` adopts that package as the console's one widget
// family; it renders a `<span>` plus a hidden `<input>`, so the row associates a
// real `<label>` with the input's id and the switch is reachable by keyboard,
// labelled, and focus-visible without this file re-deriving any of it.
//
// THE ROW NEVER DECIDES WHETHER A SETTING MAY CHANGE. `checked`, `disabled`, the
// held-locally note, and the refusal all arrive as props from the page, which reads
// them off the carrier. A row that computed its own eligibility would be a second
// authority on a question the daemon and the carrier answer.

import { useId } from "react";

import { Switch } from "@base-ui/react/switch";

import { InlineRefusal } from "../../primitives/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import "./preference-toggle-row.css";

export interface PreferenceToggleRowProps {
  readonly label: string;
  /** What the setting governs, in one sentence. Rendered as the label's description. */
  readonly description: string;
  readonly checked: boolean;
  /** True while a write for this key is in flight. The switch stops taking presses. */
  readonly isPending?: boolean | undefined;
  readonly onCheckedChange: (checked: boolean) => void;
  /**
   * A quiet line under the row — what this window did with a choice no carrier took.
   * Never an error: nothing failed, so nothing here reads as a failure.
   */
  readonly note?: string | undefined;
  /** The carrier's own refusal, rendered verbatim beside the control that raised it. */
  readonly refusal?: ConsoleRefusal | undefined;
}

export function PreferenceToggleRow(props: PreferenceToggleRowProps): React.JSX.Element {
  const switchId = useId();
  const descriptionId = `${switchId}-description`;
  return (
    <div className="meridian-settings-row">
      <div className="meridian-settings-row__text">
        <label className="meridian-settings-row__label" htmlFor={switchId}>
          {props.label}
        </label>
        <p className="meridian-settings-row__description" id={descriptionId}>
          {props.description}
        </p>
        {props.note === undefined ? null : (
          <p className="meridian-settings-row__note">{props.note}</p>
        )}
        {props.refusal === undefined ? null : (
          <InlineRefusal code={props.refusal.code} detail={props.refusal.detail} />
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
