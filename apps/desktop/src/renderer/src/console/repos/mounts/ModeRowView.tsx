import { WireFigure } from "../../primitives/index.js";

import { type ExecutionMode } from "@ai-sidekicks/contracts";
import { type ModeRow } from "./mode-row.js";

export function ModeRowView(props: ModeRowViewProps): React.JSX.Element {
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
        // Grouped per workspace, so a session showing several pickers keeps each
        // one's selection to its own workspace.
        name={`meridian-mode-${props.workspaceId}`}
        value={row.mode}
        checked={props.isCurrent}
        disabled={!row.available}
        onChange={() => {
          props.onSelect(row.mode);
        }}
      />
      <label className="meridian-mode-picker__label" htmlFor={inputId}>
        {/* The mode is a wire string — `"ephemeral clone"` carries its space, which
            is the wire form and not a typo to be normalised (`packages/contracts/src/repo.ts`). */}
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

export interface ModeRowViewProps {
  readonly row: ModeRow;
  readonly workspaceId: string;
  readonly isCurrent: boolean;
  readonly isDefault: boolean;
  readonly onSelect: (executionMode: ExecutionMode) => void;
}
