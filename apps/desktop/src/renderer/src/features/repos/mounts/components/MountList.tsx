import "./mounts.css";

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { MountCard } from "./MountCard.js";
import { type OpenDiffSubject } from "./OpenDiffControl.js";
import { type RepoMountsReading } from "../repo-mounts-model.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type RepoOperations } from "../../repo-operations.js";
import { type WorkspaceId, type ExecutionMode } from "@ai-sidekicks/contracts";

/** What the mount list reads and the handlers it passes through to each card. */
export interface MountListProps {
  readonly reading: RepoMountsReading;
  /** Passed down to each card's controls, which take their clock from it. */
  readonly bridge: PlatformBridge;
  /** Passed down for the same reason: each control arms its own refresh triggers. */
  readonly sessionStore: SessionStore;
  /** The calls each card's controls make. */
  readonly operations: RepoOperations;
  readonly onCopy: (canonicalRoot: string) => void;
  /** Read the section again after a user's own act. Passed through to each card. */
  readonly onRequestRead: () => void;
  readonly onSelect: (workspaceId: WorkspaceId, executionMode: ExecutionMode) => void;
  /** Open a change set over one row's subject. Passed through to each card. */
  readonly onOpenDiff: (subject: OpenDiffSubject) => void;
}

/** Every mount card for a reading, or the placeholder that says why there are none. */
export function MountList(props: MountListProps): React.JSX.Element | null {
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
            pendingModeByWorkspaceId={reading.pendingModeByWorkspaceId}
            refusedModeByWorkspaceId={reading.refusedModeByWorkspaceId}
            bridge={props.bridge}
            sessionStore={props.sessionStore}
            operations={props.operations}
            onCopyCanonicalRoot={props.onCopy}
            onRequestRead={props.onRequestRead}
            onSelectExecutionMode={props.onSelect}
            onOpenDiff={props.onOpenDiff}
          />
        ))}
      </>
    );
  }
  if (reading.status === "reading") {
    return <Nothing kind="computing" placement="block" title="Reading repo mounts." />;
  }
  if (reading.status === "read") {
    // An answered read that found none is `empty`, never `not-checked`.
    return (
      <Nothing
        kind="empty"
        placement="block"
        title="No repository is attached to this session."
        detail="Attaching is deliberate — nothing is attached automatically. Once a repository is attached, this section names each mount's resolved root and whether it is still the repository it was attached as."
      />
    );
  }
  return (
    <Nothing
      kind="not-checked"
      placement="block"
      title="Repo mounts have not been read."
      detail="This section will name each mount's resolved root and whether it is still the repository it was attached as."
    />
  );
}
