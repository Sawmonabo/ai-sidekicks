// A session's listing and its project, read off the window's shared session and project lists,
// for the views that name where a session works.

import type { ProjectListEntry } from "@ai-sidekicks/contracts/project";
import type { SessionListEntry } from "@ai-sidekicks/contracts/session/directory";

import {
  listedSessionOf,
  type SessionDirectoryFeed,
} from "#renderer/store/session/directory/state.js";
import { useSessionDirectory } from "#renderer/store/session/directory/useSessionDirectory.js";
import type { ProjectListFeed } from "../list.js";
import { useProjectList } from "./useProjectList.js";

/** A session's listing and, for a project session, its project; each absent until listed. */
export interface SessionProject {
  readonly session: SessionListEntry | undefined;
  readonly project: ProjectListEntry | undefined;
}

/** Read `sessionId`'s listing and project from the two feeds while the caller is mounted. */
export function useSessionProject(
  directoryFeed: SessionDirectoryFeed,
  projectFeed: ProjectListFeed,
  sessionId: string,
): SessionProject {
  const session = listedSessionOf(useSessionDirectory(directoryFeed), sessionId);
  const projects = useProjectList(projectFeed);
  const project =
    session?.shape === "project" && projects.status === "served"
      ? projects.projects.find((listed) => listed.projectId === session.projectId)
      : undefined;
  return { session, project };
}
