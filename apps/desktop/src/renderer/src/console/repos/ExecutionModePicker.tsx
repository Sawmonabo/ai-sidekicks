// The execution-mode picker: what a run bound here may do to the repository.
//
// `Spec-023 §Console Design (Meridian)` §10.2 gives this surface one job and three
// prohibitions, and the prohibitions are what shape the component:
//
//   • THE REPLY IS RENDERED EXACTLY AS IT ARRIVES. The rows are `availableModes` in
//     the daemon's own order, followed by every key of `restrictions` — never
//     "everything not in `restrictions`", which §10.2 names as a Never and which
//     would silently invent a mode on a reply whose two halves disagreed.
//   • `defaultMode` IS NOT THE CURRENT MODE. It is the default for the NEXT writable
//     coding run (`worktree` on a git mount, per ADR-006), while the workspace's own
//     `executionMode` is what it is bound as now. The two disagree by design, so the
//     row carrying the default is labelled as the default and the row carrying the
//     current binding is labelled as the current one — never both from one field.
//   • A REFUSAL DOES NOT RE-PICK. `Spec-010 §Required Behavior` forbids silent
//     substitution; the renderer's half is to show the daemon's refusal beside the
//     control and leave the choice where it was.
//
// A RADIO GROUP, NOT A MENU. §10.2's density note is that all four rows are visible
// at once, each with its reason, "since the reason is the point" — a menu hides
// exactly the reasons a restricted mount exists to show. Own-built over the typed
// reply: the semantics here are a disabled row that still reads its reason aloud,
// which is a labelling problem a component library does not solve better.

import type {
  ExecutionMode,
  WorkspaceExecutionModeCapabilitiesReadResponse,
} from "@ai-sidekicks/contracts";
import type { ConsoleRefusal } from "../core/index.js";
import { InlineRefusal, Nothing, WireFigure } from "../primitives/index.js";

export interface ExecutionModePickerProps {
  /** Wire-verbatim workspace id; the group's inputs are named by it so two pickers never collide. */
  readonly workspaceId: string;
  /** What this workspace is bound as NOW — the daemon's `WorkspaceListResponse` row. */
  readonly currentMode: ExecutionMode;
  /** The capabilities reply, or `undefined` while nobody has answered for this workspace. */
  readonly capabilities: WorkspaceExecutionModeCapabilitiesReadResponse | undefined;
  /** The daemon's refusal for this workspace's modes — a failed read, or a refused switch. */
  readonly refusal: ConsoleRefusal | undefined;
  /** Whether the surrounding card offers its bind controls at all. */
  readonly disabled: boolean;
  readonly onSelect: (executionMode: ExecutionMode) => void;
}

/** One row, after the reply has been read but before anything is rendered. */
interface ModeRow {
  readonly mode: ExecutionMode;
  readonly available: boolean;
  /** The daemon's own words for why this mode is unavailable. Never composed here. */
  readonly restrictionReason: string | undefined;
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
  return (
    <div className="meridian-mode-picker">
      <fieldset className="meridian-mode-picker__group" disabled={props.disabled}>
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
      {props.refusal !== undefined ? (
        <InlineRefusal code={props.refusal.code} detail={props.refusal.detail} />
      ) : null}
    </div>
  );
}

interface ModeRowViewProps {
  readonly row: ModeRow;
  readonly workspaceId: string;
  readonly isCurrent: boolean;
  readonly isDefault: boolean;
  readonly onSelect: (executionMode: ExecutionMode) => void;
}

function ModeRowView(props: ModeRowViewProps): React.JSX.Element {
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
