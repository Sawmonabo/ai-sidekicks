// What `phase-graph-settled.ts` is for, held to by the two surfaces it is used on.
//
// The tier it supports takes images and asserts nothing else, so the readiness rule
// itself has no other place to be checked: without this file the helper could return
// on its first call for the rest of its life and every reference would still be
// whatever frame the capture reached.

import { describe, expect, it } from "vitest";

import { mountWorkflowBuilderPane, mountWorkflowParkedRunPane } from "../workflow-surfaces.js";
import { awaitPhaseGraphSettled, isPhaseGraphSettled } from "./phase-graph-settled.js";

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
