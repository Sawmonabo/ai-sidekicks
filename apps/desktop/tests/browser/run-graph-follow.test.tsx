// The run graph follows the live step until a person moves the view, and only the `now` chip
// brings the follow back. This needs real geometry: the follow places the view only once the
// canvas has a measured size, which a DOM shim reports as zero.
//
// Reduced motion is emulated so every placement is a jump rather than a slide: a view that
// still followed would have moved by the time the update settles, with no clock to wait on.

import { useState } from "react";
import { cdp } from "vitest/browser";
import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/run";

import { crossMacrotaskBoundary } from "../helpers/macrotask-boundary.js";
import { renderSettled } from "../helpers/app/harness.js";
import { awaitRunGraphSettled } from "../helpers/run-graph-settled.js";
import {
  WORKFLOW_DEFINITION_RECORDS,
  WORKFLOW_FIXTURE_NOW_MS,
  WORKFLOW_RUN_IDS,
  WORKFLOW_RUN_RECORDS,
} from "@fixtures/data/workflow/runs.js";
import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { RunGraphCanvas } from "@renderer/features/workflows/run-page/run-graph/RunGraphCanvas.js";

/** The chip's accessible name, the one control that starts the follow again. */
const NOW_CHIP_NAME = "Follow the live step now";

const RUNNING_RUN = WORKFLOW_RUN_RECORDS.find(
  (record) => record.read.workflowRunId === WORKFLOW_RUN_IDS.running,
)?.read;
const RUNNING_DOCUMENT = WORKFLOW_DEFINITION_RECORDS.flatMap((record) => record.versions).find(
  (version) => version.versionId === RUNNING_RUN?.workflowVersionId,
)?.document;

/** The running run one step on: its live step finished and the next node running. */
function stepsOneOn(steps: readonly WorkflowStep[]): WorkflowStep[] {
  const live = steps.find((step) => step.status === "running");
  const nextNode = RUNNING_DOCUMENT?.edges.find((edge) => edge.source === live?.nodeId)?.target;
  if (live === undefined || nextNode === undefined) {
    throw new Error("the running fixture has no live step with a node after it");
  }
  const finished = { ...live, status: "succeeded" as const, finishedAt: live.startedAt };
  const next: WorkflowStep = {
    ...live,
    nodeId: nextNode,
    executionIndex: live.executionIndex + 1,
    source: [{ nodeId: live.nodeId, outputIndex: 0, executionIndex: live.executionIndex }],
  };
  return [...steps.filter((step) => step !== live), finished, next];
}

/** Mounts the running run's graph and hands back how to move the run on. */
async function mountRunningGraph(): Promise<{
  readonly container: HTMLElement;
  readonly moveRunOn: () => Promise<void>;
}> {
  if (RUNNING_RUN === undefined || RUNNING_DOCUMENT === undefined) {
    throw new Error("the fixture's running run or its document is missing");
  }
  const run = RUNNING_RUN;
  const document = RUNNING_DOCUMENT;
  let setSteps: (steps: WorkflowStep[]) => void = () => undefined;
  function RunningGraph(): React.JSX.Element {
    const [steps, setStepsState] = useState<WorkflowStep[]>(run.steps);
    setSteps = setStepsState;
    return (
      <div className="meridian-run-graph">
        <RunGraphCanvas
          document={document}
          steps={steps}
          edgeItemCounts={run.edgeItemCounts}
          selectedNodeId={undefined}
          nowMs={WORKFLOW_FIXTURE_NOW_MS}
          onSelectNode={() => undefined}
        />
      </div>
    );
  }
  installMeridianTokens(window.document);
  const { container } = await renderSettled(<RunningGraph />);
  await awaitRunGraphSettled(container);
  return {
    container,
    moveRunOn: async () => {
      await act(async () => {
        setSteps(stepsOneOn(run.steps));
        await crossMacrotaskBoundary();
      });
    },
  };
}

function viewportTransform(container: HTMLElement): string {
  const viewport = container.querySelector<HTMLElement>(".react-flow__viewport");
  if (viewport === null) {
    throw new Error("the graph drew no viewport");
  }
  return viewport.style.transform;
}

function nowChip(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${NOW_CHIP_NAME}"]`);
}

/** A person's scroll on the canvas, near its top-left corner, away from the live step. */
async function scrollOnCanvas(container: HTMLElement): Promise<void> {
  const pane = container.querySelector<HTMLElement>(".react-flow__pane");
  if (pane === null) {
    throw new Error("the graph drew no pane to scroll on");
  }
  const box = pane.getBoundingClientRect();
  await act(async () => {
    pane.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: box.left + box.width / 8,
        clientY: box.top + box.height / 8,
        deltaY: 240,
      }),
    );
    await crossMacrotaskBoundary();
  });
}

afterEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

describe("browser — the run graph's follow of the live step", () => {
  it("stops on a scroll, holds as the run moves on, and the now chip restarts it", async () => {
    await cdp().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    const { container, moveRunOn } = await mountRunningGraph();
    expect(nowChip(container), "the chip stood while the view was on the live step").toBeNull();

    await scrollOnCanvas(container);
    await waitFor(() => {
      expect(nowChip(container), "a scroll did not stop the follow").not.toBeNull();
    });
    const scrolledTransform = viewportTransform(container);

    await moveRunOn();
    expect(viewportTransform(container), "the view followed the run after a person moved it").toBe(
      scrolledTransform,
    );
    expect(nowChip(container)).not.toBeNull();

    await act(async () => {
      nowChip(container)?.click();
      await crossMacrotaskBoundary();
    });
    await waitFor(() => {
      expect(nowChip(container), "the chip stood after it brought the view back").toBeNull();
    });
    expect(viewportTransform(container)).not.toBe(scrolledTransform);
  });
});
