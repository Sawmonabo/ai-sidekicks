// The run graph follows the live step until a person moves the view or puts keyboard focus on
// the graph, and only the `now` chip brings the follow back. This needs real geometry: the follow
// places the view only once the canvas has a measured size, which a DOM shim reports as zero.
//
// Reduced motion is emulated so every placement is a jump rather than a slide: a view that
// still followed would have moved by the time the update settles, with no clock to wait on.

import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import type { WorkflowStep } from "@ai-sidekicks/contracts/workflow/run/step/record";

import { crossMacrotaskBoundary } from "../../helpers/macrotask-boundary.js";
import { clearMediaEmulation, emulateReducedMotion } from "../../helpers/media-emulation.js";
import { WORKFLOW_RUN_IDS } from "#fixtures/data/workflow/run/records.js";
import { withoutWait } from "#fixtures/data/workflow/run/writes.js";
import { fixtureRun, mountRunGraph } from "./mount.js";

/** The chip's accessible name, the one control that starts the follow again. */
const NOW_CHIP_NAME = "Follow the live step now";

const RUNNING = fixtureRun(WORKFLOW_RUN_IDS.running);

/** The running run one step on: its live step finished and the next node running. */
function stepsOneOn(steps: readonly WorkflowStep[]): WorkflowStep[] {
  const live = steps.find((step) => step.status === "running");
  const nextNode = RUNNING.workflowDocument.edges.find(
    (edge) => edge.source === live?.nodeId,
  )?.target;
  if (live === undefined || nextNode === undefined) {
    throw new Error("the running fixture has no live step with a node after it");
  }
  const finished: WorkflowStep = {
    ...withoutWait(live, "succeeded"),
    finishedAt: live.startedAt,
  };
  const next: WorkflowStep = {
    ...withoutWait(live, "running"),
    nodeId: nextNode,
    executionIndex: live.executionIndex + 1,
    source: [{ nodeId: live.nodeId, outputIndex: 0, executionIndex: live.executionIndex }],
  };
  return [...steps.filter((step) => step !== live), finished, next];
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
  await clearMediaEmulation();
});

describe("browser — the run graph's follow of the live step", () => {
  // The negative control for the hold below: with nobody scrolling, the same move of the run has
  // moved the view by the time it settles, so a held view there proves the scroll stopped it.
  it("moves the view to the next live step when nobody has moved it", async () => {
    await emulateReducedMotion();
    const { container, showSteps } = await mountRunGraph(RUNNING);
    const followedTransform = viewportTransform(container);

    await showSteps(stepsOneOn(RUNNING.run.steps));
    expect(viewportTransform(container), "the view stayed as the run moved on").not.toBe(
      followedTransform,
    );
    expect(nowChip(container), "the chip stood while the view followed").toBeNull();
  });

  it("stops on a scroll, holds as the run moves on, and the now chip restarts it", async () => {
    await emulateReducedMotion();
    const { container, showSteps } = await mountRunGraph(RUNNING);
    expect(nowChip(container), "the chip stood while the view was on the live step").toBeNull();

    await scrollOnCanvas(container);
    await waitFor(() => {
      expect(nowChip(container), "a scroll did not stop the follow").not.toBeNull();
    });
    const scrolledTransform = viewportTransform(container);

    await showSteps(stepsOneOn(RUNNING.run.steps));
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

  it("stops when keyboard focus lands on a node, not on the canvas's link, and holds", async () => {
    await emulateReducedMotion();
    const { container, showSteps } = await mountRunGraph(RUNNING);
    const link = container.querySelector<HTMLElement>(".react-flow__attribution a");
    if (link === null) {
      throw new Error("the graph drew no attribution link");
    }
    // A key first, away from the canvas, so focus put from code is keyboard focus and no key
    // reaches the canvas, as Tab from before the canvas lands.
    await act(async () => {
      await userEvent.keyboard("{Shift}");
    });
    act(() => {
      link.focus();
    });
    const linkTransform = viewportTransform(container);
    await showSteps(stepsOneOn(RUNNING.run.steps));
    expect(viewportTransform(container), "focus on the link stopped the follow").not.toBe(
      linkTransform,
    );

    // A second graph, its run not yet moved on, for focus on a node.
    const second = await mountRunGraph(RUNNING);
    const secondNode = second.container.querySelector<HTMLElement>(".react-flow__node");
    if (secondNode === null) {
      throw new Error("the second graph drew no node");
    }
    act(() => {
      secondNode.focus();
    });
    const focusedTransform = viewportTransform(second.container);
    await second.showSteps(stepsOneOn(RUNNING.run.steps));
    expect(
      viewportTransform(second.container),
      "the view followed the run off the focused node",
    ).toBe(focusedTransform);
  });
});
