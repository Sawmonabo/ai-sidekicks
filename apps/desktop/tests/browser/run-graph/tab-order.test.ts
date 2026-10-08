// Tab walks a run graph in its own order: each node, then the counts of the edges leaving it, a
// count showing its whole figure as it is reached. The library draws every edge before every node,
// so the browser's own order would reach every count first. The walk hands Tab back to the browser
// at both ends, so the graph is never a trap, and Shift+Tab coming back in reaches the canvas's own
// controls, then starts the walk at its last stop rather than skipping the counts that leave the
// last node. Tabbing out past an end does not move the view. This needs real focus and layout, so
// it runs in Chromium.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { userEvent } from "vitest/browser";

import { clearMediaEmulation, emulateReducedMotion } from "../../helpers/media-emulation.js";
import { WindowHoverLabel } from "#renderer/components/HoverLabel/WindowHoverLabel.js";
import { EDGE_COUNT_CLASS } from "#renderer/features/workflows/runs/page/graph/elements.js";
import { WORKFLOW_RUN_IDS } from "#fixtures/data/workflow/run/records.js";
import { fixtureRun, mountRunGraph, type FixtureRun } from "./mount.js";

afterEach(async () => {
  cleanup();
  await clearMediaEmulation();
});

/** Every edge's item count, which the hover label reads as `123,456,789,012 items`. */
const WHOLE_COUNT = 123_456_789_012;

/** `fixture`'s graph between two buttons, so focus has somewhere to go on either side. */
async function mountBetweenButtons(fixture: FixtureRun): Promise<{
  readonly canvas: HTMLElement;
  readonly before: HTMLElement;
  readonly after: HTMLElement;
}> {
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
  return { canvas: container, before, after };
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
  const { canvas, before, after } = await mountBetweenButtons(reversed);
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

  // From past the canvas, Shift+Tab reaches the canvas's own controls first, then the walk's last
  // stop.
  act(() => {
    after.focus();
  });
  await pressTab(true);
  expect(isGraphStop(document.activeElement)).toBe(false);
  expect(document.activeElement).not.toBe(after);
  expect(document.activeElement).not.toBe(document.body);
  await pressTab(true);
  expect(document.activeElement).toBe(lastStop);
});

it("moves no view as Tab passes over the end node on its way out of the graph", async () => {
  // Reduced motion, so a move would be a jump the next read sees. The running run opens at full
  // size on its live step, and narrowed to a sliver it stays on that step at full size, which
  // leaves most nodes outside the canvas. Its nodes reversed, so the last node in the library's
  // order is one that edges leave, and Tab from its last count hands focus to that node on the
  // way out.
  await emulateReducedMotion();
  const fixture = fixtureRun(WORKFLOW_RUN_IDS.running);
  const reversed: FixtureRun = {
    ...fixture,
    workflowDocument: {
      ...fixture.workflowDocument,
      nodes: [...fixture.workflowDocument.nodes].reverse(),
    },
  };
  const { canvas } = await mountBetweenButtons(reversed);
  const openedTransform = viewportTransform(canvas);
  act(() => {
    canvas.style.inlineSize = "96px";
  });
  // The follow centers the live step again at the new width, so the library has seen the resize.
  await waitFor(() => {
    expect(viewportTransform(canvas)).not.toBe(openedTransform);
  });
  const lastNode = [...canvas.querySelectorAll<HTMLElement>(".react-flow__node")].at(-1);
  const pane = canvas.querySelector<HTMLElement>(".react-flow");
  const lastLeaving = reversed.workflowDocument.edges.filter(
    (edge) => edge.source === lastNode?.dataset["id"],
  );
  if (lastNode === undefined || pane === null || lastLeaving.length === 0) {
    throw new Error("the reversed fixture's last node has no edge leaving it");
  }
  const lastStop = await waitFor(() => {
    const count = countOf(canvas, lastLeaving.at(-1)!.id);
    expect(count).toBeInstanceOf(SVGElement);
    return count as SVGElement;
  });

  // Focus put on the last count from code reveals the count; the Tab out is measured from there.
  act(() => {
    lastStop.focus();
  });
  const paneBox = pane.getBoundingClientRect();
  const nodeBox = lastNode.getBoundingClientRect();
  const nodeCenterX = nodeBox.left + nodeBox.width / 2;
  const nodeCenterY = nodeBox.top + nodeBox.height / 2;
  expect(
    nodeCenterX < paneBox.left ||
      nodeCenterX > paneBox.right ||
      nodeCenterY < paneBox.top ||
      nodeCenterY > paneBox.bottom,
    "the last node stands outside the canvas as Tab leaves its count",
  ).toBe(true);
  const transform = viewportTransform(canvas);
  await pressTab();
  expect(isGraphStop(document.activeElement)).toBe(false);
  expect(viewportTransform(canvas)).toBe(transform);
});

it("brings a count reached by Tab into the canvas", async () => {
  // Reduced motion, so the pan is a jump the next read sees. Narrowed to a sliver, the canvas
  // shows a node but not the count on the edge leaving it.
  await emulateReducedMotion();
  const fixture = fixtureRun(WORKFLOW_RUN_IDS.running);
  const { canvas } = await mountBetweenButtons(fixture);
  const openedTransform = viewportTransform(canvas);
  act(() => {
    canvas.style.inlineSize = "96px";
  });
  await waitFor(() => {
    expect(viewportTransform(canvas)).not.toBe(openedTransform);
  });
  const pane = canvas.querySelector<HTMLElement>(".react-flow");
  const firstNode = canvas.querySelector<HTMLElement>(".react-flow__node");
  const leaving = fixture.workflowDocument.edges.find(
    (edge) => edge.source === firstNode?.dataset["id"],
  );
  if (pane === null || firstNode === null || leaving === undefined) {
    throw new Error("the running fixture's first node has no edge leaving it");
  }
  const count = await waitFor(() => {
    const drawn = countOf(canvas, leaving.id);
    expect(drawn).toBeInstanceOf(SVGElement);
    return drawn as SVGElement;
  });

  act(() => {
    firstNode.focus();
  });
  expect(isInside(count, pane), "the count starts outside the canvas").toBe(false);
  await pressTab();
  expect(document.activeElement).toBe(count);
  await waitFor(() => {
    expect(pane.scrollLeft + pane.scrollTop).toBe(0);
    expect(isInside(count, pane)).toBe(true);
  });
});

// Whether `element`'s center lies inside `box`'s box.
function isInside(element: Element, box: Element): boolean {
  const { left, top, width, height } = element.getBoundingClientRect();
  const bounds = box.getBoundingClientRect();
  const x = left + width / 2;
  const y = top + height / 2;
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

function viewportTransform(canvas: HTMLElement): string {
  return canvas.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";
}
