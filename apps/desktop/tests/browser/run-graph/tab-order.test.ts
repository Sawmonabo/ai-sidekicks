// Tab walks a run graph in its own order: each node, then the counts of the edges leaving it, a
// count showing its whole figure as it is reached. The library draws every edge before every node,
// so the browser's own order would reach every count first. The walk hands Tab back to the browser
// at both ends, so the graph is never a trap, and Shift+Tab coming back in starts at the walk's
// last stop rather than skipping the counts that leave the last node. This needs real focus and
// layout, so it runs in Chromium.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { userEvent } from "vitest/browser";

import { WindowHoverLabel } from "#renderer/components/HoverLabel/WindowHoverLabel.js";
import { EDGE_COUNT_CLASS } from "#renderer/features/workflows/runs/page/graph/elements.js";
import { WORKFLOW_RUN_IDS } from "#fixtures/data/workflow/run/records.js";
import { fixtureRun, mountRunGraph, type FixtureRun } from "./mount.js";

afterEach(() => {
  cleanup();
});

/** Every count the graph draws, as the hover label reads it. */
const WHOLE_COUNT = 123_456_789_012;

/** `fixture`'s graph between two buttons, so focus has somewhere to go on either side. */
async function mountBetweenButtons(
  fixture: FixtureRun,
): Promise<{ readonly canvas: HTMLElement; readonly before: HTMLElement }> {
  const counts = fixture.workflowDocument.edges.map((edge) => ({
    edgeId: edge.id,
    itemCount: WHOLE_COUNT,
  }));
  const { container } = await mountRunGraph(fixture, counts);
  render(createElement(WindowHoverLabel));
  const before = document.createElement("button");
  const after = document.createElement("button");
  container.before(before);
  container.after(after);
  onTestFinished(() => {
    before.remove();
    after.remove();
  });
  return { canvas: container, before };
}

async function pressTab(isBackward = false): Promise<void> {
  await act(async () => {
    await userEvent.tab({ shift: isBackward });
  });
}

function countOf(canvas: HTMLElement, edgeId: string): Element | null {
  return canvas.querySelector(`.react-flow__edge[data-id="${edgeId}"] .${EDGE_COUNT_CLASS}`);
}

function isGraphStop(element: Element | null): boolean {
  return (
    element?.closest(".react-flow__node") != null ||
    element?.classList.contains(EDGE_COUNT_CLASS) === true
  );
}

it("reaches a count after the node its edge leaves, which shows its whole count", async () => {
  const fixture = fixtureRun(WORKFLOW_RUN_IDS.waitingApproval);
  const { canvas, before } = await mountBetweenButtons(fixture);
  const firstNode = canvas.querySelector<HTMLElement>(".react-flow__node");
  const leaving = fixture.workflowDocument.edges.find(
    (edge) => edge.source === firstNode?.dataset["id"],
  );
  if (firstNode === null || leaving === undefined) {
    throw new Error("the fixture's first node has no edge leaving it");
  }
  const leavingCount = await waitFor(() => {
    const count = countOf(canvas, leaving.id);
    expect(count).not.toBeNull();
    return count!;
  });

  act(() => {
    before.focus();
  });
  await pressTab();
  expect(document.activeElement).toBe(firstNode);
  await pressTab();
  expect(document.activeElement).toBe(leavingCount);
  await waitFor(() => {
    expect(document.querySelector(".meridian-hover-label")?.textContent).toBe(
      "123,456,789,012 items",
    );
  });
  await pressTab(true);
  expect(document.activeElement).toBe(firstNode);
  // Before its first node the walk lets the browser carry focus out of the graph.
  await pressTab(true);
  expect(document.activeElement).toBe(before);
});

it("hands Tab on past its last stop, and Shift+Tab back in starts at that stop", async () => {
  // The nodes reversed, so the last node in the library's order is the one edges leave.
  const fixture = fixtureRun(WORKFLOW_RUN_IDS.waitingApproval);
  const reversed: FixtureRun = {
    ...fixture,
    workflowDocument: {
      ...fixture.workflowDocument,
      nodes: [...fixture.workflowDocument.nodes].reverse(),
    },
  };
  const { canvas, before } = await mountBetweenButtons(reversed);
  const nodes = [...canvas.querySelectorAll<HTMLElement>(".react-flow__node")];
  const lastLeaving = reversed.workflowDocument.edges.filter(
    (edge) => edge.source === nodes.at(-1)?.dataset["id"],
  );
  if (lastLeaving.length === 0) {
    throw new Error("no edge leaves the reversed fixture's last node");
  }
  const lastStop = await waitFor(() => {
    const count = countOf(canvas, lastLeaving.at(-1)!.id);
    expect(count).not.toBeNull();
    return count!;
  });

  act(() => {
    before.focus();
  });
  let stops = 0;
  while (document.activeElement !== lastStop && stops < 64) {
    await pressTab();
    stops += 1;
  }
  expect(document.activeElement).toBe(lastStop);
  await pressTab();
  const pastGraph = document.activeElement;
  expect(isGraphStop(pastGraph)).toBe(false);
  expect(pastGraph).not.toBe(document.body);

  await pressTab(true);
  expect(document.activeElement).toBe(lastStop);
});
