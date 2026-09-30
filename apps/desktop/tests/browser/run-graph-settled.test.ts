// What `tests/helpers/run-graph-settled.ts` is for, held to by a graph and by a view that
// draws none.
//
// Neither tier that consumes the helper can check it: the screenshot tier asserts nothing but
// images, and the accessibility tier asserts an empty violation list, which is also what a run
// over a view that never settled returns. Without this file the helper could return on its
// first call and every audit would stay green over a graph it never saw.
//
// It runs in the browser tier because the aggregate `test` script runs that tier and the
// accessibility tier the helper also serves, while the screenshot tier is not in it; and
// because a Node project has no DOM, animation frame or layout engine to measure against.
//
// Every unsettled state is manufactured through the cascade (the collapsing rule), never raced
// for: a negative control that depends on when a chunk arrives is not a control.

import { afterEach, describe, expect, it } from "vitest";

import {
  mountWorkflowBuilderPane,
  mountWorkflowRunPhaseGraph,
} from "../helpers/feature-mounts/workflows.js";
import { awaitRunGraphSettled, isRunGraphSettled } from "../helpers/run-graph-settled.js";

/**
 * Take the canvas's stated block size away, which collapses the graph. The canvas is targeted
 * rather than the library's root because the root's `height: 100%` is written inline and no
 * stylesheet can outrank it; with the canvas on `auto` the percentage resolves to nothing and
 * the root paints at zero inside a box still holding its 20rem floor.
 *
 * It is a stylesheet, not a rewritten element, so the collapse comes through the cascade over
 * the shipped rule. It is marked so teardown finds it however a case ended.
 */
function collapseEveryGraphCanvas(): void {
  const collapsingRule = document.createElement("style");
  collapsingRule.dataset["collapsedGraph"] = "";
  collapsingRule.textContent = ".meridian-run-graph__canvas { block-size: auto }";
  document.head.append(collapsingRule);
}

/** Lift every collapse this file planted, so the graph's box is the pane's own again. */
function restoreEveryGraphCanvas(): void {
  for (const injected of document.head.querySelectorAll("style[data-collapsed-graph]")) {
    injected.remove();
  }
}

/**
 * How long the wait is watched for an early return before the collapse is lifted: well over
 * the settle's 50 ms `waitFor` polling interval, and a small fraction of the case's budget.
 */
const EARLY_RETURN_WATCH_MS = 300;

/** Whether a promise settles before a bounded timer does. */
async function settlesWithin(pending: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return Promise.race([
    pending.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), milliseconds);
    }),
  ]);
}

afterEach(() => {
  restoreEveryGraphCanvas();
});

describe("the capture's run-graph readiness", () => {
  it("holds while the picture is off screen, and resolves once it is back", async () => {
    const graph = await mountWorkflowRunPhaseGraph();
    await awaitRunGraphSettled(graph);
    expect(isRunGraphSettled(graph)).toBe(true);

    // The negative control and the reason the helper exists. The graph stays fitted (the
    // transform remains on the viewport) but its picture is gone, so a wait that read the
    // style attribute alone would return here at once; it must stay pending while the box is
    // empty.
    collapseEveryGraphCanvas();
    expect(isRunGraphSettled(graph)).toBe(false);
    const waitingForThePicture = awaitRunGraphSettled(graph);
    expect(await settlesWithin(waitingForThePicture, EARLY_RETURN_WATCH_MS)).toBe(false);

    // It is a wait, not a refusal: the picture coming back resolves it with no second call.
    restoreEveryGraphCanvas();
    await waitingForThePicture;
    expect(isRunGraphSettled(graph)).toBe(true);

    // Fitted and still: the transform a capture reads is the last commit's, not one a further
    // frame is about to replace.
    const viewport = graph.querySelector<HTMLElement>(".react-flow__viewport");
    const fitted = viewport?.style.transform;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(viewport?.style.transform).toBe(fitted);
  });

  it("negative control: a fitted graph whose root paints nothing is not settled", async () => {
    // Without this the predicate is satisfied by the style attribute alone, which the library
    // writes at any container size, including none: a fitted transform over a zero-height root.
    const graph = await mountWorkflowRunPhaseGraph();
    await awaitRunGraphSettled(graph);
    expect(isRunGraphSettled(graph)).toBe(true);

    collapseEveryGraphCanvas();
    // The fit is untouched and the picture is gone: the pair a style-attribute-only predicate
    // would pass.
    expect(graph.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform).not.toBe("");
    expect(isRunGraphSettled(graph)).toBe(false);
  });

  it("returns at once for a view that draws no graph", async () => {
    const mounted = await mountWorkflowBuilderPane();
    expect(mounted.element.querySelector(".meridian-run-graph")).toBeNull();
    expect(isRunGraphSettled(mounted.element)).toBe(true);
    await awaitRunGraphSettled(mounted.element);
  });
});
