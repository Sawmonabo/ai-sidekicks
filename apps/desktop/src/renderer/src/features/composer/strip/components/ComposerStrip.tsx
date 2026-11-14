// The strip under the composer: on a project session the project chip and the worktree switcher,
// on a chat `Session workspace` beside `Attach a repo`, and at the right the Sidekicks badge. The
// session's shape, project and tree are read off the window's shared session and project lists.

import { useState } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { projectListFeedFor } from "#renderer/services/daemon/project-list.js";
import { sessionDirectoryFeedFor } from "#renderer/services/daemon/session/list-feed.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useSessionProject } from "#renderer/store/projects/hooks/useSessionProject.js";
import { listedSessionOf } from "#renderer/store/session/directory/state.js";
import { useSessionDirectory } from "#renderer/store/session/directory/useSessionDirectory.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { ConvertToProjectForm } from "./ConvertToProjectForm.js";
import { SidekicksBadge } from "./SidekicksBadge.js";
import { WorktreeSwitcher } from "./WorktreeSwitcher.js";

import "./ComposerStrip.css";

/** What the strip reads: the session, and the acts its `Details` and its badge open. */
export interface ComposerStripProps {
  readonly bridge: PlatformBridge;
  readonly sessionStore: SessionStore;
  readonly sessionId: SessionId;
  readonly openDetails: () => void;
  /** Open the Sidekicks pane on its list. */
  readonly openSidekicks: () => void;
}

/** The strip; empty at its left until the session's listing is read. */
export function ComposerStrip(props: ComposerStripProps): React.JSX.Element {
  const directoryFeed = sessionDirectoryFeedFor(props.bridge);
  const directory = useSessionDirectory(directoryFeed);
  const { session, project } = useSessionProject(
    directoryFeed,
    projectListFeedFor(props.bridge),
    props.sessionId,
  );
  const [isConverting, setIsConverting] = useState(false);
  const sessionNameOf = (sessionId: string): string =>
    listedSessionOf(directory, sessionId)?.name ?? sessionId;
  return (
    <>
      {isConverting && session?.shape === "chat" ? (
        <ConvertToProjectForm
          bridge={props.bridge}
          sessionId={props.sessionId}
          onClose={() => {
            setIsConverting(false);
          }}
        />
      ) : null}
      <div className="meridian-composer-strip">
        {session?.shape === "project" && project !== undefined ? (
          <>
            <span className="meridian-composer-chip">{project.name}</span>
            <WorktreeSwitcher
              bridge={props.bridge}
              sessionId={props.sessionId}
              project={project}
              currentName={session.branch ?? project.name}
              sessionNameOf={sessionNameOf}
              openDetails={props.openDetails}
            />
          </>
        ) : null}
        {session?.shape === "chat" ? (
          <>
            <span className="meridian-composer-chip">
              <Glyph name="worktree" />
              Session workspace
            </span>
            <button
              type="button"
              className="meridian-clickable-word"
              onClick={() => {
                setIsConverting(true);
              }}
            >
              Attach a repo
            </button>
          </>
        ) : null}
        <span className="meridian-composer-strip__end">
          <SidekicksBadge
            bridge={props.bridge}
            sessionStore={props.sessionStore}
            openSidekicks={props.openSidekicks}
          />
        </span>
      </div>
    </>
  );
}
