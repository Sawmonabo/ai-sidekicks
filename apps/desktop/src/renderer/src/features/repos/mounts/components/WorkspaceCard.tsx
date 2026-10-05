// One workspace row: binding, lifecycle position, and root. `lastError` is present only on a
// `stale` row and is quoted, not paraphrased. There is no health chip: health belongs to the
// mount, and a mismatching mount reaches this row as `stale` plus `lastError`. The root line
// prints the row's own `fsRoot`, never derived from the mount's `canonicalRoot`.

import type { ExecutionMode, WorkspaceState } from "@ai-sidekicks/contracts/repo/repo";
import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts/workspace";
import { GLYPH_SIZE_ROW } from "@renderer/styles/glyphs.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { Chip, type ChipTone } from "@renderer/components/Chip/Chip.js";
import { Glyph } from "@renderer/components/Glyph/Glyph.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { ExecutionModePicker } from "../execution-mode/components/ExecutionModePicker.js";
import { readWorkspaceControlAvailability, type BindControlAvailability } from "../mount-health.js";
import { PrepareExecutionRoot } from "../execution-roots/PrepareExecutionRoot.js";
import type { PrepareOperations } from "../execution-roots/prepare/controller.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";
import type { RepoWorkspaceRow } from "../repo-mounts-model.js";
import type { Refusal } from "@renderer/lib/refusal/refusal.js";

/**
 * The tone each lifecycle position wears. Total over `WorkspaceState`, so a new wire member
 * fails to compile here. Only `stale` (blocks writable runs until repair) and `busy` (a run
 * holds the workspace) earn a tone.
 */
const STATE_TONES: Readonly<Record<WorkspaceState, ChipTone>> = {
  preparing: "neutral",
  ready: "neutral",
  busy: "attention",
  stale: "failure",
  archived: "neutral",
};

/** A workspace row, its capabilities and pending switch, and the controls' shared context. */
export interface WorkspaceCardProps {
  readonly workspace: RepoWorkspaceRow;
  readonly capabilities: WorkspaceExecutionModeCapabilitiesReadResponse | undefined;
  /** The mode a switch on this workspace is waiting on the daemon for, where one is. */
  readonly pendingMode: ExecutionMode | undefined;
  /** Why the newest switch on this workspace was refused, where it was. */
  readonly modeRefusal: Refusal | undefined;
  /** The bridge the prepare act takes its clock from. */
  readonly bridge: PlatformBridge;
  /** The calls the prepare act makes. */
  readonly operations: PrepareOperations;
  /** Read the section again, because a prepare put a root on disk the list has not seen. */
  readonly onRequestRead: () => void;
  /** The session the prepare act takes its reconnect and stale-frame triggers from. */
  readonly sessionStore: SessionStore;
  /**
   * The owning mount's bind availability, handed down rather than re-read. The withheld arm carries
   * the sentence the mount card already renders, so this row composes no second wording.
   */
  readonly bindControls: BindControlAvailability;
  readonly onSelectExecutionMode: (executionMode: ExecutionMode) => void;
}

/** One workspace: its binding chips, root, last error, mode picker, and root preparation. */
export function WorkspaceCard(props: WorkspaceCardProps): React.JSX.Element {
  const { workspace } = props;
  // One availability for both binding controls, derived where both inputs meet, so the picker and
  // the preparation cannot drift apart.
  const availability = readWorkspaceControlAvailability(props.bindControls, props.pendingMode);
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
        ) : workspace.state === "preparing" ? (
          // The root does not exist yet; it is filled when preparation completes.
          <Nothing kind="computing" title="Root pending" />
        ) : (
          <Nothing kind="not-checked" title="This workspace reported no root." />
        )}
      </p>

      {workspace.lastError !== undefined ? (
        // The daemon's captured detail, quoted verbatim and inline on the row it is about.
        <p className="meridian-workspace-card__last-error" role="status">
          {workspace.lastError}
        </p>
      ) : null}

      <ExecutionModePicker
        workspaceId={workspace.id}
        currentMode={workspace.executionMode}
        capabilities={props.capabilities}
        pendingMode={props.pendingMode}
        availability={availability}
        refusal={props.modeRefusal}
        onSelect={props.onSelectExecutionMode}
      />

      {/* Under the picker: it prepares the root of the mode the row is bound in now. The
          availability holds it while a switch is on the wire and while the mount refuses binds. */}
      <PrepareExecutionRoot
        bridge={props.bridge}
        workspaceId={workspace.id}
        repoMountId={workspace.repoMountId}
        executionMode={workspace.executionMode}
        sessionStore={props.sessionStore}
        availability={availability}
        operations={props.operations}
        onPrepared={props.onRequestRead}
      />
    </article>
  );
}
