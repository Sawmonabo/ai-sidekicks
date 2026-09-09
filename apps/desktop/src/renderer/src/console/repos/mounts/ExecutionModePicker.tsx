import type {
  ExecutionMode,
  WorkspaceExecutionModeCapabilitiesReadResponse,
} from "@ai-sidekicks/contracts";
import type { ConsoleRefusal } from "../../core/index.js";
import { useShellBlockFor, type FrameStore, type MutatingDaemonMethod } from "../../store/index.js";
import { InlineRefusal, Nothing, RefusalRecovery, WireFigure } from "../../primitives/index.js";
import { ModeRowView } from "./ModeRowView.js";
import { executionModeRows } from "./mode-row.js";
import { selectionInFlightCopy } from "./execution-mode-selection.js";
import type { WorkspaceControlPosture } from "./mount-health.js";
import { controlHoldSentence } from "./mount-health.js";
import { modeRestrictionReason, mountRefusalRecovery } from "./mount-refusal-copy.js";

// The record method this control dispatches, TYPED against the roster rather than
// spelled inline. `useShellBlockFor` takes a `string` — it has to, since it answers
// `undefined` for every read method — so a misspelled literal is not a compile error
// but a control that stays live through an outage and says nothing. `satisfies` is
// what turns that into a build failure.
const MODE_SELECT_METHOD = "repo.executionModeSelect" satisfies MutatingDaemonMethod;

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
  /**
   * Whether this workspace's binding controls are live, derived ONCE by the card.
   *
   * Both halves of it used to be read here — the card's `disabled` and the presence of
   * `pendingMode` — which made this the second place the rule was stated and left the
   * root preparation beside it running on the first. `workspaceControlPosture` is the
   * one derivation now; `pendingMode` survives beside it because the announcement below
   * names the mode, which a posture does not carry.
   */
  readonly posture: WorkspaceControlPosture;
  /**
   * The window's own shell condition, read here for the ONE method this picker sends.
   *
   * Read rather than handed down as a sentence, because the block answers about a
   * METHOD: a roster that later closed the bind verb while leaving the mode switch
   * open would move this control and not the preparation beneath it, which a reason
   * composed by the row could not express.
   */
  readonly frameStore: FrameStore;
  readonly onSelect: (executionMode: ExecutionMode) => void;
}

export function ExecutionModePicker(props: ExecutionModePickerProps): React.JSX.Element {
  const { capabilities } = props;
  // The mount's own posture and this window's runtime, folded in that order by the
  // module that owns the precedence. Absent means the group is live.
  const shellBlock = useShellBlockFor(props.frameStore, MODE_SELECT_METHOD);
  const heldBecause = controlHoldSentence(props.posture, shellBlock);
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
  // The sentence `workspaceControlPosture` composes for an outstanding switch, asked of
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
      {heldBecause === undefined || heldBecause === pendingCopy ? null : (
        // THE GROUP NEVER GOES QUIET. A `fieldset` is disabled as a whole — the radios
        // inside it stop taking a press and the browser paints nothing that says why —
        // so the sentence is rendered as text beside it. It is the mount's own wording
        // or the shell's verbatim; this picker composes no third one.
        //
        // AND IT IS ONE LIVE REGION, NEVER TWO. The line below is the SPECIALISED
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
