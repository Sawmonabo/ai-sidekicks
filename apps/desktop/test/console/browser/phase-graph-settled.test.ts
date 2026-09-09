// What `test/console/phase-graph-settled.ts` is for, held to by the two surfaces it is
// used on.
//
// Neither tier that consumes the helper can check it. The screenshot tier takes images
// and asserts nothing else, and the accessibility tier asserts an EMPTY violation list
// — which is also what a run over a surface that never settled returns. So without
// this file the helper could return on its first call for the rest of its life, and
// every reference would still be whatever frame the capture reached while every audit
// stayed green over a graph it never saw.
//
// IN THE BROWSER TIER, BECAUSE A CHECKER MUST RUN WHEREVER ITS SUBJECT RUNS. This
// file was in `screenshot/`, the one project the aggregate `test` script deliberately
// omits — its references are committed per platform and it runs in its own pinned
// job — while the helper it checks also runs in `accessibility/`, which the aggregate
// invokes on every call. A regression in the settle predicate therefore hung or
// green-washed the accessibility tier with the one test that would have named the
// cause never running.
//
// The browser tier rather than a Node one, and that is forced rather than preferred:
// a Node project has no DOM, no animation frame, and no layout engine, and every claim
// below is measured on all three. The
// browser tier is where "geometry a DOM shim cannot answer" already lives — the run
// pane's own graph-box case is its neighbour — and it is on the aggregate.
//
// THE UNSETTLED STATE IS MANUFACTURED, NEVER RACED FOR. An earlier form of the first
// case read the predicate straight after the mount and expected `false`, on the
// grounds that the graph chunk lands after the run read does. That was a claim about
// which of two fetches finishes first, and it held only while the mount helper
// returned on the read: once the helper also waited for the pane's form body, whose
// chunk is fetched beside the graph's, the graph was usually fitted by the time the
// helper returned and the assertion flipped on the runner. A negative control that
// depends on the order two chunks arrive in is not a control. So every unsettled
// state below is produced through the cascade — the collapsing rule — where it is
// exact, reversible, and independent of what the network did.

import { afterEach, describe, expect, it } from "vitest";

import { mountWorkflowBuilderPane, mountWorkflowParkedRunPane } from "../surfaces/workflows.js";
import { awaitPhaseGraphSettled, isPhaseGraphSettled } from "../phase-graph-settled.js";

/**
 * Take the canvas's stated block size away, which is what collapsed the graph.
 *
 * THE CANVAS AND NOT THE LIBRARY'S ROOT, because the root's height is an INLINE
 * `height: 100%` the library writes itself and no stylesheet can outrank. What decided
 * whether that percentage resolved to anything was always the box above it: with the
 * canvas back on `auto` its block size depends on its content, the percentage resolves
 * to nothing, and the root paints at zero inside a box still holding its 20rem floor —
 * the exact state a committed reference recorded.
 *
 * A STYLESHEET RATHER THAN A REWRITTEN ELEMENT, so the collapse is reached the way the
 * real one was: through the cascade, over the shipped rule, at equal specificity and
 * later in the sheet order. Marked so the file's teardown finds it however a case
 * ended, and so a case that lifts the collapse itself lifts exactly what it planted.
 */
function collapseEveryGraphCanvas(): void {
  const collapsingRule = document.createElement("style");
  collapsingRule.dataset["collapsedGraph"] = "";
  collapsingRule.textContent = ".meridian-phase-graph__canvas { block-size: auto }";
  document.head.append(collapsingRule);
}

/** Lift every collapse this file planted, so the graph's box is the pane's own again. */
function restoreEveryGraphCanvas(): void {
  for (const injected of document.head.querySelectorAll("style[data-collapsed-graph]")) {
    injected.remove();
  }
}

/**
 * How long the wait is watched for an early return before the collapse is lifted.
 *
 * Longer than the settle's own polling interval by a wide margin — `waitFor` re-reads
 * every 50 ms and on every DOM mutation — so a wait that returned on a false reading
 * has had many chances to do so before the timer wins, and short enough that a correct
 * wait costs the case a fraction of its budget rather than most of it.
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

describe("the capture's phase-graph readiness", () => {
  it("holds while the picture is off screen, and resolves once it is back", async () => {
    const mounted = await mountWorkflowParkedRunPane();
    await awaitPhaseGraphSettled(mounted.element);
    expect(isPhaseGraphSettled(mounted.element)).toBe(true);

    // The negative control, and the whole reason the helper exists. The graph is
    // fitted — that transform stays on the viewport throughout — and its picture is
    // taken away, so a wait that read the style attribute alone would return here at
    // once. It must not: for as long as the box is empty the wait is still pending.
    collapseEveryGraphCanvas();
    expect(isPhaseGraphSettled(mounted.element)).toBe(false);
    const waitingForThePicture = awaitPhaseGraphSettled(mounted.element);
    expect(await settlesWithin(waitingForThePicture, EARLY_RETURN_WATCH_MS)).toBe(false);

    // And it is a wait rather than a refusal: the picture coming back is what resolves
    // it, without a second call and without the mount being touched.
    restoreEveryGraphCanvas();
    await waitingForThePicture;
    expect(isPhaseGraphSettled(mounted.element)).toBe(true);

    // Fitted AND still: the transform the capture will read is the one the last
    // commit wrote, not one a further frame is about to replace.
    const viewport = mounted.element.querySelector<HTMLElement>(".react-flow__viewport");
    const fitted = viewport?.style.transform;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(viewport?.style.transform).toBe(fitted);
  });

  it("negative control: a fitted graph whose root paints nothing is not settled", async () => {
    // Without this the predicate is satisfied by the style attribute alone, which the
    // library writes at any container size — including none. That is the state a
    // committed reference recorded: a fitted transform over a root of zero height, a
    // 20rem sunken box with no phase in it, and every tier green.
    const mounted = await mountWorkflowParkedRunPane();
    await awaitPhaseGraphSettled(mounted.element);
    expect(isPhaseGraphSettled(mounted.element)).toBe(true);

    collapseEveryGraphCanvas();
    // The fit is untouched — the transform the predicate used to read is still on the
    // viewport — and the picture is gone, which is exactly the pair that used to pass.
    expect(
      mounted.element.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform,
    ).not.toBe("");
    expect(isPhaseGraphSettled(mounted.element)).toBe(false);
  });

  it("returns at once for a surface that draws no graph", async () => {
    const mounted = await mountWorkflowBuilderPane();
    expect(mounted.element.querySelector(".meridian-phase-graph")).toBeNull();
    expect(isPhaseGraphSettled(mounted.element)).toBe(true);
    await awaitPhaseGraphSettled(mounted.element);
  });
});
