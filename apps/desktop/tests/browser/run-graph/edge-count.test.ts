// An edge's item count is a figure: Tab walks the run graph's nodes in the browser's own order and
// never stops on a count, and the count's whole value is its description, which the pointer opens
// as its hover label. The nodes Tab does reach are the walk's negative control: a graph that took
// no keyboard at all would also never stop on a count. This needs real focus and layout, so it
// runs in Chromium.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { userEvent } from "vitest/browser";

import { WindowHoverLabel } from "#renderer/components/HoverLabel/WindowHoverLabel.js";
import { WORKFLOW_RUN_IDS } from "#fixtures/data/workflow/run/records.js";
import { fixtureRun, mountRunGraph } from "./mount.js";

afterEach(() => {
  cleanup();
});

/** Every edge's item count, which the hover label reads as `123,456,789,012 items`. */
const WHOLE_COUNT = 123_456_789_012;

/** How many presses the walk may take before the test gives up on reaching the far button. */
const TAB_PRESS_CEILING = 64;

it("walks the nodes and never stops on an edge's count, whose whole value the pointer opens", async () => {
  const fixture = fixtureRun(WORKFLOW_RUN_IDS.waitingApproval);
  const { container: canvas } = await mountRunGraph(
    fixture,
    fixture.workflowDocument.edges.map((edge) => ({ edgeId: edge.id, itemCount: WHOLE_COUNT })),
  );
  render(createElement(WindowHoverLabel));
  const before = document.createElement("button");
  const after = document.createElement("button");
  canvas.before(before);
  canvas.after(after);
  onTestFinished(() => {
    before.remove();
    after.remove();
  });
  const nodes = [...canvas.querySelectorAll<HTMLElement>(".react-flow__node")];
  const count = await waitFor(() => {
    const drawn = canvas.querySelector(".react-flow__edge-text tspan");
    expect(drawn).not.toBeNull();
    return drawn!;
  });

  act(() => {
    before.focus();
  });
  const reached: Element[] = [];
  for (let press = 0; press < TAB_PRESS_CEILING && document.activeElement !== after; press += 1) {
    await act(async () => {
      await userEvent.tab();
    });
    if (document.activeElement !== null && document.activeElement !== after) {
      reached.push(document.activeElement);
    }
  }
  expect(document.activeElement).toBe(after);
  expect(reached.filter((element) => element.closest(".react-flow__edge") !== null)).toStrictEqual(
    [],
  );
  expect(reached.filter((element) => nodes.some((node) => node === element))).toStrictEqual(nodes);

  const descriptionId = count.getAttribute("aria-describedby");
  expect(descriptionId === null ? null : document.getElementById(descriptionId)?.textContent).toBe(
    "123,456,789,012 items",
  );
  await act(async () => {
    await userEvent.hover(count);
  });
  await waitFor(() => {
    expect(document.querySelector(".meridian-hover-label")?.textContent).toBe(
      "123,456,789,012 items",
    );
  });
});
