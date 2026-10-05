// One repo mount, with lifecycle and health as separate chips. `canonicalRoot` is shown
// verbatim (the stylesheet truncates it; the title and copy control recover it) and never
// resolved or compared here, because containment and symlink rules belong to the daemon.
// The bind entry shows only where the mount's availability admits it; re-attach only on
// `identity_mismatch`, the permanent verdict, since `unreachable` is transient.

import type { ExecutionMode, WorkspaceId } from "@ai-sidekicks/contracts/repo/repo";
import type { RepoMountReadResponse } from "@ai-sidekicks/contracts/repo/folders";
import type { WorkspaceExecutionModeCapabilitiesReadResponse } from "@ai-sidekicks/contracts/workspace";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { Chip } from "#renderer/components/Chip/Chip.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatClockTime } from "#renderer/lib/wire/figures.js";
import type { SessionStore } from "#renderer/store/session/session-store.js";
import {
  readBindControlAvailability,
  mountHealthReading,
  mountLifecycleReading,
} from "../health.js";
import { ReattachControl } from "../attach/ReattachControl.js";
import { BindWorkspaceDialog } from "../bind/BindWorkspaceDialog.js";
import type { RepoOperations } from "../../repo-operations.js";
import type { RepoWorkspaceRow } from "../repo-mounts-model.js";
import type { Refusal } from "#renderer/lib/refusal/refusal.js";
import { OpenDiffControl, type OpenDiffSubject } from "./OpenDiffControl.js";
import { WorkspaceCard } from "./WorkspaceCard.js";
import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";

/** A mount's read, its workspaces, and the handlers every control on the card passes through. */
export interface MountCardProps {
  readonly mount: RepoMountReadResponse;
  /** This mount's workspaces, in the order the list read returned them. */
  readonly workspaces: readonly RepoWorkspaceRow[];
  readonly capabilitiesByWorkspaceId: Readonly<
    Record<string, WorkspaceExecutionModeCapabilitiesReadResponse>
  >;
  /** Per workspace: the mode a switch is on the wire for, where one is. */
  readonly pendingModeByWorkspaceId: Readonly<Record<string, ExecutionMode>>;
  /** Per workspace: why its newest switch was refused, where it was. */
  readonly refusedModeByWorkspaceId: Readonly<Record<string, Refusal>>;
  /** The bridge each control takes its clock from. */
  readonly bridge: PlatformBridge;
  /** The calls each control on this card makes. */
  readonly operations: RepoOperations;
  /** The session each control takes its reconnect and stale-frame triggers from. */
  readonly sessionStore: SessionStore;
  /** Put the resolved root on the clipboard. */
  readonly onCopyCanonicalRoot: (canonicalRoot: string) => void;
  /** Read the section again, because a user's act minted a mount it has not seen. */
  readonly onRequestRead: () => void;
  readonly onSelectExecutionMode: (workspaceId: WorkspaceId, executionMode: ExecutionMode) => void;
  /** Open a change set over one of this card's rows; takes the subject, not a workspace. */
  readonly onOpenDiff: (subject: OpenDiffSubject) => void;
}

/** One mount: root, lifecycle and health chips, bind entry, provenance, and its workspaces. */
export function MountCard(props: MountCardProps): React.JSX.Element {
  const { mount } = props;
  // The lifecycle sentence reaches the screen through the withheld line.
  const lifecycle = mountLifecycleReading(mount.state);
  const health = mountHealthReading(mount.health);
  const availability = readBindControlAvailability(mount);

  return (
    <article
      className={
        availability.available
          ? "meridian-mount-card"
          : "meridian-mount-card meridian-mount-card--withheld"
      }
      aria-label={`Repo mount ${mount.canonicalRoot}`}
    >
      <header className="meridian-mount-card__head">
        <Glyph name="repo" size={GLYPH_SIZE_CHROME} />
        {/* The title carries the whole string the stylesheet truncates. */}
        <WireFigure value={mount.canonicalRoot} title={mount.canonicalRoot} truncate />
        <button
          type="button"
          className="meridian-mount-card__copy"
          onClick={() => {
            props.onCopyCanonicalRoot(mount.canonicalRoot);
          }}
          aria-label={`Copy the resolved root ${mount.canonicalRoot}`}
        >
          <Glyph name="copy" size={GLYPH_SIZE_CHROME} />
        </button>
      </header>

      <div className="meridian-mount-card__axes">
        <Chip label={lifecycle.label} mono tone={lifecycle.tone} />
        <Chip label={health.label} mono tone={health.tone} />
        {/* Beside the chip, not in it: the verdict and when it was probed are two facts. */}
        <span className="meridian-mount-card__checked-at">
          probed {formatClockTime(mount.health.checkedAt)}
        </span>
      </div>

      {/* One state sentence, never two: a withheld card's reason is one of the axis sentences
          (lifecycle before health), so rendering the axis sentence too would print it twice. */}
      {availability.available ? (
        <p className="meridian-mount-card__sentence">{health.sentence}</p>
      ) : (
        <p className="meridian-mount-card__withheld" role="status">
          {availability.unavailableBecause}
        </p>
      )}
      {availability.available ? (
        <BindWorkspaceDialog
          bridge={props.bridge}
          repoMountId={mount.id}
          canonicalRoot={mount.canonicalRoot}
          sessionStore={props.sessionStore}
          operations={props.operations}
          onBound={props.onRequestRead}
        />
      ) : null}
      {mount.health.status === "identity_mismatch" ? (
        <ReattachControl
          bridge={props.bridge}
          sessionId={props.sessionStore.sessionId}
          operations={props.operations}
          localPath={mount.localPath}
          onAttached={props.onRequestRead}
        />
      ) : null}

      <details className="meridian-mount-card__provenance">
        <summary className="meridian-mount-card__provenance-summary">Provenance</summary>
        <dl className="meridian-mount-card__provenance-list">
          <dt>Entered path</dt>
          <dd>
            <WireFigure value={mount.localPath} title={mount.localPath} />
          </dd>
          <dt>Attached</dt>
          <dd>
            <WireFigure value={mount.attachedAt} title={mount.attachedAt} />
          </dd>
        </dl>
      </details>

      <div className="meridian-mount-card__workspaces">
        {props.workspaces.length === 0 ? (
          <Nothing kind="empty" placement="block" title="This mount has no workspaces." />
        ) : (
          props.workspaces.map((workspace) => (
            <div className="meridian-mount-card__workspace" key={workspace.id}>
              <WorkspaceCard
                workspace={workspace}
                capabilities={props.capabilitiesByWorkspaceId[workspace.id]}
                pendingMode={props.pendingModeByWorkspaceId[workspace.id]}
                modeRefusal={props.refusedModeByWorkspaceId[workspace.id]}
                bridge={props.bridge}
                sessionStore={props.sessionStore}
                operations={props.operations}
                onRequestRead={props.onRequestRead}
                bindControls={availability}
                onSelectExecutionMode={(executionMode) => {
                  props.onSelectExecutionMode(workspace.id, executionMode);
                }}
              />
              {/* Beside the card, not inside it: opening a pane is the pane layout's act. */}
              <OpenDiffControl
                subject={{ kind: "workspace", id: workspace.id }}
                onOpenDiff={props.onOpenDiff}
              />
            </div>
          ))
        )}
      </div>
    </article>
  );
}
