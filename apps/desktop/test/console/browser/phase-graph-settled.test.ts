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
// The browser tier rather than the architecture tier, and that is forced rather than
// preferred: `console-architecture` is a Node project with no DOM, no animation
// frame, and no layout engine, and every claim below is measured on all three. The
// browser tier is where "geometry a DOM shim cannot answer" already lives — the run
// pane's own graph-box case is its neighbour — and it is on the aggregate.

import { describe, expect, it } from "vitest";

import { mountWorkflowBuilderPane, mountWorkflowParkedRunPane } from "../workflow-surfaces.js";
import { awaitPhaseGraphSettled, isPhaseGraphSettled } from "../phase-graph-settled.js";

describe("the capture's phase-graph readiness", () => {
  it("is not satisfied by the mount helper's own wait, and is after the fit", async () => {
    const mounted = await mountWorkflowParkedRunPane();
    // The negative control, and the whole reason the helper exists: the run read has
    // landed, the park banner is on screen, and the graph is not there yet — so a
    // capture taken here pins a frame of the chunk's arrival rather than the picture.
    expect(isPhaseGraphSettled(mounted.element)).toBe(false);

    await awaitPhaseGraphSettled(mounted.element);
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

  it("returns at once for a surface that draws no graph", async () => {
    const mounted = await mountWorkflowBuilderPane();
    expect(mounted.element.querySelector(".meridian-phase-graph")).toBeNull();
    expect(isPhaseGraphSettled(mounted.element)).toBe(true);
    await awaitPhaseGraphSettled(mounted.element);
  });
});
