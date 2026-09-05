import { Nothing } from "../../primitives/index.js";
import { MountCard } from "./MountCard.js";
import { type RepoMountsReading } from "./repo-mounts-model.js";
import { type ConsoleBridge } from "../../bridge/index.js";
import { SessionStore } from "../../store/index.js";
import { type WorkspaceId, type ExecutionMode } from "@ai-sidekicks/contracts";
import { NOT_READ_TITLE } from "./repo-mounts-copy.js";

export function MountList(props: MountListProps): React.JSX.Element {
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
            workspaceRefusals={reading.workspaceRefusals}
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

export interface MountListProps {
  readonly reading: RepoMountsReading;
  /** Passed down rather than reached for: each root's gate performs its own read. */
  readonly bridge: ConsoleBridge;
  /** Passed down for the same reason: each root's gate arms its own refresh triggers. */
  readonly sessionStore: SessionStore;
  readonly onCopy: (canonicalRoot: string) => void;
  readonly onSelect: (workspaceId: WorkspaceId, executionMode: ExecutionMode) => void;
}
