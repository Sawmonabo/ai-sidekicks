import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";

import type { ExecutionMode } from "@ai-sidekicks/contracts/repo/repo";
import { type ExecutionModeRowReading } from "../execution-mode-rows.js";

/** One radio row: a mode, whether it is bound now or the default, and why it is restricted. */
export interface ExecutionModeRowProps {
  readonly row: ExecutionModeRowReading;
  readonly workspaceId: string;
  readonly isCurrent: boolean;
  readonly isDefault: boolean;
  readonly onSelect: (executionMode: ExecutionMode) => void;
}

/** A single execution-mode radio; a restricted mode is disabled and carries the mount's reason. */
export function ExecutionModeRow(props: ExecutionModeRowProps): React.JSX.Element {
  const { row } = props;
  const inputId = `meridian-mode-${props.workspaceId}-${row.mode.replace(/\s+/gu, "-")}`;
  return (
    <div
      className={
        row.available
          ? "meridian-mode-picker__row"
          : "meridian-mode-picker__row meridian-mode-picker__row--restricted"
      }
    >
      <input
        className="meridian-mode-picker__input"
        type="radio"
        id={inputId}
        // Grouped per workspace so several pickers keep their selections apart.
        name={`meridian-mode-${props.workspaceId}`}
        value={row.mode}
        checked={props.isCurrent}
        disabled={!row.available}
        onChange={() => {
          props.onSelect(row.mode);
        }}
      />
      <label className="meridian-mode-picker__label" htmlFor={inputId}>
        {/* The mode is a wire string, shown verbatim. */}
        <WireFigure value={row.mode} />
        {props.isCurrent ? <span className="meridian-mode-picker__tag">bound now</span> : null}
        {props.isDefault ? (
          <span className="meridian-mode-picker__tag">
            default for the next writable coding run
          </span>
        ) : row.available ? (
          <span className="meridian-mode-picker__tag">explicit selection</span>
        ) : null}
      </label>
      {row.restrictionReason !== undefined ? (
        <p className="meridian-mode-picker__reason">{row.restrictionReason}</p>
      ) : null}
    </div>
  );
}
