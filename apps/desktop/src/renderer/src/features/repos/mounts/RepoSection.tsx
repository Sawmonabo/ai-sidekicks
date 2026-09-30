// Loaded first so the sheets its children import (`bind/bind.css`) override it at equal
// specificity.
import "./mount-controls.css";

import { useCallback } from "react";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { type PaneOpener } from "@renderer/routing/panes/pane-address.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";

import { AttachRepositoryDialog } from "./attach/AttachRepositoryDialog.js";
import { useRepoMounts } from "./hooks/useRepoMounts.js";
import { type RepoOperations } from "../repo-operations.js";
import { type OpenDiffSubject } from "./components/OpenDiffControl.js";
import { MountList } from "./components/MountList.js";
import { RepoMountsSummary } from "./components/RepoMountsSummary.js";

/** Props for the repositories section. */
export interface RepoSectionProps {
  readonly bridge: PlatformBridge;
  readonly sessionStore: SessionStore;
  /** Whether the section is expanded; collapsed, it shows only the summary line. */
  readonly isOpen: boolean;
  /** How the section opens a pane in its own window's pane layout. */
  readonly openPane: PaneOpener;
  /** The calls the section makes. Must be the same object between renders. */
  readonly operations: RepoOperations;
}

/** The repositories section of the sidebar: attach control, mount cards, and their actions. */
export function RepoSection(props: RepoSectionProps): React.JSX.Element {
  const { bridge, sessionStore, operations, isOpen, openPane } = props;
  const { reading, requestModeSelection, requestRead } = useRepoMounts(
    bridge,
    sessionStore,
    operations,
  );

  const copyCanonicalRoot = useCallback(
    (canonicalRoot: string) => {
      void bridge.native.copyToClipboard(canonicalRoot);
    },
    [bridge],
  );

  // The pane layout is handed to the section rather than imported, so a sidebar in an
  // auxiliary window opens panes in that window's layout. Rows take this callback and never
  // the opener.
  const openDiff = useCallback(
    (subject: OpenDiffSubject) => {
      openPane({ kind: "diff", entity: subject });
    },
    [openPane],
  );

  if (!isOpen) {
    return (
      <p className="meridian-repo-section__summary">
        <RepoMountsSummary reading={reading} />
      </p>
    );
  }

  return (
    <div className="meridian-repo-section">
      {/*
        Above the list, not inside the empty card: a session that already holds a repository
        can attach a second.
      */}
      <AttachRepositoryDialog
        bridge={bridge}
        sessionId={sessionStore.sessionId}
        operations={operations}
        onAttached={requestRead}
      />
      <div className="meridian-repo-section__mounts">
        <MountList
          reading={reading}
          bridge={bridge}
          sessionStore={sessionStore}
          operations={operations}
          onCopy={copyCanonicalRoot}
          onRequestRead={requestRead}
          onSelect={requestModeSelection}
          onOpenDiff={openDiff}
        />
      </div>
    </div>
  );
}
