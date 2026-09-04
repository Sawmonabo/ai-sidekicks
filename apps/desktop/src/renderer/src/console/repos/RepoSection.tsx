// The session sidebar's repos section — the read, the list, and what it says instead.
//
// THE SECTION'S JOB IS THIS MODULE'S TO STATE — `Spec-023 §Console Design (Meridian)`
// puts each surface's composition in the console's code: say which
// repositories this session is attached to, on which node, and whether each is still
// the repository it was attached as. The per-mount answers live on the mount cards
// beside this file; what this file owns is the read that produces them, where they
// sit, and what stands in their place.
//
// A LIST, NEVER A SINGLE SLOT. `Spec-009 §Required Behavior` admits several repo
// mounts in one session, so the region below is a list even at one member and even at
// none. A section that rendered one mount and grew a list later would have to move
// every card it had already drawn.
//
// THE SIDEBAR OWNS THE HEADER. `SidebarSectionContext.isOpen` is the sidebar's answer,
// not the section's — the rule it comes from is stated over the whole sidebar ("a
// section carrying an amber or red item is open and every other section is
// collapsed"), so a section that drew its own disclosure would be a second source of
// truth for it. This body renders its content when the sidebar says it is open and
// one honest line when it does not, and it draws no heading.
//
// BOTH KINDS OF EXECUTION ROOT REACH THE SCREEN, AND FROM DIFFERENT PLACES.
// `repo.worktreeStatusRead` answers with two arrays; the worktrees are drawn under
// the mount each one names, because `repoMountId` is on the row. A CLONE names a
// WORKSPACE and no mount, so the only anchoring the wire gives it is the session —
// and the clone list therefore sits at the section, beside the mounts rather than
// inside one. Filing it under a mount would mean resolving its workspace through the
// roster, which is a second read and a pairing rule for a relation the reply does not
// state.
//
// THE CLONE LIST IS NOT GATED ON THE MOUNT READ, because the two are different calls.
// `repo.mountRead` is per mount and `repo.worktreeStatusRead` is per session, so one
// mount failing to probe leaves the session's execution roots entirely readable — and
// suppressing the list on that refusal took valid roots off the screen for a reason that
// was not about them. Which absence the list may report is its own reading's to decide.
//
// THE READ RUNS WHILE COLLAPSED, AND THAT IS THE POINT. The sidebar's open/collapsed
// rule is decided by whether a section carries an amber or red item, which a section
// that had not read cannot know. So the reader starts on mount and the collapsed line
// reports what it found — one read burst per mount, no interval, no poll.
//
// WHAT IS DELIBERATELY NOT OFFERED HERE. This section would otherwise carry an attach
// entry point — a local path picker plus a node picker sent as `repo.attach`. The node
// picker needs
// the session's runtime-node roster, which no read this section holds carries, and a
// control that cannot name the node it would attach on is a control that can only
// fail. So the empty state names attach as the deliberate act it is and says where it
// is reached today, on the same disclosure posture the card takes for detach.

import type { ExecutionMode, WorkspaceId } from "@ai-sidekicks/contracts";
import { useCallback, useState } from "react";
import type { ConsoleBridge } from "../bridge/index.js";
import { type ConsoleRefusal } from "../core/index.js";
import { Nothing, RefusalCard } from "../primitives/index.js";
import type { SessionStore } from "../store/index.js";
import { type SidebarSectionContext } from "../seats/index.js";
import { EphemeralCloneGateRow } from "./EphemeralCloneGateRow.js";
import { MountCard } from "./MountCard.js";
import { ephemeralCloneGateSubject } from "./proposal-gate-model.js";
import { useRepoMounts, type RepoMountsReading } from "./repo-mounts-reader.js";
import { refusalFromRejection } from "./repo-reads.js";

export interface RepoSectionProps {
  readonly context: SidebarSectionContext;
}

/** What an unread section says, in both shapes. */
const NOT_READ_TITLE = "Repo mounts have not been read.";

/**
 * The clone list's heading, naming the execution mode those roots belong to.
 *
 * `satisfies ExecutionMode` rather than a free string: `"ephemeral clone"` is the
 * contract's own vocabulary (`packages/contracts/src/repo.ts`), and a heading spelled
 * by hand would be a second spelling of a closed set the picker beside it renders
 * from — the drift a `satisfies` makes impossible.
 */
const CLONE_EXECUTION_MODE = "ephemeral clone" satisfies ExecutionMode;

const CLONE_LIST_HEADING = `Roots for the ${CLONE_EXECUTION_MODE} mode`;

/** What the clone list says before and after the one read that names a clone. */
const CLONES_NOT_READ_TITLE = "Execution roots have not been read.";

