// One repo mount, on two axes that never collapse into one.
//
// THIS CARD'S OWN JOB, decided here because `Spec-023 §Console Design (Meridian)` puts
// each surface's composition — what it renders, offers, refuses, and folds — in the
// console's code: the card says which repository this
// is, on which node, and whether it is still the repository it was attached as. Four
// of its rules are structural rather than cosmetic, and each is visible in the markup
// below:
//
//   • TWO PATHS, BOTH SURFACED. `canonicalRoot` is the resolver's output and the key
//     the trust envelope and the dedupe index are built on; `localPath` is the
//     participant-entered path kept as provenance. `Spec-009 §Repo Identity And
//     Common-Directory Keying (V1 Definition)` requires both, because attach persists
//     the first and the default workspace roots at the second, and attaching from a
//     nested subdirectory is the case that separates them.
//   • `canonicalRoot` VERBATIM. No home-directory abbreviation, no basename
//     shortening, no prettifying. It is middle-truncated by the STYLESHEET at the
//     measure, with the full string recoverable through the element's title and the
//     copy control beside it — so the renderer is never the reason two different
//     roots look identical.
//   • TWO AXES, TWO CHIPS. Lifecycle (`attached` / `detached` / `archived`) and
//     health (`healthy` / `unreachable`) are separate facts and wear separate chips,
//     with `checkedAt` beside the health one because a probe instant is information.
//   • THE ROOTS SIT UNDER THE MOUNT THEY BELONG TO. Execution roots are read
//     session-wide and drawn per mount, because a root's only stated relation is its
//     `repoMountId` — and each one carries the change-proposal gate `ProposalGate.tsx`
//     owns, collapsed, one per worktree.
//   • THE IN-PLACE ROOT HAS NO ROW, SO ITS GATE SITS ON THE WORKSPACE CARD. `branch`
//     mode executes in the mount's own checkout and mints no worktree and no clone, so
//     a card that built gates only from root records reached none of these workspaces
//     at all. The gate is drawn under the workspace itself, which is the root.
//   • NO DETACH CONTROL, AND NO SILENCE ABOUT IT. `Spec-009 §Detach Semantics (V1
//     Definition)` gives the desktop renderer no detach surface in V1, and this card
//     DISCLOSES that absence rather than silently omitting it, so the provenance
//     disclosure names where detach lives instead.
//   • THE BIND ENTRY POINT SITS ON THE CARD, AND ONLY WHERE BINDS ARE OFFERED.
//     `Spec-009 §Default Behavior` mints one `read-only` workspace at attach, so every
//     writable workspace in a session comes from `repo.workspaceBind` — and the mount
//     is what that call is scoped to. It is drawn on exactly the posture that admits
//     it, so a detached, unreachable, or drifted mount shows its withheld sentence
//     instead of a control the daemon would refuse.
//   • ONE VERDICT CARRIES A CONTROL, AND IT IS THE PERMANENT ONE. `identity_mismatch`
//     refuses every bind and every run on this mount until someone acts, and
//     `Spec-009 §Repo Mount Health (V1 Definition)` names re-attaching as the
//     recovery — so that verdict, and no other, is drawn with the re-attach beside it.
//     `unreachable` is transient and gets none: its remedy is to make the path
//     reachable, and a control here would invite a second row for a repository that is
//     about to answer for itself.
//
// WHAT THE CARD DOES NOT DO. It never resolves, canonicalises, or compares a path —
// containment, symlink resolution, case folding, and working-tree-boundary awareness
// are daemon rules under `Spec-009 §Local Trust Envelope (V1 Definition)`, so the
// console sends the string and renders `repo.outside_trust_envelope` if it comes
// back. It never computes health and never softens `unreachable`. And it never
// re-attaches: re-attach mints a new mount row and is a participant-confirmed act.

import type {
  ExecutionMode,
  RepoMountReadResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceId,
} from "@ai-sidekicks/contracts";
import type { ConsoleBridge } from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import {
  Chip,
  Glyph,
  Nothing,
  RefusalCard,
  WireFigure,
  formatClockTime,
} from "../../primitives/index.js";
import type { SessionStore } from "../../store/index.js";
import {
  bindControlPosture,
  mountHealthReading,
  mountLifecycleReading,
  mountVcsReading,
} from "./mount-health.js";
import { ReattachControl } from "./attach/ReattachControl.js";
import { BindWorkspaceDialog } from "./bind/BindWorkspaceDialog.js";
import { ProposalGateDisclosure } from "../proposals/ProposalGateDisclosure.js";
import { branchRootGateSubject } from "../proposals/proposal-gate-model.js";
import { mountRefusalRecovery } from "./mount-refusal-copy.js";
import { RefusalRecovery } from "./RefusalRecovery.js";
import type { RepoWorkspaceRow } from "./repo-mounts-model.js";
import {
  workspaceRefusalFor,
  workspaceSelectionModeFor,
  type WorkspaceRefusals,
} from "./repo-mounts-model.js";
import { WorkspaceCard } from "./WorkspaceCard.js";
import { WorktreeGateRow } from "../proposals/WorktreeGateRow.js";
import {
  unpairedWorktreeCopy,
  worktreeGateRowSubjects,
} from "../proposals/worktree-gate-pairing.js";
import type { WorktreeStatusRecord } from "./worktree-model.js";
import { GLYPH_SIZE_CHROME } from "../../tokens/index.js";

