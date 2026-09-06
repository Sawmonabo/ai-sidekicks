import type {
  ExecutionMode,
  WorkspaceExecutionModeCapabilitiesReadResponse,
} from "@ai-sidekicks/contracts";
import type { ConsoleRefusal } from "../../core/index.js";
import { InlineRefusal, Nothing, WireFigure } from "../../primitives/index.js";
import { ModeRowView } from "./ModeRowView.js";
import { executionModeRows } from "./mode-row.js";
import { modeRestrictionReason, mountRefusalRecovery } from "./mount-refusal-copy.js";
import { RefusalRecovery } from "./RefusalRecovery.js";

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
  /**
   * The mode the refusal above was about, where it came from a refused switch.
   *
   * Absent for a refused capabilities READ, which is about the workspace and names no
   * mode — so the one code whose recovery is the mount's own restriction reason cannot
   * reach for a reason belonging to a mode nobody pressed.
   */
  readonly refusalMode: ExecutionMode | undefined;
  /** Whether the surrounding card offers its bind controls at all. */
  readonly disabled: boolean;
  readonly onSelect: (executionMode: ExecutionMode) => void;
}

export function ExecutionModePicker(props: ExecutionModePickerProps): React.JSX.Element {
  const { capabilities } = props;
  // THE RECOVERY IS LOOKED UP ONCE FOR BOTH REFUSAL SITES BELOW, because both render
  // the same refusal: the picker draws it beside the group when the modes are known and
  // in place of the group when they are not, and a code's next move does not depend on
  // which of the two the surface reached.
  //
  // The RESTRICTION REASON is available only on the arm that HAS a capabilities reply,
  // which is the honest shape rather than a limitation: a refused read gives the picker
  // no `restrictions` map at all, so `workspace.mode_unsupported` on that arm takes the
  // table's own "no reason on file" sentence instead of one lifted from a stale reply.
  const recovery =
    props.refusal === undefined
      ? undefined
      : mountRefusalRecovery(props.refusal.code, {
          restrictionReason: modeRestrictionReason(capabilities?.restrictions, props.refusalMode),
        });
  const recoveryAction =
    recovery === undefined ? undefined : <RefusalRecovery recovery={recovery} />;
  if (capabilities === undefined) {
    return (
      <div className="meridian-mode-picker">
        {props.refusal !== undefined ? (
          <InlineRefusal
            code={props.refusal.code}
            detail={props.refusal.detail}
            action={recoveryAction}
          />
        ) : (
          <Nothing
            kind="not-checked"
            title="Execution modes have not been read for this workspace."
          />
        )}
      </div>
    );
  }

  const rows = executionModeRows(capabilities);
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
        <InlineRefusal
          code={props.refusal.code}
          detail={props.refusal.detail}
          action={recoveryAction}
        />
      ) : null}
    </div>
  );
}
