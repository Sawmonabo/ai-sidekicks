// One workspace row: its binding, its lifecycle position, and its root.
//
// WHAT A ROW CARRIES IS FIXED HERE, because `Spec-023 §Console Design (Meridian)` puts
// a surface's composition in the console's code: exactly
// what `WorkspaceListResponse` gives — `id`, `repoMountId`, `executionMode`, `state`,
// `fsRoot?`, `lastError?` — and two of the field notes are rules rather than
// descriptions:
//
//   • `lastError` IS PRESENT ONLY ON A `stale` ROW and renders inline on that row.
//     It is the daemon's captured detail of a failed mode switch, so it is quoted
//     rather than paraphrased.
//   • "ROOT PENDING" WHILE `provisioning`. `WorkspaceBindResponse.fsRoot` is absent
//     for a writable bind until provisioning completes, and the honest word for a
//     root that does not exist yet is not an empty cell.
//
// NO HEALTH CHIP HERE, EVER. This row's own Never: the workspace list carries no
// health member by design — `RepoMountHealth` is the MOUNT's reachability projection
// and belongs to `repo.mountRead` — so a mismatching mount surfaces on this row as
// `stale` plus `lastError`, and synthesising a second health axis would be the
// renderer inventing an answer the daemon deliberately did not give.
//
// THE THREE PATHS ARE THREE FACTS, AND ALL THREE ARE ON THIS ROW. The mount's
// `canonicalRoot`, the workspace's bound root, and the normalized checkout root the
// turn-snapshot service operates on can all differ in `branch` mode, and none is
// derived from another. The `fsRoot` line below renders the bound root the workspace
// list gave it; the other two — and the marker that says the mode in force was
// SUBSTITUTED rather than chosen — reach the screen through
// `ExecutionContextDisclosure`, which reads the workspace's own execution context.
// That read is its own wire because neither of the two facts it carries is on the
// workspace list at all: `run_execution_contexts.checkout_root` is captured per run,
// and the workspace list's `executionMode` reads identically whether the daemon bound
// the requested mode or fell back to another.

import type {
  ExecutionMode,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceState,
} from "@ai-sidekicks/contracts";
import { GLYPH_SIZE_ROW } from "../../tokens/index.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { Chip, Glyph, Nothing, WireFigure, type ChipTone } from "../../primitives/index.js";
import { ExecutionContextDisclosure } from "./ExecutionContextDisclosure.js";
import { ExecutionModePicker } from "./ExecutionModePicker.js";
import { PrepareExecutionRoot } from "./roots/PrepareExecutionRoot.js";
import type { SessionStore } from "../../store/index.js";
import type { RepoWorkspaceRow } from "./repo-mounts-model.js";

/**
 * The tone each lifecycle position wears. Total over `WorkspaceState`, so a sixth
 * member of the wire union fails to compile here rather than rendering untoned.
 *
 * Only two positions earn colour, and they earn the two the palette reserves:
 * `stale` is the availability-loss verdict that blocks writable runs until repair,
 * and `busy` is a run holding the workspace — a person's attention, not a failure.
 */
const STATE_TONES: Readonly<Record<WorkspaceState, ChipTone>> = {
  provisioning: "neutral",
  ready: "neutral",
  busy: "attention",
  stale: "failure",
  archived: "neutral",
};

export interface WorkspaceCardProps {
  readonly workspace: RepoWorkspaceRow;
  readonly capabilities: WorkspaceExecutionModeCapabilitiesReadResponse | undefined;
  readonly refusal: ConsoleRefusal | undefined;
  /**
   * The mode the rendered refusal was about, where the refusal came from a press.
   *
   * Its own prop rather than read off `refusal`, because a `ConsoleRefusal` carries a
   * code and a sentence and no subject: one code's recovery — the mount's own reason
   * for refusing a mode — is keyed by mode on the capabilities reply, and a picker
   * handed the refusal alone could say only that SOME mode was refused.
   */
  readonly refusalMode: ExecutionMode | undefined;
  /** The mode a switch on this workspace is waiting on the daemon for, where one is. */
  readonly pendingMode: ExecutionMode | undefined;
  /** The mount's resolved root — the disclosure's first path, and the fixed one. */
  readonly mountCanonicalRoot: string;
  /** The bridge the execution-context read and the prepare acts are put on. */
  readonly bridge: ConsoleBridge;
  /** Read the section again, because a prepare put a root on disk the list has not seen. */
  readonly onRequestRead: () => void;
  /** The session the execution-context read's own refresh triggers listen to. */
  readonly sessionStore: SessionStore;
  /** False when the owning mount's card withholds its bind controls. */
  readonly modeControlsOffered: boolean;
  readonly onSelectExecutionMode: (executionMode: ExecutionMode) => void;
}

export function WorkspaceCard(props: WorkspaceCardProps): React.JSX.Element {
  const { workspace } = props;
  return (
    <article className="meridian-workspace-card" aria-label={`Workspace ${workspace.id}`}>
      <header className="meridian-workspace-card__head">
        <Glyph name="workspace" size={GLYPH_SIZE_ROW} />
        <WireFigure value={workspace.id} title={workspace.id} />
        <Chip label={workspace.executionMode} mono tone="neutral" />
        <Chip label={workspace.state} mono tone={STATE_TONES[workspace.state]} />
      </header>

      <p className="meridian-workspace-card__root">
        {workspace.fsRoot !== undefined ? (
          <WireFigure value={workspace.fsRoot} title={workspace.fsRoot} />
        ) : workspace.state === "provisioning" ? (
          // Not an empty cell and not a guess: the root does not exist yet, and
          // `Spec-009 §Execution Mode Transitions` fills it at provisioning
          // completion on this same row's id.
          <Nothing kind="computing" title="Root pending" />
        ) : (
          <Nothing kind="not-checked" title="This workspace reported no root." />
        )}
      </p>

      {workspace.lastError !== undefined ? (
        // The daemon's captured detail, quoted verbatim. Inline on the row it is
        // about, because a failure that reached a different surface would be a
        // failure the person reading this row never sees.
        <p className="meridian-workspace-card__last-error" role="status">
          {workspace.lastError}
        </p>
      ) : null}

      <ExecutionContextDisclosure
        bridge={props.bridge}
        workspaceId={workspace.id}
        mountCanonicalRoot={props.mountCanonicalRoot}
        sessionStore={props.sessionStore}
      />

      <ExecutionModePicker
        workspaceId={workspace.id}
        currentMode={workspace.executionMode}
        capabilities={props.capabilities}
        refusal={props.refusal}
        refusalMode={props.refusalMode}
        pendingMode={props.pendingMode}
        disabled={!props.modeControlsOffered}
        onSelect={props.onSelectExecutionMode}
      />

      {/*
        THE PREPARE SITS UNDER THE PICKER because it is about the mode the row is bound
        in NOW: which call it sends and whether it asks a reuse question are both read
        off that mode, so a control drawn above the picker would be offering to prepare
        a root for a binding the participant is in the middle of changing.
      */}
      <PrepareExecutionRoot
        bridge={props.bridge}
        workspaceId={workspace.id}
        repoMountId={workspace.repoMountId}
        executionMode={workspace.executionMode}
        sessionStore={props.sessionStore}
        onPrepared={props.onRequestRead}
      />
    </article>
  );
}
