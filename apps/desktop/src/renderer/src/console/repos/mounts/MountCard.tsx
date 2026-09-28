// One repo mount, on two axes that never collapse into one.
//
// THIS CARD'S OWN JOB, decided here because each surface's composition — what it
// renders, offers, refuses, and folds — lives in the console's code: the card says
// which repository this is and whether it is still the repository it was attached as.
// Its rules are structural rather than cosmetic, and each is visible in the markup
// below:
//
//   • TWO PATHS, BOTH SURFACED. `canonicalRoot` is the resolver's output and the key
//     the trust envelope and the dedupe index are built on; `localPath` is the
//     user-entered path kept as provenance. Both are required, because attach
//     persists the first and the default workspace roots at the second, and attaching
//     from a nested subdirectory is the case that separates them.
//   • `canonicalRoot` VERBATIM. No home-directory abbreviation, no basename
//     shortening, no prettifying. It is middle-truncated by the STYLESHEET at the
//     measure, with the full string recoverable through the element's title and the
//     copy control beside it — so the renderer is never the reason two different
//     roots look identical.
//   • TWO AXES, TWO CHIPS. Lifecycle (`attached` / `detached` / `archived`) and
//     health (`healthy` / `unreachable`) are separate facts and wear separate chips,
//     with `checkedAt` beside the health one because a probe instant is information.
//   • THE BIND ENTRY POINT SITS ON THE CARD, AND ONLY WHERE BINDS ARE OFFERED.
//     A workspace in a chosen mode comes from `repo.workspaceBind`, and the mount is what
//     that call is scoped to. It is drawn on exactly the posture that admits it, so a
//     detached, unreachable, or drifted mount shows its withheld sentence instead of a
//     control the daemon would refuse.
//   • ONE VERDICT CARRIES A CONTROL, AND IT IS THE PERMANENT ONE. `identity_mismatch`
//     refuses every bind and every run on this mount until someone acts, and
//     re-attaching is the named recovery — so that verdict, and no other, is drawn
//     with the re-attach beside it.
//     `unreachable` is transient and gets none: its remedy is to make the path
//     reachable, and a control here would invite a second row for a repository that is
//     about to answer for itself.
//
// WHAT THE CARD DOES NOT DO. It never resolves, canonicalizes, or compares a path —
// containment, symlink resolution, case folding, and working-tree-boundary awareness
// are the daemon's trust-envelope rules, so the console sends the string and renders
// `repo.outside_trust_envelope` if it comes back. It never computes health and never
// softens `unreachable`. And it never re-attaches: re-attach mints a new mount row and is a
// user-confirmed act.

import type {
  ExecutionMode,
  RepoMountReadResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceId,
} from "@ai-sidekicks/contracts";
import type { ConsoleBridge } from "../../bridge/index.js";
import { Chip, Glyph, Nothing, WireFigure, formatClockTime } from "../../primitives/index.js";
import type { SessionStore } from "../../store/index.js";
import {
  bindControlPosture,
  mountHealthReading,
  mountLifecycleReading,
  mountVcsReading,
} from "./mount-health.js";
import { ReattachControl } from "./attach/ReattachControl.js";
import { BindWorkspaceDialog } from "./bind/BindWorkspaceDialog.js";
import type { RepoOperations } from "../repo-operations.js";
import type { RepoWorkspaceRow } from "./repo-mounts-model.js";
import { OpenDiffControl, type OpenDiffSubject } from "./OpenDiffControl.js";
import { WorkspaceCard } from "./WorkspaceCard.js";
import { GLYPH_SIZE_CHROME } from "../../tokens/index.js";

