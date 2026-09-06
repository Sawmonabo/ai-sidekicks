import type {
  ExecutionMode,
  WorkspaceExecutionModeCapabilitiesReadResponse,
} from "@ai-sidekicks/contracts";
import type { ConsoleRefusal } from "../../core/index.js";
import { InlineRefusal, Nothing, WireFigure } from "../../primitives/index.js";
import { ModeRowView } from "./ModeRowView.js";
import { type ModeRow } from "./mode-row.js";

export interface ExecutionModePickerProps {
  /** Wire-verbatim workspace id; the group's inputs are named by it so two pickers never collide. */
  readonly workspaceId: string;
  /** What this workspace is bound as NOW — the daemon's `WorkspaceListResponse` row. */
  readonly currentMode: ExecutionMode;
  /** The capabilities reply, or `undefined` while nobody has answered for this workspace. */
  readonly capabilities: WorkspaceExecutionModeCapabilitiesReadResponse | undefined;
  /** The daemon's refusal for this workspace's modes — a failed read, or a refused switch. */
  readonly refusal: ConsoleRefusal | undefined;
  /** The mode a switch is on the wire for, where one is. Absent means nothing is pending. */
  readonly pendingMode: ExecutionMode | undefined;
  /** Whether the surrounding card offers its bind controls at all. */
  readonly disabled: boolean;
  readonly onSelect: (executionMode: ExecutionMode) => void;
}

export function ExecutionModePicker(props: ExecutionModePickerProps): React.JSX.Element {
  const { capabilities } = props;
  if (capabilities === undefined) {
    return (
      <div className="meridian-mode-picker">
        {props.refusal !== undefined ? (
          <InlineRefusal code={props.refusal.code} detail={props.refusal.detail} />
        ) : (
          <Nothing
            kind="not-checked"
            title="Execution modes have not been read for this workspace."
          />
        )}
      </div>
    );
  }

  const rows = modeRows(capabilities);
  const { pendingMode } = props;
  return (
    <div className="meridian-mode-picker">
      <fieldset
        className="meridian-mode-picker__group"
        disabled={props.disabled || pendingMode !== undefined}
      >
        <legend className="meridian-mode-picker__legend">
          What a run bound here may do to the repository
        </legend>
        {rows.map((row) => (
          <ModeRowView
            key={row.mode}
            row={row}
            workspaceId={props.workspaceId}
            isCurrent={row.mode === props.currentMode}
            isDefault={row.mode === capabilities.defaultMode}
            onSelect={props.onSelect}
          />
        ))}
      </fieldset>
      {pendingMode !== undefined ? (
        // `role="status"` rather than an alert: a switch that was sent is progress
        // rather than a problem, and it is announced once when it starts.
        <p className="meridian-mode-picker__pending" role="status">
          Switching to <WireFigure value={pendingMode} />. The picker is held until the daemon
          answers.
        </p>
      ) : null}
      {props.refusal !== undefined ? (
        <InlineRefusal code={props.refusal.code} detail={props.refusal.detail} />
      ) : null}
    </div>
  );
}

/**
 * The rows, built from the reply and from nothing else.
 *
 * Available modes first, in the order the daemon listed them; then every restricted
 * mode, in the order its reasons arrived. A mode named in BOTH halves is rendered
 * once, as available, and keeps its reason visible — the reply is malformed in that
 * case and hiding half of it would be the renderer deciding which half was true.
 */
function modeRows(
  capabilities: WorkspaceExecutionModeCapabilitiesReadResponse,
): readonly ModeRow[] {
  const restrictions = capabilities.restrictions ?? {};
  const rows: ModeRow[] = capabilities.availableModes.map((mode) => ({
    mode,
    available: true,
    restrictionReason: restrictions[mode],
  }));
  for (const [restrictedMode, reason] of Object.entries(restrictions)) {
    const mode = restrictedMode as ExecutionMode;
    if (rows.some((row) => row.mode === mode)) {
      continue;
    }
    rows.push({ mode, available: false, restrictionReason: reason });
  }
  return rows;
}
