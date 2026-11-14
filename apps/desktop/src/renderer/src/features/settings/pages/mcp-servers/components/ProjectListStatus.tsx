import type { ReactNode } from "react";

import type { ProjectListEntry } from "@ai-sidekicks/contracts/project";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { Clock } from "#renderer/lib/clock.js";
import type { ProjectListState } from "#renderer/store/projects/list.js";

/** The service's projects as read, and the act that reads them again after a failed read. */
export interface ProjectListReading {
  readonly state: ProjectListState;
  readonly readAgain: () => void;
}

/** The code a project list that could not be read is drawn under. */
const PROJECT_LIST_UNREAD_CODE = "project-list-unread";

/**
 * Where the project list stands while it is not served: its loading line while it is read, its
 * failure with `Try again` once a read failed, and nothing once it is served.
 */
export function ProjectListStatus(props: {
  readonly projects: ProjectListReading;
  readonly clock: Clock;
}): ReactNode {
  const { projects, clock } = props;
  if (projects.state.status === "reading") {
    return <LoadingNotice clock={clock} placement="inline" title="Loading…" />;
  }
  if (projects.state.status === "failed") {
    return (
      <InlineRefusal
        code={PROJECT_LIST_UNREAD_CODE}
        detail="Couldn't load projects"
        onTryAgain={projects.readAgain}
      />
    );
  }
  return null;
}

/** The projects attached to this computer, none until the list is served; archived ones are not. */
export function attachedProjectsOf(state: ProjectListState): readonly ProjectListEntry[] {
  return state.status === "served"
    ? state.projects.filter((project) => project.state === "active")
    : [];
}