export interface MountCardProps {
  readonly mount: RepoMountReadResponse;
  /** This mount's workspaces, in the order the list read returned them. */
  readonly workspaces: readonly RepoWorkspaceRow[];
  readonly capabilitiesByWorkspaceId: Readonly<
    Record<string, WorkspaceExecutionModeCapabilitiesReadResponse>
  >;
  /** Per workspace: the mode a switch is on the wire for, where one is. */
  readonly pendingModeByWorkspaceId: Readonly<Record<string, ExecutionMode>>;
  /** The bridge each control takes its clock from. */
  readonly bridge: ConsoleBridge;
  /** The calls each control on this card makes. */
  readonly operations: RepoOperations;
  /** The session each control takes its reconnect and stale-frame triggers from. */
  readonly sessionStore: SessionStore;
  /** Put the resolved root on the clipboard. */
  readonly onCopyCanonicalRoot: (canonicalRoot: string) => void;
  /** Read the section again, because a user's act minted a mount it has not seen. */
  readonly onRequestRead: () => void;
  readonly onSelectExecutionMode: (workspaceId: WorkspaceId, executionMode: ExecutionMode) => void;
  /**
   * Open a change set over one of this card's rows.
   *
   * Takes the subject rather than being bound to a workspace: a workspace and an
   * execution root open the same pane at different addresses.
   */
  readonly onOpenDiff: (subject: OpenDiffSubject) => void;
}

export function MountCard(props: MountCardProps): React.JSX.Element {
  const { mount } = props;
  // The lifecycle axis supplies this card's first chip; its SENTENCE reaches the
  // screen through the withheld line, which `bindControlPosture` composes.
  const lifecycle = mountLifecycleReading(mount.state);
  const health = mountHealthReading(mount.health);
  const vcs = mountVcsReading(mount.vcsType);
  const posture = bindControlPosture(mount);

  return (
    <article
      className={
        posture.offered
          ? "meridian-mount-card"
          : "meridian-mount-card meridian-mount-card--withheld"
      }
      aria-label={`Repo mount ${mount.canonicalRoot}`}
    >
      <header className="meridian-mount-card__head">
        <Glyph name="repo" size={GLYPH_SIZE_CHROME} />
        {/* The resolved root, verbatim and recoverable: the title carries the whole
            string the stylesheet truncates, and the copy control carries it out. */}
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
        {/* The probe instant the health verdict came from. Beside the chip rather
            than folded into it: the verdict and when it was taken are two facts. */}
        <span className="meridian-mount-card__checked-at">
          probed {formatClockTime(mount.health.checkedAt)}
        </span>
        {mount.vcsType === "none" ? (
          <Chip label="reduced capability" tone={vcs.tone} glyph="alert" />
        ) : null}
      </div>

      {/*
        ONE state sentence, never two. A withheld card's reason IS one of the axis
        sentences — `bindControlPosture` picks which, lifecycle before health, so a
        detached row never reads as a path to go and fix — and rendering the axis
        sentence beside it would print the same words twice under different styling,
        which reads as two facts.
      */}
      {posture.offered ? (
        <p className="meridian-mount-card__sentence">{health.sentence}</p>
      ) : (
        <p className="meridian-mount-card__withheld" role="status">
          {posture.withheldBecause}
        </p>
      )}
      {mount.vcsType === "none" ? (
        <p className="meridian-mount-card__sentence">{vcs.sentence}</p>
      ) : null}
      {posture.offered ? (
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
          sessionStore={props.sessionStore}
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
          <Nothing
            kind="empty"
            placement="surface"
            title="This mount has no workspaces."
            detail="Attach mints one workspace, so an empty list here means the roster and the mount disagree."
          />
        ) : (
          props.workspaces.map((workspace) => (
            <div className="meridian-mount-card__workspace" key={workspace.id}>
              <WorkspaceCard
                workspace={workspace}
                capabilities={props.capabilitiesByWorkspaceId[workspace.id]}
                pendingMode={props.pendingModeByWorkspaceId[workspace.id]}
                bridge={props.bridge}
                sessionStore={props.sessionStore}
                operations={props.operations}
                onRequestRead={props.onRequestRead}
                bindControls={posture}
                onSelectExecutionMode={(executionMode) => {
                  props.onSelectExecutionMode(workspace.id, executionMode);
                }}
              />
              {/* Beside the card and not inside it: a card renders what its own read
                  said, and opening a pane is the deck's act rather than a column. */}
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
