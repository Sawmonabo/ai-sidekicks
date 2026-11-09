// What the line under the terminal's strip reads: the session's project and its tree, read off the
// window's shared session and project lists. Every shell runs in the session's tree, so the line
// reads the same for every tab.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { projectListFeedFor } from "#renderer/services/daemon/project-list.js";
import { sessionDirectoryFeedFor } from "#renderer/services/daemon/session/list-feed.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useProjectList } from "#renderer/store/projects/hooks/useProjectList.js";
import { listedSessionOf } from "#renderer/store/session/directory/state.js";
import { useSessionDirectory } from "#renderer/store/session/directory/useSessionDirectory.js";

/**
 * `<project> · <tree>` for a project session, the project alone while its tree names no branch,
 * and `undefined` until both lists name the session's project.
 */
export function useProjectTreeLine(
  bridge: PlatformBridge,
  sessionId: SessionId,
): string | undefined {
  const session = listedSessionOf(useSessionDirectory(sessionDirectoryFeedFor(bridge)), sessionId);
  const projects = useProjectList(projectListFeedFor(bridge));
  if (session?.shape !== "project" || projects.status !== "served") {
    return undefined;
  }
  const project = projects.projects.find((listed) => listed.projectId === session.projectId);
  if (project === undefined) {
    return undefined;
  }
  return session.branch === undefined ? project.name : `${project.name} · ${session.branch}`;
}
