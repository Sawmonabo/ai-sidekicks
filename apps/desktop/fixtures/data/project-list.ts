// The frame the machine's `project.subscribe` opens with: the projects attached to this computer,
// so the MCP page draws a switch for each. Two are active and share one root, the second in a WSL
// distribution, so each switch is told apart by its root and its distribution; the third is
// archived.

import type { DistroName } from "@ai-sidekicks/contracts/place";
import type {
  ProjectId,
  ProjectList,
  ProjectListEntry,
  ProjectState,
} from "@ai-sidekicks/contracts/project";

import type { ScenarioOpeningNotice } from "#renderer/services/daemon/scenario/reply.fixture.js";

/** The project list a scenario's `project.subscribe` opens with. */
export const PROJECT_LIST_OPENING_NOTICES: readonly ScenarioOpeningNotice[] = [
  {
    stream: "project.subscribe",
    payloadAtOpen: (): ProjectList => ({
      projects: [
        attachedProject("019b79ee-0280-7c01-8510-ada11a5a2401", "atlas", "/work/atlas", "active"),
        {
          ...attachedProject(
            "019b79ee-0280-7c01-8510-ada11a5a2402",
            "atlas on Ubuntu",
            "/work/atlas",
            "active",
          ),
          place: { distro: "Ubuntu" as DistroName },
        },
        attachedProject(
          "019b79ee-0280-7c01-8510-ada11a5a2403",
          "beacon",
          "/work/beacon",
          "archived",
        ),
      ],
    }),
  },
];

/** One attached project with no sessions, setup or environment of its own. */
function attachedProject(
  projectId: string,
  name: string,
  folderPath: string,
  state: ProjectState,
): ProjectListEntry {
  return {
    projectId: projectId as ProjectId,
    repoMountId: null,
    name,
    folderPath,
    state,
    sessionCount: 0,
    runningSessionId: null,
    sessionTally: { running: 0, waiting: 0, done: 0 },
    setup: { filesToCopy: [], commands: [] },
    environmentRows: [],
    branchPattern: null,
  };
}
