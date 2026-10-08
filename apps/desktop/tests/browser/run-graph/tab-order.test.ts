// Tab walks a run graph in its own order: each node, then the counts of the edges leaving it, a
// count showing its whole figure as it is reached. The library draws every edge before every node,
// so the browser's own order would reach every count first. The walk hands Tab back to the browser
// at both ends, so the graph is never a trap, and Shift+Tab coming back in reaches the canvas's own
// controls, then starts the walk at its last stop rather than skipping the counts that leave the
// last node, while focus code hands back to that node stays there. Tabbing out past an end moves
// neither the view nor the page, and a count Tab reaches is centered in the canvas, even while the
// view is still sliding, and judged against the view a person's zoom left rather than a slide that
// zoom cut off. This needs real focus and layout, so it runs in Chromium.

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { userEvent } from "vitest/browser";

import { nextFrame } from "../../helpers/animation-frame.js";
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

/**
 * How long a slide may take to land before the wait gives up: a ceiling, not a wait. A slide runs
 * a fraction of a second, but a loaded host draws its frames late.
 */
const SLIDE_LANDING_TIMEOUT_MS = 5000;

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
  render(createElement(WindowHoverLabel));
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

  // Focus that code hands back to the last node, as a closing panel does after a key, stays on it.
  const lastNode = nodes.at(-1)!;
  act(() => {
    after.focus();
  });
  await act(async () => {
    await userEvent.keyboard("{Shift}");
  });
  act(() => {
    lastNode.focus();
  });
  expect(document.activeElement).toBe(lastNode);
});

it("moves neither the view nor the page as Tab passes over the end node on its way out", async () => {
  // Reduced motion, so a move would be a jump the next read sees. Its nodes reversed, so the last
  // node in the library's order is one that edges leave, and Tab from its last count hands focus
  // to that node on the way out.
  await emulateReducedMotion();
  const fixture = fixtureRun(WORKFLOW_RUN_IDS.running);
  const reversed: FixtureRun = {
    ...fixture,
    workflowDocument: {
      ...fixture.workflowDocument,
      nodes: [...fixture.workflowDocument.nodes].reverse(),
    },
  };
  const { canvas, pane } = await mountNarrowed(reversed);
  // Taller than the window, so the row the walk ends on stands below it once the page is at its
  // top, where Tab lands on the canvas's own controls.
  const shortTransform = viewportTransform(canvas);
  act(() => {
    canvas
      .querySelector<HTMLElement>(".meridian-run-graph")
      ?.style.setProperty("--meridian-run-graph-canvas-block-size", "300vh");
  });
  await waitFor(() => {
    expect(viewportTransform(canvas)).not.toBe(shortTransform);
  });
  onTestFinished(() => {
    window.scrollTo(0, 0);
  });
  const lastNode = [...canvas.querySelectorAll<HTMLElement>(".react-flow__node")].at(-1);
  if (lastNode === undefined) {
    throw new Error("the reversed fixture drew no node");
  }
  const lastStop = await lastCountLeaving(canvas, reversed, lastNode);

  // A key first, so focus put on the last count from code is keyboard focus and reveals the count;
  // the Tab out is measured from there.
  await act(async () => {
    await userEvent.keyboard("{Shift}");
  });
  act(() => {
    lastStop.focus();
  });
  await waitFor(() => {
    expect(pane.scrollLeft + pane.scrollTop).toBe(0);
    expect(isInside(lastStop, pane)).toBe(true);
  });
  expect(
    isInside(lastNode, pane),
    "the last node stands outside the canvas as Tab leaves its count",
  ).toBe(false);
  // The page back at its top, the last node below the window: focus on that node would scroll the
  // page down to it.
  window.scrollTo(0, 0);
  // That scroll is announced on the next frame, so two pass before the page's scrolls are counted.
  await nextFrame();
  await nextFrame();
  expect(
    lastNode.getBoundingClientRect().top,
    "the last node stands in the window as Tab leaves its count",
  ).toBeGreaterThan(window.innerHeight);
  let pageScrolls = 0;
  const countPageScroll = (): void => {
    pageScrolls += 1;
  };
  window.addEventListener("scroll", countPageScroll);
  onTestFinished(() => {
    window.removeEventListener("scroll", countPageScroll);
  });
  const transform = viewportTransform(canvas);
  await pressTab();
  await nextFrame();
  await nextFrame();
  expect(isGraphStop(document.activeElement)).toBe(false);
  expect(viewportTransform(canvas)).toBe(transform);
  expect(pageScrolls, "the page scrolled to the node Tab passed over").toBe(0);
});

