import { useCallback } from "react";
import { type ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { type ConsolePaneOpener } from "@renderer/console/seats/index.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";

import { AttachRepositoryDialog } from "./attach/AttachRepositoryDialog.js";
import { useRepoMounts } from "./hooks/useRepoMounts.js";
import { type RepoOperations } from "../repo-operations.js";
import { type OpenDiffSubject } from "./components/OpenDiffControl.js";
import { MountList } from "./components/MountList.js";
import { RepoMountsSummary } from "./components/RepoMountsSummary.js";

export interface RepoSectionProps {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
  /** Whether the section is expanded; collapsed, it shows only the summary line. */
  readonly isOpen: boolean;
  /** How the section opens a pane in its own window's deck. */
  readonly openPane: ConsolePaneOpener;
  /** The calls the section makes. Must be the same object between renders. */
  readonly operations: RepoOperations;
}

export function RepoSection(props: RepoSectionProps): React.JSX.Element {
  const { bridge, sessionStore, operations, isOpen, openPane } = props;
  const { reading, requestModeSelection, requestRead } = useRepoMounts(
    bridge,
    sessionStore,
    operations,
  );

  const copyCanonicalRoot = useCallback(
    (canonicalRoot: string) => {
      void bridge.desktopBridge.native.copyToClipboard(canonicalRoot);
    },
    [bridge],
  );

  // THE SECTION IS WHERE THE OPENER LIVES, because the deck is handed to a section
  // rather than imported by one — a sidebar rendered in an auxiliary window opens its
  // panes in THAT window's deck. The rows below take a callback and never the opener,
  // so no card knows a pane address exists.
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
        THE ATTACH ENTRY POINT SITS ABOVE THE LIST AND NOT INSIDE THE EMPTY CARD,
        because a session that already holds one repository can attach a second: an
        affordance that only appeared when the list was empty would make the first
        attach reachable and every later one not.
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
