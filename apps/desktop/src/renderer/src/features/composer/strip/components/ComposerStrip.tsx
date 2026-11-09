// The strip under the composer: on a project session the project chip and the worktree switcher,
// on a chat `Session workspace` beside `Attach a repo`, and at the right the Sidekicks badge. The
// session's shape, project and tree are read off the window's shared session and project lists.

import { useState } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { projectListFeedFor } from "#renderer/services/daemon/project-list.js";
import { sessionDirectoryFeedFor } from "#renderer/services/daemon/session/list-feed.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useProjectList } from "#renderer/store/projects/hooks/useProjectList.js";
import { listedSessionOf } from "#renderer/store/session/directory/state.js";
import { useSessionDirectory } from "#renderer/store/session/directory/useSessionDirectory.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { ConvertToProjectForm } from "./ConvertToProjectForm.js";
import { SidekicksBadge } from "./SidekicksBadge.js";
import { WorktreeSwitcher } from "./WorktreeSwitcher.js";

import "./ComposerStrip.css";

/** What the strip reads: the session, and the act that opens the inspector for `Details`. */
export interface ComposerStripProps {
  readonly bridge: PlatformBridge;
  readonly sessionStore: SessionStore;
  readonly sessionId: SessionId;
  readonly openDetails: () => void;
}

/** The strip; empty at its left until the session's listing is read. */
export function ComposerStrip(props: ComposerStripProps): React.JSX.Element {
  const directory = useSessionDirectory(sessionDirectoryFeedFor(props.bridge));
  const projects = useProjectList(projectListFeedFor(props.bridge));
  const [isConverting, setIsConverting] = useState(false);
  const session = listedSessionOf(directory, props.sessionId);
  const project =
    session?.shape === "project" && projects.status === "served"
      ? projects.projects.find((listed) => listed.projectId === session.projectId)
      : undefined;
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
              projectId={session.projectId}
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
          <SidekicksBadge bridge={props.bridge} sessionStore={props.sessionStore} />
        </span>
      </div>
    </>
  );
}
