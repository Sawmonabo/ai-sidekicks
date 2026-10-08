// One repo mount, with lifecycle and health as separate chips. `canonicalRoot` is shown
// verbatim (the stylesheet truncates it; the hover label and copy control recover it) and never
// resolved or compared here, because containment and symlink rules belong to the daemon.
// Re-attach shows only on `identity_mismatch`, the permanent verdict, and only while git still
// answers for the root; `unreachable` is transient.

import "./MountCard.css";

import type { RepoMountReadResponse } from "@ai-sidekicks/contracts/repo/folders";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { Chip } from "#renderer/components/Chip/Chip.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import {
  formatClockTime,
  formatDateTime,
  formatZonedDateTime,
} from "#renderer/lib/wire/figures.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { mountHealthReading, mountLifecycleReading } from "#renderer/store/mount-axis-readings.js";
import { readBindControlAvailability } from "../bind-control-availability.js";
import { ReattachControl } from "../attach/ReattachControl.js";
import type { RepoOperations } from "../../operations.js";
import type { RepoWorkspaceRow } from "../reading.js";
import { OpenDiffControl, type OpenDiffSubject } from "./OpenDiffControl.js";
import { WorkspaceCard } from "./WorkspaceCard.js";
import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";
import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";

/** A mount's read, its workspaces, and the handlers every control on the card passes through. */
export interface MountCardProps {
  readonly mount: RepoMountReadResponse;
  /** This mount's workspaces, in the order the list read returned them. */
  readonly workspaces: readonly RepoWorkspaceRow[];
  /** The bridge each control takes its clock from. */
  readonly bridge: PlatformBridge;
  /** The calls each control on this card makes. */
  readonly operations: RepoOperations;
  /** The session a re-attach is sent for. */
  readonly sessionStore: SessionStore;
  /** Put the resolved root on the clipboard. */
  readonly onCopyCanonicalRoot: (canonicalRoot: string) => void;
  /** Read the section again, because a user's act minted a mount it has not seen. */
  readonly onRequestRead: () => void;
  /** Open a change set over one of this card's rows; takes the subject, not a workspace. */
  readonly onOpenDiff: (subject: OpenDiffSubject) => void;
}

/** One mount: root, lifecycle and health chips, provenance, and its workspaces. */
export function MountCard(props: MountCardProps): React.JSX.Element {
  const clockLocale = useClockLocale();
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
        {/* The hover label carries the whole string the stylesheet truncates. */}
        <WireFigure value={mount.canonicalRoot} hoverLabel={mount.canonicalRoot} truncate />
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
        <Chip label={lifecycle.label} tone={lifecycle.tone} />
        <Chip label={health.label} tone={health.tone} />
        {/* Beside the chip, not in it: the verdict and when it was probed are two facts. */}
        <span className="meridian-mount-card__checked-at">
          probed{" "}
          <WireFigure
            value={formatClockTime(mount.health.checkedAt, clockLocale)}
            hoverLabel={formatZonedDateTime(mount.health.checkedAt, clockLocale)}
          />
        </span>
      </div>

      {/* One state sentence, never two: a withheld card's reason is one of the axis sentences
          (lifecycle before health), so rendering the axis sentence too would print it twice. */}
      {availability.available ? (
        <p className="meridian-mount-card__sentence">{health.sentence}</p>
      ) : (
        <AnnouncedLine
          element="p"
          className="meridian-mount-card__withheld"
          words={availability.unavailableBecause}
          politeness="polite"
        />
      )}
      {mount.health.status === "identity_mismatch" && mount.health.isRepository ? (
        <ReattachControl
          bridge={props.bridge}
          sessionId={props.sessionStore.sessionId}
          operations={props.operations}
          localPath={mount.localPath}
          onAttached={props.onRequestRead}
        />
      ) : null}

      <details>
        <summary className="meridian-mount-card__provenance-summary">Provenance</summary>
        <dl className="meridian-mount-card__provenance-list">
          <dt>Entered path</dt>
          <dd>
            <WireFigure value={mount.localPath} hoverLabel={mount.localPath} />
          </dd>
          <dt>Attached</dt>
          <dd>
            <WireFigure
              value={formatDateTime(mount.attachedAt, clockLocale)}
              hoverLabel={formatZonedDateTime(mount.attachedAt, clockLocale)}
            />
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
                bridge={props.bridge}
                operations={props.operations}
                onRequestRead={props.onRequestRead}
                bindControls={availability}
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