/**
 * The writable mode whose execution root is the mount's own checkout.
 *
 * `satisfies ExecutionMode` rather than a free string, on `RepoSection.tsx`'s reason:
 * the word is the contract's own vocabulary (`packages/contracts/src/repo.ts`), and a
 * mode spelled by hand here would be a second spelling of the closed set the picker
 * beside it renders from.
 */
const IN_PLACE_EXECUTION_MODE = "branch" satisfies ExecutionMode;

export interface MountCardProps {
  readonly mount: RepoMountReadResponse;
  /** This mount's workspaces, in the order the list read returned them. */
  readonly workspaces: readonly RepoWorkspaceRow[];
  readonly capabilitiesByWorkspaceId: Readonly<
    Record<string, WorkspaceExecutionModeCapabilitiesReadResponse>
  >;
  /** Per workspace: what the read could not answer, and what a press could not do. */
  readonly workspaceRefusals: WorkspaceRefusals;
  /** Per workspace: the mode a switch is on the wire for, where one is. */
  readonly pendingModeByWorkspaceId: Readonly<Record<string, ExecutionMode>>;
  /** Every execution root this session holds. Filtered to this mount's here, not by the caller. */
  readonly worktrees: readonly WorktreeStatusRecord[];
  /** The root read's own failure, where it had one. Rendered where the roots would be. */
  readonly worktreeRefusal: ConsoleRefusal | undefined;
  /** The instant the section read at, so a root's age moves on a re-read and not on a render. */
  readonly nowMilliseconds: number;
  /** The bridge each root's gate reads its own branch context through. */
  readonly bridge: ConsoleBridge;
  /** The session each root's gate takes its reconnect and stale-frame triggers from. */
  readonly sessionStore: SessionStore;
  /** Put the resolved root on the clipboard; the host's own refusal is the caller's to render. */
  readonly onCopyCanonicalRoot: (canonicalRoot: string) => void;
  /** Read the section again, because a participant's act minted a mount it has not seen. */
  readonly onRequestRead: () => void;
  readonly onSelectExecutionMode: (workspaceId: WorkspaceId, executionMode: ExecutionMode) => void;
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
        <WireFigure value={mount.canonicalRoot} title={mount.canonicalRoot} />
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
          onBound={props.onRequestRead}
        />
      ) : null}
      {mount.health.status === "identity_mismatch" ? (
        <ReattachControl
          bridge={props.bridge}
          sessionStore={props.sessionStore}
          localPath={mount.localPath}
          nodeId={mount.nodeId}
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
          <dt>Owning node</dt>
          <dd>
            {/* Always, per `Spec-009 §Implementation Notes`: mount ownership sits on
                the runtime node that can actually reach the path. */}
            <WireFigure value={mount.nodeId} title={mount.nodeId} />
          </dd>
          <dt>Attached</dt>
          <dd>
            <WireFigure value={mount.attachedAt} title={mount.attachedAt} />
          </dd>
          <dt>Detaching</dt>
          <dd className="meridian-mount-card__disclosure">
            Detach is not offered here in V1. It is reached through the command-line and SDK
            surfaces, and there is no force option on a refused detach.
          </dd>
        </dl>
      </details>

      <div className="meridian-mount-card__roots">
        {props.worktreeRefusal === undefined ? null : (
          // THE RECOVERY RIDES THE CARD RATHER THAN SITTING BESIDE IT, because
          // `primitives/refusal-contract.ts` reserves `action` for exactly this and a
          // sentence rendered next to a refusal reads as a second, unrelated fact. A
          // code this family has no recovery for supplies `undefined` and the card
          // renders the daemon's own code and detail alone, which is the honest floor.
          <RefusalCard
            code={props.worktreeRefusal.code}
            detail={props.worktreeRefusal.detail}
            action={renderRefusalRecovery(props.worktreeRefusal.code)}
          />
        )}
        {renderRoots(props)}
      </div>

      <div className="meridian-mount-card__workspaces">
        {props.workspaces.length === 0 ? (
          <Nothing
            kind="empty"
            placement="surface"
            title="This mount has no workspaces."
            detail="Attach mints one read-only workspace, so an empty list here means the roster and the mount disagree."
          />
        ) : (
          props.workspaces.map((workspace) => (
            <div className="meridian-mount-card__workspace" key={workspace.id}>
              <WorkspaceCard
                workspace={workspace}
                capabilities={props.capabilitiesByWorkspaceId[workspace.id]}
                refusal={workspaceRefusalFor(props.workspaceRefusals, workspace.id)}
                refusalMode={workspaceSelectionModeFor(props.workspaceRefusals, workspace.id)}
                pendingMode={props.pendingModeByWorkspaceId[workspace.id]}
                mountCanonicalRoot={mount.canonicalRoot}
                bridge={props.bridge}
                sessionStore={props.sessionStore}
                onRequestRead={props.onRequestRead}
                modeControlsOffered={posture.offered}
                onSelectExecutionMode={(executionMode) => {
                  props.onSelectExecutionMode(workspace.id, executionMode);
                }}
              />
              {/*
                THE IN-PLACE ROOT'S GATE, drawn on the workspace card because that IS
                the root: `branch` mode executes in the mount's own checkout and mints
                no record of its own, so there is no row beneath this one to hang a gate
                under. Only the writable in-place mode gets one — a read-only workspace
                produces no branch context and has nothing to prepare.
              */}
              {workspace.executionMode === IN_PLACE_EXECUTION_MODE ? (
                <ProposalGateDisclosure
                  bridge={props.bridge}
                  subject={branchRootGateSubject(workspace)}
                  sessionStore={props.sessionStore}
                />
              ) : null}
            </div>
          ))
        )}
      </div>
    </article>
  );
}

