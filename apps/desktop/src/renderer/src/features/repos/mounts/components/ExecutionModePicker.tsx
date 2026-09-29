import "./execution-mode-picker.css";

import type {
  ExecutionMode,
  WorkspaceExecutionModeCapabilitiesReadResponse,
} from "@ai-sidekicks/contracts";
import { Nothing, WireFigure } from "@renderer/console/primitives/index.js";
import { ExecutionModeRow } from "./ExecutionModeRow.js";
import { executionModeRows } from "../execution-mode-rows.js";
import { selectionInFlightCopy } from "../execution-mode-selection.js";
import type { WorkspaceControlAvailability } from "../mount-health.js";
import { controlHoldSentence } from "../mount-health.js";

export interface ExecutionModePickerProps {
  /** Wire-verbatim workspace id; the group's inputs are named by it so two pickers never collide. */
  readonly workspaceId: string;
  /** What this workspace is bound as NOW — the daemon's `WorkspaceListResponse` row. */
  readonly currentMode: ExecutionMode;
  /** The capabilities reply, or `undefined` while nobody has answered for this workspace. */
  readonly capabilities: WorkspaceExecutionModeCapabilitiesReadResponse | undefined;
  /** The mode a switch is on the wire for, where one is. Absent means nothing is pending. */
  readonly pendingMode: ExecutionMode | undefined;
  /**
   * Whether this workspace's binding controls are live, derived once by the card.
   *
   * `pendingMode` travels beside it because the announcement below names the mode, which a
   * posture does not carry.
   */
  readonly posture: WorkspaceControlAvailability;
  readonly onSelect: (executionMode: ExecutionMode) => void;
}

export function ExecutionModePicker(props: ExecutionModePickerProps): React.JSX.Element {
  const { capabilities } = props;
  // The mount's own posture. Absent means the group is live.
  const heldBecause = controlHoldSentence(props.posture);
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
  // The sentence `readWorkspaceControlAvailability` composes for an outstanding switch, asked of
  // the module that composes it. `undefined` while nothing is pending, which no hold
  // reason can equal.
  const pendingCopy = pendingMode === undefined ? undefined : selectionInFlightCopy(pendingMode);
  return (
    <div className="meridian-mode-picker">
      <fieldset className="meridian-mode-picker__group" disabled={heldBecause !== undefined}>
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
      {heldBecause === undefined || heldBecause === pendingCopy ? null : (
        // THE GROUP NEVER GOES QUIET. A `fieldset` is disabled as a whole — the radios
        // inside it stop taking a press and the browser paints nothing that says why —
        // so the sentence is rendered as text beside it. It is the mount's own wording;
        // this picker composes no second one.
        //
        // AND IT IS ONE LIVE REGION, NEVER TWO. The line below is the SPECIALIZED
        // rendering of exactly one hold cause — it puts the mode in mono, which a
        // composed sentence cannot — so where the posture's reason IS that cause the two
        // would announce one fact twice, in two different wordings. The comparison is
        // against the composing module's own output rather than a literal written here,
        // so a copy change moves both sides at once, and a mismatch falls through to this
        // general line, which is never the wrong sentence.
        <p className="meridian-mode-picker__held" role="status">
          {heldBecause}
        </p>
      )}
      {pendingMode !== undefined && heldBecause === pendingCopy ? (
        // `role="status"` rather than an alert: a switch that was sent is progress
        // rather than a problem, and it is announced once when it starts.
        <p className="meridian-mode-picker__pending" role="status">
          Switching to <WireFigure value={pendingMode} />. The picker is held until the daemon
          answers.
        </p>
      ) : null}
    </div>
  );
}