it("centers a count reached by Tab in the canvas", async () => {
  // Reduced motion, so the pan is a jump the next read sees.
  await emulateReducedMotion();
  const fixture = fixtureRun(WORKFLOW_RUN_IDS.running);
  const { canvas, pane } = await mountNarrowed(fixture);
  const firstNode = firstNodeOf(canvas);
  const count = await lastCountLeaving(canvas, fixture, firstNode);

  act(() => {
    firstNode.focus();
  });
  expect(isInside(count, pane), "the count starts outside the canvas").toBe(false);
  await pressTab();
  expect(document.activeElement).toBe(count);
  await waitFor(() => {
    expect(pane.scrollLeft + pane.scrollTop).toBe(0);
    expect(isCentered(count, pane)).toBe(true);
  });
});

it("centers a count reached by Tab mid-slide in the canvas where the slide ends", async () => {
  await emulateReducedMotion();
  const fixture = fixtureRun(WORKFLOW_RUN_IDS.running);
  const { canvas, pane } = await mountNarrowed(fixture);
  const firstNode = firstNodeOf(canvas);
  const count = await lastCountLeaving(canvas, fixture, firstNode);
  // A key first, so focus put from code is keyboard focus, which the canvas brings into view.
  await act(async () => {
    await userEvent.keyboard("{Shift}");
  });
  // The count put in view first, its node's center then outside the canvas.
  act(() => {
    count.focus();
  });
  await waitFor(() => {
    expect(pane.scrollLeft + pane.scrollTop).toBe(0);
    expect(isInside(count, pane), "the count is in the canvas").toBe(true);
  });
  expect(isInside(firstNode, pane), "the node's center is outside the canvas").toBe(false);
  // A person's small zoom about the canvas's edge on the node's side moves the count off the
  // center away from the node, and the node further out. A slide to the node then carries the
  // count further off, so only a reveal of the count centers it again.
  const paneBox = pane.getBoundingClientRect();
  const isNodeLeftOfCount =
    firstNode.getBoundingClientRect().left < count.getBoundingClientRect().left;
  act(() => {
    zoomAt(
      canvas,
      isNodeLeftOfCount ? paneBox.left + 1 : paneBox.right - 1,
      paneBox.top + paneBox.height / 2,
      -50,
    );
  });
  // Two frames, so the zoom is drawn before the geometry is read.
  await nextFrame();
  await nextFrame();
  expect(isInside(count, pane), "the zoom took the count out of the canvas").toBe(true);
  expect(isCentered(count, pane), "the zoom left the count centered").toBe(false);
  expect(isInside(firstNode, pane), "the zoom brought the node's center in").toBe(false);

  // With motion on, focus on the node starts a slide to it, and Tab moves to the count in that
  // same task, before the slide has moved the view, so the count is still in view as focus lands.
  // The node centered leaves the count outside, so only a reveal judged against where the view is
  // going brings the count back.
  await allowMotion();
  let isCountInViewAsFocusLands: boolean | undefined;
  count.addEventListener(
    "focus",
    () => {
      isCountInViewAsFocusLands = isInside(count, pane);
    },
    { once: true },
  );
  act(() => {
    firstNode.focus();
    fireEvent.keyDown(firstNode, { key: "Tab" });
  });
  expect(document.activeElement).toBe(count);
  expect(isCountInViewAsFocusLands).toBe(true);
  await waitFor(
    () => {
      expect(isCentered(count, pane)).toBe(true);
    },
    { timeout: SLIDE_LANDING_TIMEOUT_MS },
  );
  const countBox = count.getBoundingClientRect();
  const nodeBox = firstNode.getBoundingClientRect();
  expect(
    Math.abs(countBox.left + countBox.width / 2 - (nodeBox.left + nodeBox.width / 2)),
    "the node centered would leave the count outside the canvas",
  ).toBeGreaterThan(pane.getBoundingClientRect().width / 2);
});

it("judges a count reached by Tab against the view a person's zoom left, not the slide it cut off", async () => {
  await emulateReducedMotion();
  const fixture = fixtureRun(WORKFLOW_RUN_IDS.running);
  const { canvas, pane } = await mountNarrowed(fixture);
  const count = await lastCountLeaving(canvas, fixture, firstNodeOf(canvas));
  expect(isInside(count, pane), "the count starts outside the canvas").toBe(false);
  const paneBox = pane.getBoundingClientRect();
  const countBox = count.getBoundingClientRect();
  // The zoom is about the canvas's far side from the count, so it keeps the count outside.
  const zoomX =
    countBox.left < paneBox.left + paneBox.width / 2 ? paneBox.right - 1 : paneBox.left + 1;

  // Focus on the count starts a slide to it, and a person's zoom in that same task cuts the slide
  // off before it has moved the view.
  await allowMotion();
  await act(async () => {
    await userEvent.keyboard("{Shift}");
  });
  act(() => {
    count.focus();
    zoomAt(canvas, zoomX, paneBox.top + paneBox.height / 2, -240);
  });
  await act(async () => {
    await emulateReducedMotion();
  });
  await waitFor(() => {
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    expect(pane.scrollLeft + pane.scrollTop).toBe(0);
  });
  // Two frames, so the zoom is drawn before the geometry is read.
  await nextFrame();
  await nextFrame();
  expect(zoomOf(canvas), "the person's zoom left the view at its opening zoom").not.toBe(1);
  expect(isInside(count, pane), "the cut-off slide brought the count in").toBe(false);

  // The keyboard reaches the count again: judged against the view as it stands, it is brought to
  // the canvas's center at the person's zoom.
  act(() => {
    count.blur();
  });
  await act(async () => {
    await userEvent.keyboard("{Shift}");
  });
  act(() => {
    count.focus();
  });
  await waitFor(() => {
    expect(pane.scrollLeft + pane.scrollTop).toBe(0);
    expect(isCentered(count, pane)).toBe(true);
  });
});

