// `On for runs` on a server whose switch applies one project at a time: one switch per attached
// project, each read from the projects the service names it switched off in, and each press
// naming its own project.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  McpServerBindingId,
  McpServerInventoryEntry,
} from "@ai-sidekicks/contracts/mcp/server";
import type { DistroName } from "@ai-sidekicks/contracts/place";
import type { ProjectId, ProjectListEntry } from "@ai-sidekicks/contracts/project";
import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import { ManualClock } from "#renderer/lib/clock.js";
import { ServedProviderSections } from "#renderer/store/providers/ServedProviderSections.test-support.js";
import { IDLE_MCP_MUTATION } from "../mutation.js";
import { ProjectSwitches } from "./ProjectSwitches.js";

afterEach(() => {
  cleanup();
});

/** One project on the service's list, attached unless `state` says otherwise. */
function project(
  overrides: Partial<ProjectListEntry> & Pick<ProjectListEntry, "name">,
): ProjectListEntry {
  return {
    projectId: `project-${overrides.name}` as ProjectId,
    repoMountId: null,
    folderPath: `/work/${overrides.name}`,
    state: "active",
    sessionCount: 0,
    runningSessionId: null,
    sessionTally: { running: 0, waiting: 0, done: 0 },
    setup: { filesToCopy: [], commands: [] },
    environmentRows: [],
    branchPattern: null,
    ...overrides,
  };
}

const ATLAS = project({ name: "atlas" });
// The same root in a WSL distribution is a different project.
const BEACON = project({
  name: "beacon",
  folderPath: "/work/atlas",
  place: { distro: "Ubuntu" as DistroName },
});
const ARCHIVED = project({ name: "old", state: "archived" });

// A claude.ai connector switched off in the Ubuntu copy alone.
const CONNECTOR: McpServerInventoryEntry = {
  provider: "claude" as ProviderId,
  scope: "connector",
  scopeRef: "account-work" as ProviderAccountId,
  serverName: "linear",
  serverBindingId: "binding-linear" as McpServerBindingId,
  config: { transport: "http", url: "https://mcp.linear.example/" },
  status: "connected",
  disabledIn: [{ path: "/work/atlas", place: { distro: "Ubuntu" as DistroName } }],
  enabled: true,
  tools: [],
};

describe("ProjectSwitches", () => {
  it("draws one switch per attached project, each read and pressed for its own project", () => {
    const onSetEnabledIn = vi.fn();
    const { container } = render(
      <ProjectSwitches
        entry={CONNECTOR}
        projects={{
          state: { status: "served", projects: [ATLAS, BEACON, ARCHIVED], droppedCount: 0 },
          readAgain: () => undefined,
        }}
        outcomeFor={() => IDLE_MCP_MUTATION}
        onSetEnabledIn={onSetEnabledIn}
        sessionDirectory={{ status: "reading" }}
        clock={new ManualClock(0)}
      />,
      { wrapper: ServedProviderSections },
    );
    const switches = [...container.querySelectorAll(".meridian-switch__label")].map((label) => ({
      name: label.textContent,
      control: label.querySelector('[role="switch"]'),
    }));
    expect(
      switches.map(({ name, control }) => [name, control?.getAttribute("aria-checked")]),
    ).toStrictEqual([
      ["atlas", "true"],
      ["beacon", "false"],
    ]);
    for (const { control } of switches) {
      if (!(control instanceof HTMLElement)) {
        throw new Error("a project's switch drew no control to press");
      }
      fireEvent.click(control);
    }
    // Each press asks for its own project's opposite position, and never another project's.
    expect(onSetEnabledIn).toHaveBeenCalledWith(ATLAS, false);
    expect(onSetEnabledIn).toHaveBeenCalledWith(BEACON, true);
    expect(onSetEnabledIn).not.toHaveBeenCalledWith(ATLAS, true);
    expect(onSetEnabledIn).not.toHaveBeenCalledWith(BEACON, false);
  });
});
