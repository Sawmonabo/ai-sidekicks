import type { ReactNode } from "react";

import type { McpServerInventoryEntry } from "@ai-sidekicks/contracts/mcp/server";
import type { ProjectListEntry } from "@ai-sidekicks/contracts/project";
import { Switch } from "#renderer/components/Switch/Switch.js";
import type { Clock } from "#renderer/lib/clock.js";
import type { ProjectListState } from "#renderer/store/projects/list.js";
import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import type { McpMutationOutcome } from "../mutation.js";
import { MutationOutcomeLine } from "./MutationOutcomeLine.js";

/**
 * `On for runs` once per project attached to this computer, each named for its project and on
 * unless the service names that project among those the server is switched off in. None is drawn
 * until the project list is served.
 */
export function ProjectSwitches(props: {
  readonly entry: McpServerInventoryEntry;
  readonly projects: ProjectListState;
  readonly outcomeFor: (project: ProjectListEntry) => McpMutationOutcome;
  readonly onSetEnabledIn: (project: ProjectListEntry, enabled: boolean) => void;
  readonly sessionDirectory: SessionDirectoryState;
  readonly clock: Clock;
}): ReactNode {
  const { entry, projects, outcomeFor, onSetEnabledIn, sessionDirectory, clock } = props;
  const attached =
    projects.status === "served"
      ? projects.projects.filter((project) => project.state === "active")
      : [];
  return (
    <div className="meridian-mcp__detail-block">
      <h4 className="meridian-settings-page__section-head">On for runs</h4>
      {attached.map((project) => (
        <div key={project.projectId}>
          <Switch
            label={project.name}
            checked={!isSwitchedOffIn(entry, project)}
            disabled={outcomeFor(project).kind === "sending"}
            onCheckedChange={(checked) => {
              onSetEnabledIn(project, checked);
            }}
          />
          <MutationOutcomeLine
            outcome={outcomeFor(project)}
            sessionDirectory={sessionDirectory}
            clock={clock}
          />
        </div>
      ))}
    </div>
  );
}

/** Whether the server is switched off in `project`'s root, in that project's distribution. */
function isSwitchedOffIn(entry: McpServerInventoryEntry, project: ProjectListEntry): boolean {
  const projectDistro = typeof project.place === "object" ? project.place.distro : undefined;
  return (entry.disabledIn ?? []).some(
    (origin) =>
      "path" in origin &&
      origin.path === project.folderPath &&
      origin.place?.distro === projectDistro,
  );
}
