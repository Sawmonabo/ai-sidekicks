// Which execution mode a new workspace binds in, chosen from what the mount admits. A radio
// group, not a select: an excluded mode carries the mount's own sentence for why, which does
// not fit an option label. Every mode is rendered and excluded ones are disabled, since
// `availableModes` is the daemon's answer for this mount.

import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import type { ExecutionModeRowReading } from "../execution-mode/execution-mode-rows.js";

/** Props for the execution-mode picker. */
export interface BindModePickerProps {
  readonly options: readonly ExecutionModeRowReading[];
  readonly selectedMode: string | undefined;
  /** Every radio in one group needs one name; the caller's dialog supplies it. */
  readonly groupName: string;
  readonly onSelect: (mode: ExecutionModeRowReading["mode"]) => void;
}

/** The radio group that picks the execution mode, drawing each excluded mode with its reason. */
export function BindModePicker(props: BindModePickerProps): React.JSX.Element {
  return (
    <fieldset className="meridian-bind__modes">
      <legend className="meridian-bind__legend">Execution mode</legend>
      {props.options.map((option) => (
        <label
          className={
            option.available
              ? "meridian-bind__mode"
              : "meridian-bind__mode meridian-bind__mode--out"
          }
          key={option.mode}
        >
          <input
            type="radio"
            name={props.groupName}
            value={option.mode}
            checked={props.selectedMode === option.mode}
            disabled={!option.available}
            onChange={() => {
              props.onSelect(option.mode);
            }}
          />
          <WireFigure value={option.mode} title={option.mode} />
          {/* The reason renders whenever the reply carried one, available arm included, as
              `ExecutionModeRow.tsx` does. A mode named in both halves of a malformed reply is
              offered but keeps what the daemon said about it; no reason on file says nothing. */}
          {option.restrictionReason === undefined ? null : (
            <span className="meridian-bind__mode-reason">{option.restrictionReason}</span>
          )}
        </label>
      ))}
    </fieldset>
  );
}
