// The session sidebar's repos section — the read, the list, and what it says instead.
//
// `Spec-023 §Console Design (Meridian)` §10.1 gives the section its job: say which
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
// THE READ RUNS WHILE COLLAPSED, AND THAT IS THE POINT. The sidebar's open/collapsed
// rule is decided by whether a section carries an amber or red item, which a section
// that had not read cannot know. So the reader starts on mount and the collapsed line
// reports what it found — one read burst per mount, no interval, no poll.
//
// WHAT IS DELIBERATELY NOT OFFERED HERE. §10.1 also describes an attach entry point —
// a local path picker plus a node picker sent as `repo.attach`. The node picker needs
// the session's runtime-node roster, which no read this section holds carries, and a
// control that cannot name the node it would attach on is a control that can only
// fail. So the empty state names attach as the deliberate act it is and says where it
// is reached today, on the same disclosure posture the card takes for detach.

import type { ExecutionMode, WorkspaceId } from "@ai-sidekicks/contracts";
import { useCallback, useState } from "react";
import type { ConsoleBridge } from "../bridge/index.js";
import { type ConsoleRefusal } from "../core/index.js";
import { Nothing, RefusalCard } from "../primitives/index.js";
import { type SidebarSectionContext } from "../workspace/index.js";
import { MountCard } from "./MountCard.js";
import { useRepoMounts, type RepoMountsReading } from "./repo-mounts-reader.js";
import { refusalFromRejection } from "./repo-reads.js";

export interface RepoSectionProps {
  readonly context: SidebarSectionContext;
}

/** What an unread section says, in both shapes. */
const NOT_READ_TITLE = "Repo mounts have not been read.";

export function RepoSection(props: RepoSectionProps): React.JSX.Element {
  const { bridge, sessionStore, isOpen } = props.context;
  const { reading, requestModeSelection } = useRepoMounts(bridge, sessionStore.sessionId);
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
          onCopy={copyCanonicalRoot}
          onSelect={requestModeSelection}
        />
      </div>
    </div>
  );
}

interface MountListProps {
  readonly reading: RepoMountsReading;
  /** Passed down rather than reached for: each root's gate performs its own read. */
  readonly bridge: ConsoleBridge;
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
            worktrees={reading.worktrees}
            worktreeRefusal={reading.worktreeRefusal}
            nowMilliseconds={reading.readAtMilliseconds}
            bridge={props.bridge}
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
