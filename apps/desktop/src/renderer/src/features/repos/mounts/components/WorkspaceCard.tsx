// One workspace row: binding, lifecycle position, and root. `lastError` is present only on a
// `stale` row and is quoted, not paraphrased. There is no health chip: health belongs to the
// mount, and a mismatching mount reaches this row as `stale` plus `lastError`. The root line
// prints the row's own `fsRoot`, never derived from the mount's `canonicalRoot`.

import "./WorkspaceCard.css";

import type { WorkspaceState } from "@ai-sidekicks/contracts/repo/mount";
import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { Chip, type ChipTone } from "#renderer/components/Chip/Chip.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { codeWords } from "#renderer/lib/code-words.js";
import { type BindControlAvailability } from "../bind-control-availability.js";
import { PrepareExecutionRoot } from "../execution-roots/prepare/PrepareExecutionRoot.js";
import type { PrepareOperations } from "../execution-roots/prepare/controller.js";
import type { RepoWorkspaceRow } from "../reading.js";
import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";

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

/** A workspace row and its root preparation's context. */
export interface WorkspaceCardProps {
  readonly workspace: RepoWorkspaceRow;
  /** The bridge the prepare act takes its clock from. */
  readonly bridge: PlatformBridge;
  /** The calls the prepare act makes. */
  readonly operations: PrepareOperations;
  /** Read the section again, because a prepare put a root on disk the list has not seen. */
  readonly onRequestRead: () => void;
  /**
   * The owning mount's bind availability, handed down rather than re-read. The withheld arm carries
   * the sentence the mount card already renders, so this row composes no second wording.
   */
  readonly bindControls: BindControlAvailability;
}

/** One workspace: its binding chips, root, last error, and root preparation. */
export function WorkspaceCard(props: WorkspaceCardProps): React.JSX.Element {
  const { workspace } = props;
  return (
    <article className="meridian-workspace-card" aria-label={`Workspace ${workspace.id}`}>
      <header className="meridian-workspace-card__head">
        <Glyph name="workspace" size={GLYPH_SIZE_ROW} />
        <WireFigure value={workspace.id} title={workspace.id} />
        <Chip label={codeWords(workspace.executionMode)} tone="neutral" />
        <Chip label={codeWords(workspace.state)} tone={STATE_TONES[workspace.state]} />
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
        <AnnouncedLine
          element="p"
          className="meridian-workspace-card__last-error"
          words={workspace.lastError}
          politeness="polite"
        />
      ) : null}

      {/* It prepares the root of the mode the row is bound in now, held while the mount refuses
          binds. */}
      <PrepareExecutionRoot
        bridge={props.bridge}
        workspaceId={workspace.id}
        executionMode={workspace.executionMode}
        availability={props.bindControls}
        operations={props.operations}
        onPrepared={props.onRequestRead}
      />
    </article>
  );
}