export function RepoSection(props: RepoSectionProps): React.JSX.Element {
  const { bridge, sessionStore, isOpen } = props.context;
  const { reading, requestModeSelection } = useRepoMounts(bridge, sessionStore);
  const [copyRefusal, setCopyRefusal] = useState<ConsoleRefusal | undefined>(undefined);

  const copyCanonicalRoot = useCallback(
    (canonicalRoot: string) => {
      setCopyRefusal(undefined);
      bridge.sidekicks.native.copyToClipboard(canonicalRoot).catch((rejection: unknown) => {
        // The host refused the clipboard. Rendered rather than swallowed: the root is
        // still on screen and still recoverable through the element's title, so the
        // person needs to know the copy did not happen, not be told it did.
        setCopyRefusal(refusalFromRejection("native.copyToClipboard", rejection));
      });
    },
    [bridge],
  );

  if (!isOpen) {
    return (
      <p className="meridian-repo-section__summary">
        <CollapsedSummary reading={reading} />
      </p>
    );
  }

  return (
    <div className="meridian-repo-section">
      <div className="meridian-repo-section__mounts">
        {reading.refusal !== undefined ? (
          <RefusalCard code={reading.refusal.code} detail={reading.refusal.detail} />
        ) : null}
        {copyRefusal !== undefined ? (
          <RefusalCard code={copyRefusal.code} detail={copyRefusal.detail} />
        ) : null}
        <MountList
          reading={reading}
          bridge={bridge}
          sessionStore={sessionStore}
          onCopy={copyCanonicalRoot}
          onSelect={requestModeSelection}
        />
        {/*
          DRAWN WHATEVER THE MOUNT READ DID. The clone list comes off
          `repo.worktreeStatusRead`, which is a different call with a different scope:
          one `repo.mountRead` failing sets the section's refusal and says nothing at
          all about the roots this session holds. Gating the list on that refusal took
          valid execution roots off the screen because an unrelated mount could not be
          probed. What the list is allowed to say is decided by its OWN reading below.
        */}
        <EphemeralCloneList reading={reading} bridge={bridge} sessionStore={sessionStore} />
      </div>
    </div>
  );
}

/**
 * The clones this session holds, drawn beside the mounts rather than under one.
 *
 * SESSION-SCOPED, because that is the only anchoring the wire gives them. A clone row
 * names a WORKSPACE (`ephemeral_clones.workspace_id`) where a worktree row names a
 * MOUNT, so a clone reaches a mount only through the roster — and a session whose
 * roster read answered while a mount read did not would then have clones nothing
 * could draw. The list sits at the section, where the read that produced it was made.
 *
 * TWO LISTS WITH DIFFERENT COLUMNS, this section's own split and stated here because
 * it is drawn here. `EphemeralCloneCard` is the second one: the disposal countdown is on
 * the row rather than behind the disclosure, because it is the one fact here that
 * changes with nobody acting.
 *
 * AND EACH CLONE CARRIES ITS OWN CHANGE-PROPOSAL GATE, for the reason the mount card
 * states about the in-place root: a clone is one of the three WRITABLE execution
 * modes, so a list that drew the root and no gate left a participant running in that
 * mode with no way to read a branch context, prepare a proposal, or ask for a reviewed
 * act at all.
 */
function EphemeralCloneList(props: EphemeralCloneListProps): React.JSX.Element {
  return (
    <div className="meridian-repo-section__clones">
      <h4 className="meridian-repo-section__clones-heading">{CLONE_LIST_HEADING}</h4>
      {renderCloneRows(props)}
    </div>
  );
}

interface EphemeralCloneListProps {
  readonly reading: RepoMountsReading;
  /** Passed down rather than reached for: each clone's gate performs its own read. */
  readonly bridge: ConsoleBridge;
  /** Passed down for the same reason: each clone's gate arms its own refresh triggers. */
  readonly sessionStore: SessionStore;
}

/**
 * The clone rows, or the one absence that stands in for them.
 *
 * A function returning JSX rather than a second component, on `MountCard`'s own
 * `renderRoots` precedent: the branches decide which absence a settled read produced,
 * which is a reading rather than a surface of its own.
 *
 * The subject is resolved HERE, from the roster this same reading carries, because the
 * clone row names its workspace but not that workspace's execution mode — and the mode
 * is what a gate's summary reports the context under. Where the roster names no
 * such workspace the row draws its absence instead, which is the pairing module's rule
 * applied to the one relation this list can be missing.
 */
