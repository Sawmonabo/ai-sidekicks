// Which execution mode a new workspace binds in, chosen from what the mount admits.
//
// A RADIO GROUP AND NOT A SELECT: an excluded mode carries the mount's own sentence for
// why, and a sentence does not fit in an option label. Flattening it would leave a
// person with modes they cannot pick and no reason given for any of them.
//
// EVERY MODE IS RENDERED AND THE EXCLUDED ONES ARE DISABLED, because the daemon has
// already answered the question — `availableModes` is its answer for THIS mount — so
// offering an excluded mode would send a request the answer on screen says will refuse.
// The gap is stated explicitly, so the row stays with its reason rather than
// disappearing.

import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import type { ExecutionModeRowReading } from "../execution-mode-rows.js";

export interface BindModePickerProps {
  readonly options: readonly ExecutionModeRowReading[];
  readonly selectedMode: string | undefined;
  /** Every radio in one group needs one name; the caller's dialog supplies it. */
  readonly groupName: string;
  readonly onSelect: (mode: ExecutionModeRowReading["mode"]) => void;
}

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
          {/* THE REASON IS RENDERED WHENEVER THE REPLY CARRIED ONE, available arm
              included, exactly as `ExecutionModeRow.tsx` renders it. A mount that names a
              mode in BOTH halves of its reply is malformed, and `execution-mode-rows.ts` offers
              the row — the reply is the authority on what is admitted — while keeping
              what the daemon said about it; a picker that drew the reason only on the
              excluded arm would hide that half, which is the drift the second copy of
              that derivation carried. The row with no reason on file says nothing
              rather than composing a sentence the daemon did not send. */}
          {option.restrictionReason === undefined ? null : (
            <span className="meridian-bind__mode-reason">{option.restrictionReason}</span>
          )}
        </label>
      ))}
    </fieldset>
  );
}
