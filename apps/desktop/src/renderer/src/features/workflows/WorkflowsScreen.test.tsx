// Pressing a run in the list opens the pane that run names. The pane registry is real, built
// per case with the feature's own bodies, because the screen resolves from the registry on its
// screen context.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import type { WorkflowRunDirectoryState } from "./runs/hooks/useWorkflowRunDirectory.js";
import { PROBE_RUNS } from "./workflows-probe.test-support.js";
import { settle } from "@test/helpers/settle.js";
import {
  SERVED_DIRECTORY,
  composeWindow,
  pressOpenRun,
  probeRunPane,
} from "./WorkflowsScreen.test-support.js";
import { WorkflowsScreen } from "./WorkflowsScreen.js";

/**
 * Mount the screen over a composition whose run body records the pane context it is opened
 * with, which carries the address the screen composed.
 */
function renderDestination(directoryProps: { readonly directory?: WorkflowRunDirectoryState }): {
  readonly container: HTMLElement;
  /** Every pane context this screen opened, in the order it opened them. */
  readonly openedContexts: readonly PaneContext[];
} {
  const composed = composeWindow();
  const openedContexts = probeRunPane(composed.paneRegistry);
  const { container } = render(
    <LiveAnnouncerProvider>
      <WorkflowsScreen context={composed.context} {...directoryProps} />
    </LiveAnnouncerProvider>,
  );
  return { container, openedContexts };
}

describe("the workflows screen — what its list opens", () => {
  it("opens the run pane on the run a person pressed", async () => {
    // The first row is the newest run, the one running now.
    const { container, openedContexts } = renderDestination({ directory: SERVED_DIRECTORY });
    await settle();
    const newestRun = PROBE_RUNS.find((candidate) => candidate.state === "running");
    if (newestRun === undefined) {
      throw new Error("no run is running");
    }

    pressOpenRun(container);
    await settle();

    expect(openedContexts).toHaveLength(1);
    expect(openedContexts[0]).toMatchObject({
      kind: "workflow-run",
      entity: { kind: "workflow-run", id: newestRun.workflowRunId },
    });
  });
});
