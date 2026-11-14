// One preference's row: its label, the changed mark while the value is not its default, the lines
// under the label, and what the caller draws in the control's place. The row carries its control's
// anchor, so search and a link land on it, and ties a real `<label>` to the control by its id. The
// changed mark sits outside the `<label>`, so the control's name stays the label alone.

import "./PreferenceRow.css";

import { useId, type ReactNode } from "react";

import { settingsControlAnchor } from "../control/anchor.js";
import type { SettingsControl } from "../types.js";
import {
  ChangedFromDefaultMark,
  type ChangedFromDefaultMarkProps,
} from "./ChangedFromDefaultMark.js";

/** Props for {@link PreferenceRow}. */
export interface PreferenceRowProps {
  /** The findable control the row draws, whose label it shows. */
  readonly control: SettingsControl;
  /**
   * The id of the control the caller draws, which the label names; `undefined` while no control is
   * drawn in its place, when the label is plain text.
   */
  readonly controlElementId: string | undefined;
  /** The lines under the label, each its own paragraph, tied to the control as its description. */
  readonly descriptionLines: readonly string[];
  /** The default the changed mark names, or `undefined` while the value is its default. */
  readonly changedFromDefault: ChangedFromDefaultMarkProps | undefined;
  /** Draws the control, handed the ids of the lines that describe it. */
  readonly renderControl: (describedBy: string | undefined) => ReactNode;
}

/** A labeled row around one preference's control. */
export function PreferenceRow(props: PreferenceRowProps): React.JSX.Element {
  const rowId = useId();
  const lineIds = props.descriptionLines.map(
    (_line, index) => `${rowId}-description-${String(index)}`,
  );
  return (
    <div className="meridian-settings-row" {...settingsControlAnchor(props.control)}>
      <div className="meridian-settings-row__text">
        <span className="meridian-settings-row__name">
          {props.controlElementId === undefined ? (
            <span className="meridian-settings-row__label">{props.control.label}</span>
          ) : (
            <label className="meridian-settings-row__label" htmlFor={props.controlElementId}>
              {props.control.label}
            </label>
          )}
          {props.changedFromDefault === undefined ? null : (
            <ChangedFromDefaultMark {...props.changedFromDefault} />
          )}
        </span>
        {props.descriptionLines.map((line, index) => (
          <p
            className="meridian-settings-row__description"
            id={lineIds[index]}
            key={lineIds[index]}
          >
            {line}
          </p>
        ))}
      </div>
      {props.renderControl(lineIds.length === 0 ? undefined : lineIds.join(" "))}
    </div>
  );
}