/**
 * `fixture`'s graph, narrowed to a sliver once it opens: the running run opens at full size on its
 * live step and stays on it at full size, which leaves most nodes outside the canvas.
 */
async function mountNarrowed(fixture: FixtureRun): Promise<{
  readonly canvas: HTMLElement;
  readonly pane: HTMLElement;
  readonly after: HTMLElement;
}> {
  const { canvas, after } = await mountBetweenButtons(fixture);
  const openedTransform = viewportTransform(canvas);
  act(() => {
    canvas.style.inlineSize = "96px";
  });
  // The follow centers the live step again at the new width, so the library has seen the resize.
  await waitFor(() => {
    expect(viewportTransform(canvas)).not.toBe(openedTransform);
  });
  const pane = canvas.querySelector<HTMLElement>(".react-flow");
  if (pane === null) {
    throw new Error("the graph drew no frame");
  }
  return { canvas, pane, after };
}

function firstNodeOf(canvas: HTMLElement): HTMLElement {
  const node = canvas.querySelector<HTMLElement>(".react-flow__node");
  if (node === null) {
    throw new Error("the graph drew no node");
  }
  return node;
}

/** The count on the last edge leaving `node`, once the library has drawn it. */
async function lastCountLeaving(
  canvas: HTMLElement,
  fixture: FixtureRun,
  node: HTMLElement,
): Promise<SVGElement> {
  const edge = fixture.workflowDocument.edges
    .filter((candidate) => candidate.source === node.dataset["id"])
    .at(-1);
  if (edge === undefined) {
    throw new Error(`no edge leaves the node ${String(node.dataset["id"])}`);
  }
  return waitFor(() => {
    const drawn = countOf(canvas, edge.id);
    expect(drawn).toBeInstanceOf(SVGElement);
    return drawn as SVGElement;
  });
}

// A person's wheel on the canvas at a point, which zooms the view about it: in for a negative
// `deltaY`, out for a positive one.
function zoomAt(canvas: HTMLElement, clientX: number, clientY: number, deltaY: number): void {
  const surface = canvas.querySelector<HTMLElement>(".react-flow__pane");
  if (surface === null) {
    throw new Error("the graph drew no pane to zoom on");
  }
  surface.dispatchEvent(
    new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX, clientY, deltaY }),
  );
}

// Lets the view slide again: the page reads the cleared emulation a moment later, and until then a
// slide would be a jump.
async function allowMotion(): Promise<void> {
  await act(async () => {
    await clearMediaEmulation();
  });
  await waitFor(() => {
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
  });
}

// Where `element`'s center stands as the graph's view draws it, with any scroll the browser gave
// `frame` to show a focused element taken back out.
function drawnCenter(element: Element, frame: Element): { readonly x: number; readonly y: number } {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { x: left + width / 2 + frame.scrollLeft, y: top + height / 2 + frame.scrollTop };
}

function isInside(element: Element, frame: Element): boolean {
  const { x, y } = drawnCenter(element, frame);
  const bounds = frame.getBoundingClientRect();
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

// Whether `element`'s center stands at `frame`'s, within the pixel the library rounds its size to.
function isCentered(element: Element, frame: Element): boolean {
  const { x, y } = drawnCenter(element, frame);
  const bounds = frame.getBoundingClientRect();
  return (
    Math.abs(x - (bounds.left + bounds.right) / 2) < 1 &&
    Math.abs(y - (bounds.top + bounds.bottom) / 2) < 1
  );
}

// The zoom the library has set the view to, read off the transform it writes.
function zoomOf(canvas: HTMLElement): number {
  return new DOMMatrixReadOnly(viewportTransform(canvas)).a;
}

function viewportTransform(canvas: HTMLElement): string {
  return canvas.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";
}