function renderCloneRows(props: EphemeralCloneListProps): React.JSX.Element {
  const { reading } = props;
  if (reading.ephemeralClones.length > 0) {
    return (
      <>
        {reading.ephemeralClones.map((record) => (
          <EphemeralCloneGateRow
            key={record.cloneId}
            record={record}
            subject={ephemeralCloneGateSubject(record, reading.workspaces)}
            bridge={props.bridge}
            sessionStore={props.sessionStore}
            nowMilliseconds={reading.readAtMilliseconds}
          />
        ))}
      </>
    );
  }
  if (reading.status === "reading") {
    return <Nothing kind="computing" placement="surface" title="Reading execution roots." />;
  }
  if (reading.status === "not-read") {
    return <Nothing kind="not-checked" placement="surface" title={CLONES_NOT_READ_TITLE} />;
  }
  if (reading.worktreeRefusal !== undefined) {
    // `not-checked` and never `empty`: the root read is the only read that names a
    // clone, it did not answer, and reporting "there are none" would be the console
    // asserting a fact nothing established. The daemon's own sentence stays where it
    // was refused — on the mount cards above — so it is not printed twice.
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="Ephemeral clones have not been read."
        detail="The execution-root read was refused, so which clones this session holds is unknown."
      />
    );
  }
  if (reading.worktreeReadPosition === "not-made") {
    // A DIFFERENT ABSENCE FROM THE ONE ABOVE, and it is the one a settled section can
    // otherwise mistake for `empty`: the workspace list refused, so the burst stopped
    // before the root read and there is no refusal of its own to report. The section's
    // own refusal card names what failed; this says what that leaves unknown.
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title={CLONES_NOT_READ_TITLE}
        detail="The section's read stopped before the execution-root call, so which clones this session holds was never asked."
      />
    );
  }
  return (
    <Nothing
      kind="empty"
      placement="surface"
      title="This session holds no ephemeral clone."
      detail="A clone is provisioned when a run selects the ephemeral clone execution mode, and it is disposed on its own schedule — so a session with none has run nothing in that mode."
    />
  );
}

interface MountListProps {
  readonly reading: RepoMountsReading;
  /** Passed down rather than reached for: each root's gate performs its own read. */
  readonly bridge: ConsoleBridge;
  /** Passed down for the same reason: each root's gate arms its own refresh triggers. */
  readonly sessionStore: SessionStore;
  readonly onCopy: (canonicalRoot: string) => void;
  readonly onSelect: (workspaceId: WorkspaceId, executionMode: ExecutionMode) => void;
}

function MountList(props: MountListProps): React.JSX.Element {
  const { reading } = props;
  if (reading.mounts.length > 0) {
    return (
      <>
        {reading.mounts.map((mount) => (
          <MountCard
            key={mount.id}
            mount={mount}
            workspaces={reading.workspaces.filter((row) => row.repoMountId === mount.id)}
            capabilitiesByWorkspaceId={reading.capabilitiesByWorkspaceId}
            refusalByWorkspaceId={reading.refusalByWorkspaceId}
            pendingModeByWorkspaceId={reading.pendingModeByWorkspaceId}
            worktrees={reading.worktrees}
            worktreeRefusal={reading.worktreeRefusal}
            nowMilliseconds={reading.readAtMilliseconds}
            bridge={props.bridge}
            sessionStore={props.sessionStore}
            onCopyCanonicalRoot={props.onCopy}
            onSelectExecutionMode={props.onSelect}
          />
        ))}
      </>
    );
  }
  if (reading.status === "read" && reading.refusal === undefined) {
    // The read succeeded and found none. Rule 8's `empty`, and never `not-checked`:
    // the question WAS put.
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="No repository is attached to this session."
        detail="Attaching is deliberate — nothing is attached automatically. Attach is reached through the command-line and SDK surfaces today; once a repository is attached, this section names each mount's resolved root, the node that owns it, and whether it is still the repository it was attached as."
      />
    );
  }
  if (reading.status === "reading") {
    return <Nothing kind="computing" placement="surface" title="Reading repo mounts." />;
  }
  return (
    <Nothing
      kind="not-checked"
      placement="surface"
      title={NOT_READ_TITLE}
      detail="This section will name each mount's resolved root, the node that owns it, and whether it is still the repository it was attached as."
    />
  );
}

/**
 * The collapsed line.
 *
 * A collapsed section has one line of room, and the sidebar decided to collapse it,
 * so the line reports the fact that decision was made against rather than repeating
 * the section's name back.
 */
function CollapsedSummary(props: { readonly reading: RepoMountsReading }): React.JSX.Element {
  const { reading } = props;
  if (reading.refusal !== undefined) {
    return <Nothing kind="error" title={reading.refusal.code} detail={reading.refusal.detail} />;
  }
  if (reading.status === "reading") {
    return <Nothing kind="computing" title="Reading repo mounts." />;
  }
  if (reading.status === "not-read") {
    return <Nothing kind="not-checked" title={NOT_READ_TITLE} />;
  }
  const unreachableCount = reading.mounts.filter(
    (mount) => mount.health.status !== "healthy",
  ).length;
  if (reading.mounts.length === 0) {
    return <Nothing kind="empty" title="No repository is attached." />;
  }
  return (
    <span className="meridian-repo-section__count">
      {reading.mounts.length} mounted
      {unreachableCount > 0 ? `, ${unreachableCount} unreachable` : ""}
    </span>
  );
}