/**
 * This mount's execution roots, each with its gate.
 *
 * The empty arm is `empty` and never `not-checked`: the root read is part of the same
 * burst as the mount read, so by the time a card is on screen the question HAS been
 * put — a mount with no roots is a mount nothing has run writably in yet, which is an
 * ordinary state and says so.
 *
 * A REFUSED ROOT READ IS THE WHOLE STATEMENT, AND THE EMPTY ARM IS NOT ALSO DRAWN. The
 * reader supplies `worktrees: []` beside a refusal, so the empty arm would otherwise
 * report "no execution root on disk" over a read that never answered — a
 * successful-empty claim about a failure. Nothing stands in its place either: the
 * roots WERE asked for, so rule 8's `not-checked` would be false, and the refusal card
 * above already says which read failed and why. The guard is HERE, in the function
 * that owns the empty arm, so one place decides.
 */
function renderRoots(props: MountCardProps): React.JSX.Element | null {
  if (props.worktreeRefusal !== undefined) {
    return null;
  }
  const rows = worktreeGateRowSubjects(props.worktrees, props.workspaces, props.mount.id);
  if (rows.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="No execution root on disk for this mount."
        detail="A root is created when a run selects a writable execution mode, so a mount with none has had no writable run yet."
      />
    );
  }
  const unpairedReason = unpairedWorktreeCopy(props.workspaces, props.mount.id);
  return (
    <>
      {rows.map((row) => (
        <WorktreeGateRow
          key={row.record.worktreeId}
          record={row.record}
          subject={row.subject}
          unpairedReason={unpairedReason}
          bridge={props.bridge}
          sessionStore={props.sessionStore}
          nowMilliseconds={props.nowMilliseconds}
          onRequestRead={props.onRequestRead}
        />
      ))}
    </>
  );
}

/**
 * The recovery slot for a refusal that carries one, and nothing for a refusal that
 * does not.
 *
 * A FUNCTION RATHER THAN AN INLINE TERNARY, because the same decision is made at two
 * shapes in this family — a card here, an inline sentence in the mode picker — and
 * `apps/desktop/AGENTS.md` hoists a helper on its second use. What is shared is the
 * LOOKUP; which shape carries it stays each call site's decision about blast radius.
 *
 * NO CONTEXT IS SUPPLIED, and the omission is exact. The one code whose recovery takes
 * one is `workspace.mode_unsupported`, whose remedy is the mount's own restriction
 * reason for the mode that was refused — and a root read refuses none of the codes
 * that carry a mode. Supplying an empty context here would be indistinguishable, at
 * the call site, from having forgotten to look one up.
 */
function renderRefusalRecovery(code: string): React.JSX.Element | undefined {
  const recovery = mountRefusalRecovery(code);
  return recovery === undefined ? undefined : <RefusalRecovery recovery={recovery} />;
}
