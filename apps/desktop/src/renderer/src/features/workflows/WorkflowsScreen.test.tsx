// The destination draws the runs it is handed and opens the one a person presses.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
import type { ConsolePaneAddress } from "@renderer/console/seats/index.js";
import type { WorkflowRunDirectoryState } from "./runs/hooks/useWorkflowRunDirectory.js";
import { PROBE_RUNS, settle } from "./workflows-probe.test-support.js";
import { WorkflowsDestination } from "./WorkflowsScreen.js";

/** The probe runs as an enumeration serves them. */
const SERVED_DIRECTORY: WorkflowRunDirectoryState = {
  status: "served",
  runs: PROBE_RUNS.map((run) => ({ ...run, definitionName: "Ship pipeline" })),
};

function renderDestination(directoryProps: { readonly directory?: WorkflowRunDirectoryState }): {
  readonly container: HTMLElement;
  /** Every address this surface asked for a pane at, in the order it asked. */
  readonly openedAddresses: readonly ConsolePaneAddress[];
} {
  // A recording opener rather than a real host: what this surface owes is the exact
  // address per act, and where an opened pane lands is the mounting surface's answer
  // and not this one's.
  const openedAddresses: ConsolePaneAddress[] = [];
  const { container } = render(
    <LiveAnnouncerProvider>
      <WorkflowsDestination
        {...directoryProps}
        openPane={(address) => {
          openedAddresses.push(address);
        }}
      />
    </LiveAnnouncerProvider>,
  );
  return { container, openedAddresses };
}

describe("the workflows destination — the runs it draws", () => {
  it("lists the runs of the directory it is handed", async () => {
    const { container } = renderDestination({ directory: SERVED_DIRECTORY });
    await settle();

    expect(container.querySelector(".meridian-workflows-runs")).not.toBeNull();
    expect(container.querySelectorAll(".meridian-run-row")).toHaveLength(4);
  });

  it("draws its frame and no runs section when the mount supplies no directory", async () => {
    const { container } = renderDestination({});
    await settle();

    expect(container.querySelector(".meridian-workflows-destination")).not.toBeNull();
    expect(container.querySelector(".meridian-workflows-runs")).toBeNull();
    expect(container.querySelector(".meridian-run-list")).toBeNull();
  });
});

describe("the workflows destination — what its list opens", () => {
  it("opens the run pane on the run a person pressed", async () => {
    // The first row is the newest run, the one running now.
    const { container, openedAddresses } = renderDestination({ directory: SERVED_DIRECTORY });
    await settle();
    const name = container.querySelector(".meridian-run-row__open");
    const newestRun = PROBE_RUNS.find((candidate) => candidate.state === "running");
    if (!(name instanceof HTMLElement) || newestRun === undefined) {
      throw new Error("no run name was pressable");
    }

    fireEvent.click(name);

    expect(openedAddresses).toStrictEqual([
      {
        kind: "workflow-run",
        entity: { kind: "workflow-run", id: newestRun.workflowRunId },
      },
    ]);
  });

  it("negative control: nothing is opened until something is pressed", async () => {
    // Without this the case above would pass over a surface that opened a pane on
    // mount, which is a different defect wearing the same assertions.
    const { openedAddresses } = renderDestination({ directory: SERVED_DIRECTORY });
    await settle();

    expect(openedAddresses).toStrictEqual([]);
  });
});
