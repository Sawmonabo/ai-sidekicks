// One workspace row: its binding, its lifecycle position, and its root.
//
// WHAT A ROW CARRIES IS FIXED HERE, because a surface's composition lives in the
// console's code: exactly
// what `WorkspaceListResponse` gives — `id`, `repoMountId`, `executionMode`, `state`,
// `fsRoot?`, `lastError?` — and two of the field notes are rules rather than
// descriptions:
//
//   • `lastError` IS PRESENT ONLY ON A `stale` ROW and renders inline on that row.
//     It is the daemon's captured detail of a failed mode switch, so it is quoted
//     rather than paraphrased.
//   • "ROOT PENDING" WHILE `provisioning`. A row's `fsRoot` is absent until its
//     execution root is prepared, and the honest word for a root that does not exist
//     yet is not an empty cell.
//
// NO HEALTH CHIP HERE, EVER. This row's own Never: the workspace list carries no
// health member by design — `RepoMountHealth` is the MOUNT's reachability projection
// and belongs to `repo.mountRead` — so a mismatching mount surfaces on this row as
// `stale` plus `lastError`, and synthesizing a second health axis would be the
// renderer inventing an answer the daemon deliberately did not give.
//
// THE ROOT LINE IS THE BOUND ROOT AND NOTHING DERIVED FROM IT. The mount's `canonicalRoot`
// and the workspace's `fsRoot` can differ, and neither is computed from the other, so this
// row prints the `fsRoot` the workspace list gave it.

import type {
  ExecutionMode,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceState,
} from "@ai-sidekicks/contracts";
import { GLYPH_SIZE_ROW } from "@renderer/styles/glyphs.js";
import type { ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import {
  Chip,
  Glyph,
  Nothing,
  WireFigure,
  type ChipTone,
} from "@renderer/console/primitives/index.js";
import { ExecutionModePicker } from "./ExecutionModePicker.js";
import { workspaceControlPosture, type BindControlPosture } from "../mount-health.js";
import { PrepareExecutionRoot } from "../execution-roots/PrepareExecutionRoot.js";
import type { PrepareOperations } from "../execution-roots/prepare-controller.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";
import type { RepoWorkspaceRow } from "../repo-mounts-model.js";

/**
 * The tone each lifecycle position wears. Total over `WorkspaceState`, so a sixth
 * member of the wire union fails to compile here rather than rendering untoned.
 *
 * Only two positions earn color, and they earn the two the palette reserves:
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
  /** The mode a switch on this workspace is waiting on the daemon for, where one is. */
  readonly pendingMode: ExecutionMode | undefined;
  /** The bridge the prepare act takes its clock from. */
  readonly bridge: ConsoleBridge;
  /** The calls the prepare act makes. */
  readonly operations: PrepareOperations;
  /** Read the section again, because a prepare put a root on disk the list has not seen. */
  readonly onRequestRead: () => void;
  /** The session the prepare act takes its reconnect and stale-frame triggers from. */
  readonly sessionStore: SessionStore;
  /**
   * The owning mount's own bind posture, handed down rather than re-read.
   *
   * The POSTURE and not a boolean, because the withheld arm carries the sentence the
   * mount card is already rendering — so the two controls below can say why they are
   * held without this row composing a second wording for the same state.
   */
  readonly bindControls: BindControlPosture;
  readonly onSelectExecutionMode: (executionMode: ExecutionMode) => void;
}

export function WorkspaceCard(props: WorkspaceCardProps): React.JSX.Element {
  const { workspace } = props;
  // ONE POSTURE FOR BOTH BINDING CONTROLS, derived here because this row is the one
  // place that holds both of its inputs. The picker names the mode a run binds in and
  // the preparation puts that mode's root on disk, so a posture read twice is two
  // rules — and the pair that drifted is the pair that shipped.
  const posture = workspaceControlPosture(props.bindControls, props.pendingMode);
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
          // Not an empty cell and not a guess: the root does not exist yet, and is
          // filled at provisioning completion on this same row's id.
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

      <ExecutionModePicker
        workspaceId={workspace.id}
        currentMode={workspace.executionMode}
        capabilities={props.capabilities}
        pendingMode={props.pendingMode}
        posture={posture}
        onSelect={props.onSelectExecutionMode}
      />

      {/*
        THE PREPARE SITS UNDER THE PICKER because it is about the mode the row is bound
        in NOW, so a control drawn above the picker would be offering to prepare a root
        for a binding the user is in the middle of changing. The posture above
        holds it while that change is on the wire, and while the mount refuses binds.
      */}
      <PrepareExecutionRoot
        bridge={props.bridge}
        workspaceId={workspace.id}
        repoMountId={workspace.repoMountId}
        executionMode={workspace.executionMode}
        sessionStore={props.sessionStore}
        posture={posture}
        operations={props.operations}
        onPrepared={props.onRequestRead}
      />
    </article>
  );
}
