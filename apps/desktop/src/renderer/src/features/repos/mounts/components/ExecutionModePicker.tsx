import "./execution-mode-picker.css";

import type {
  ExecutionMode,
  WorkspaceExecutionModeCapabilitiesReadResponse,
} from "@ai-sidekicks/contracts";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { ExecutionModeRow } from "./ExecutionModeRow.js";
import { executionModeRows } from "../execution-mode-rows.js";
import { selectionInFlightCopy } from "../execution-mode-selection.js";
import type { WorkspaceControlAvailability } from "../mount-health.js";
import { controlHoldSentence } from "../mount-health.js";

/** What the picker reads: a workspace's modes, its current binding, and any pending switch. */
export interface ExecutionModePickerProps {
  /** Wire-verbatim workspace id; it names the group's inputs so two pickers never collide. */
  readonly workspaceId: string;
  /** What this workspace is bound as NOW — the daemon's `WorkspaceListResponse` row. */
  readonly currentMode: ExecutionMode;
  /** The capabilities reply, or `undefined` while nobody has answered for this workspace. */
  readonly capabilities: WorkspaceExecutionModeCapabilitiesReadResponse | undefined;
  /** The mode a switch is on the wire for, where one is. Absent means nothing is pending. */
  readonly pendingMode: ExecutionMode | undefined;
  /**
   * Whether the binding controls are live, derived once by the card. `pendingMode` travels
   * beside it because the announcement below names the mode, which an availability does not carry.
   */
  readonly availability: WorkspaceControlAvailability;
  readonly onSelect: (executionMode: ExecutionMode) => void;
}

/** Radio group of the modes a workspace can switch between; held when the mount says so. */
export function ExecutionModePicker(props: ExecutionModePickerProps): React.JSX.Element {
  const { capabilities } = props;
  // Absent means the group is live.
  const unavailableBecause = controlHoldSentence(props.availability);
  if (capabilities === undefined) {
    return (
      <div className="meridian-mode-picker">
        <Nothing
          kind="not-checked"
          title="Execution modes have not been read for this workspace."
        />
      </div>
    );
  }

  const rows = executionModeRows(capabilities);
  const { pendingMode } = props;
  // The hold sentence `readWorkspaceControlAvailability` composes for an outstanding switch;
  // `undefined` while nothing is pending, which no hold reason can equal.
  const pendingCopy = pendingMode === undefined ? undefined : selectionInFlightCopy(pendingMode);
  return (
    <div className="meridian-mode-picker">
      <fieldset className="meridian-mode-picker__group" disabled={unavailableBecause !== undefined}>
        <legend className="meridian-mode-picker__legend">
          What a run bound here may do to the repository
        </legend>
        {rows.map((row) => (
          <ExecutionModeRow
            key={row.mode}
            row={row}
            workspaceId={props.workspaceId}
            isCurrent={row.mode === props.currentMode}
            isDefault={row.mode === capabilities.defaultMode}
            onSelect={props.onSelect}
          />
        ))}
      </fieldset>
      {unavailableBecause === undefined || unavailableBecause === pendingCopy ? null : (
        // A disabled `fieldset` stops taking presses and paints nothing that says why, so the
        // mount's own hold sentence is rendered beside it.
        // One live region, never two: the line below is the specialized rendering of the
        // in-flight hold, so where the availability's reason is that sentence the two would announce
        // one fact twice. Comparing against the composing module's output keeps both in step,
        // and a mismatch falls through to this general line.
        <p className="meridian-mode-picker__held" role="status">
          {unavailableBecause}
        </p>
      )}
      {pendingMode !== undefined && unavailableBecause === pendingCopy ? (
        // A sent switch is progress, not a problem, so `status` rather than an alert.
        <p className="meridian-mode-picker__pending" role="status">
          Switching to <WireFigure value={pendingMode} />. The picker is held until the background
          service answers.
        </p>
      ) : null}
    </div>
  );
}
