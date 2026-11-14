// What the line under the terminal's strip reads: the session's project and its tree, read off the
// window's shared session and project lists. Every shell runs in the session's tree, so the line
// reads the same for every tab.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { projectListFeedFor } from "#renderer/services/daemon/project-list.js";
import { sessionDirectoryFeedFor } from "#renderer/services/daemon/session/list-feed.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useSessionProject } from "#renderer/store/projects/hooks/useSessionProject.js";

/**
 * `<project> · <tree>` for a project session, the project alone while its tree names no branch,
 * and `undefined` until both lists name the session's project.
 */
export function useProjectTreeLine(
  bridge: PlatformBridge,
  sessionId: SessionId,
): string | undefined {
  const { session, project } = useSessionProject(
    sessionDirectoryFeedFor(bridge),
    projectListFeedFor(bridge),
    sessionId,
  );
  if (session?.shape !== "project" || project === undefined) {
    return undefined;
  }
  return session.branch === undefined ? project.name : `${project.name} · ${session.branch}`;
}
