// The rail's surface, driven where a DOM shim can answer honestly.
//
// happy-dom reports zeroes for every rect and answers `null` from `getContext`,
// and both are deliberate here rather than worked around: the rail's own guards
// make a zero-height strip and an absent 2D context no-ops, so what this tier
// drives is the layer that survives them — the slider, the keyboard walk, the clip
// affordance, and the preview grace on the frozen clock. Geometry belongs to the
// browser tier, which has a real box to measure.
//
// The preview grace is `ProvenanceRail.preview.test.tsx`', which mounts the same
// rail through the same harness.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProvenanceRailModel } from "./rail-model.js";
import {
  emptyRail,
  railModel,
  renderRail,
  storyRows,
  type RailHarness,
} from "./ProvenanceRail.test-support.js";

/**
 * The same rail over a subset of its rows — what replay, a filter, or the cap
 * leaves behind. The ordering is the surviving rows, which is what a viewport
 * holding only those would hand the model.
 */
function railModelOver(rowIds: readonly string[]): ProvenanceRailModel {
  const rows = storyRows().filter((row) => rowIds.includes(row.id));
  return new ProvenanceRailModel({
    rows,
    retainedRowKeys: rows.map((row) => row.id),
    hasEarlierRows: false,
  });
}

/** The thumb's top and height, in percent of the rail. */
function thumbBounds(slider: HTMLElement): {
  readonly topPercent: number;
  readonly heightPercent: number;
} {
  const thumb = slider.querySelector<HTMLElement>(".meridian-rail__thumb");
  if (thumb === null) {
    throw new Error("the rail drew no viewport thumb");
  }
  return {
    topPercent: Number.parseFloat(thumb.style.top),
    heightPercent: Number.parseFloat(thumb.style.height),
  };
}

describe("rail — the accessible layer over an opaque canvas", () => {
  it("is a labelled slider whose range is the marks it drew", () => {
    const { slider } = renderRail();
    expect(slider.getAttribute("aria-label")).toBe("Session provenance rail");
    expect(slider.getAttribute("aria-orientation")).toBe("vertical");
    expect(slider.getAttribute("aria-valuemin")).toBe("0");
    expect(slider.getAttribute("aria-valuemax")).toBe("3");
    expect(slider.getAttribute("aria-valuetext")).toBe("No mark selected");
    expect(slider.tabIndex).toBe(0);
  });

  it("negative control: a rail with no marks says so rather than reading as unselected", () => {
    // "No mark selected" over an empty rail would send somebody looking for marks
    // that were never drawn.
    renderRail({ model: emptyRail() });
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("No marks on the rail");
  });

  it("hides the canvas from assistive technology", () => {
    const { slider } = renderRail();
    const canvas = slider.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("rail — the viewport thumb stays inside the rail", () => {
  it("ends a tail viewport's thumb exactly at the foot", () => {
    const { slider } = renderRail({ viewport: { position: 0.9, extent: 0.1 } });
    const { topPercent, heightPercent } = thumbBounds(slider);
    expect(topPercent + heightPercent).toBeCloseTo(100, 6);
  });

  it("negative control: clamping the two independently hangs the thumb off the end", () => {
    // The band a tail viewport produced before the geometry was fixed. Clamped
    // top-and-height-apart it survives untouched, which is exactly how a 90.9%
    // top and a 10% height reached the DOM; one clamp over the pair pulls it back
    // to the foot instead.
    const overrunning = { position: 0.909, extent: 0.1 };
    expect(Math.min(1, overrunning.position) + Math.min(1, overrunning.extent)).toBeGreaterThan(1);
    const { slider } = renderRail({ viewport: overrunning });
    const { topPercent, heightPercent } = thumbBounds(slider);
    expect(topPercent + heightPercent).toBeCloseTo(100, 6);
  });

  it("draws a mid-window thumb where it was asked to", () => {
    const { slider } = renderRail({ viewport: { position: 0.25, extent: 0.5 } });
    expect(thumbBounds(slider)).toStrictEqual({ topPercent: 25, heightPercent: 50 });
  });
});

describe("rail — every offer is reachable without a pointer", () => {
  it("walks forward with ArrowDown and jumps through the ledger's own chokepoint", () => {
    const { slider, jumps } = renderRail();
    fireEvent.keyDown(slider, { key: "ArrowDown" });
    expect(jumps).toStrictEqual(["m1"]);
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
    expect(slider.getAttribute("aria-valuetext")).toBe(
      "participant-message: asked for the deploy plan",
    );

    fireEvent.keyDown(slider, { key: "ArrowDown" });
    expect(jumps).toStrictEqual(["m1", "ap"]);
    expect(slider.getAttribute("aria-valuenow")).toBe("1");
  });

  it("reaches the ends with Home and End", () => {
    const { slider, jumps } = renderRail();
    fireEvent.keyDown(slider, { key: "End" });
    expect(jumps).toStrictEqual(["ha"]);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(jumps).toStrictEqual(["ha", "m1"]);
  });

  it("walks one kind on its digit, and back on shift plus the same digit", () => {
    // Digit 3 is the third entry of `RAIL_TICK_KINDS`, which is `tool-error`;
    // digit 1 is `participant-message`. The mapping is derived from that tuple,
    // so this also pins that a kind added there becomes walkable with no second
    // table edited.
    //
    // Both events carry what a real keyboard reports: `code` is the physical key
    // and `key` is whatever the layout and the shift state made of it. Shift plus
    // the digit-1 key reports `"!"` on a US layout, which is the whole reason the
    // walk reads `code`.
    const { slider, jumps } = renderRail();
    fireEvent.keyDown(slider, { code: "Digit3", key: "3" });
    expect(jumps).toStrictEqual(["te"]);
    fireEvent.keyDown(slider, { code: "Digit1", key: "!", shiftKey: true });
    expect(jumps).toStrictEqual(["te", "m1"]);
  });

  it("negative control: a shifted digit with no physical key behind it walks nothing", () => {
    // `{ key: "1", shiftKey: true }` is the combination no browser produces, and
    // reading the digit out of `key` is what made it look like a working shortcut.
    // A layout that reports punctuation on the same press must not walk either.
    const { slider, jumps } = renderRail();
    // Land on the tool-error mark first, so a previous-kind walk WOULD have
    // somewhere to go if either synthesized shape were still admitted.
    fireEvent.keyDown(slider, { code: "Digit3", key: "3" });
    fireEvent.keyDown(slider, { key: "1", shiftKey: true });
    fireEvent.keyDown(slider, { key: "!", shiftKey: true });
    expect(jumps).toStrictEqual(["te"]);
  });

  it("negative control: the numpad keeps its navigation rather than walking a kind", () => {
    // With NumLock off `Numpad1` reports `key: "End"`. The walk binds the digit
    // row only, so that press reaches the rail's end the way `End` always does.
    const { slider, jumps } = renderRail();
    fireEvent.keyDown(slider, { code: "Numpad1", key: "End" });
    expect(jumps).toStrictEqual(["ha"]);
  });

  it("negative control: a key the rail does not bind moves nothing", () => {
    const { slider, jumps } = renderRail();
    fireEvent.keyDown(slider, { code: "KeyA", key: "a" });
    fireEvent.keyDown(slider, { code: "ArrowLeft", key: "ArrowLeft" });
    fireEvent.keyDown(slider, { code: "Digit0", key: "0" });
    expect(jumps).toStrictEqual([]);
  });

  it("negative control: walking off the end stops rather than wrapping", () => {
    // The rail shows no counter, so a wrap would be a jump with nothing on screen
    // explaining it.
    const { slider, jumps } = renderRail();
    fireEvent.keyDown(slider, { key: "End" });
    fireEvent.keyDown(slider, { key: "ArrowDown" });
    expect(jumps).toStrictEqual(["ha"]);
  });
});

describe("rail — the selection is a mark, and every walk starts from it", () => {
  /** The rail after a replay scrubbed back and withheld the mark that was selected. */
  function railWithSelectedMarkWithheld(): RailHarness {
    const harness = renderRail();
    fireEvent.keyDown(harness.slider, { key: "End" });
    expect(harness.slider.getAttribute("aria-valuetext")).toBe("handoff: a second agent joined");
    harness.showModel(railModelOver(["m1", "ap", "te"]));
    return harness;
  }

  it("says the selected mark is gone rather than keeping it selected", () => {
    const harness = railWithSelectedMarkWithheld();
    expect(harness.slider.getAttribute("aria-valuetext")).toBe("No mark selected");
    expect(harness.slider.getAttribute("aria-valuenow")).toBe("0");
  });

  it("walks from the rail's head again, and announces where it landed", () => {
    const harness = railWithSelectedMarkWithheld();
    fireEvent.keyDown(harness.slider, { key: "ArrowDown" });
    expect(harness.jumps).toStrictEqual(["ha", "m1"]);
    // The announced value and the walk are one resolution: the mark the press
    // reached is the mark the slider now names.
    expect(harness.slider.getAttribute("aria-valuetext")).toBe(
      "participant-message: asked for the deploy plan",
    );
    expect(harness.slider.getAttribute("aria-valuenow")).toBe("0");
  });

  it("finds the first visible mark of a kind after the selected one goes away", () => {
    const harness = railWithSelectedMarkWithheld();
    fireEvent.keyDown(harness.slider, { code: "Digit3", key: "3" });
    expect(harness.jumps).toStrictEqual(["ha", "te"]);
    expect(harness.slider.getAttribute("aria-valuetext")).toBe(
      "tool-error: the build step exited 1",
    );
  });

  it("negative control: the removed mark's sequence walks past every visible one", () => {
    // The origin that shipped — the recorded sequence, kept after its mark left
    // the model. It is after every mark the rail still holds, so both walks the
    // cases above make find nothing at all: ArrowDown moves nowhere and the digit
    // walk moves nowhere, while the slider says nothing is selected. That is the
    // disagreement, and it is what the resolved origin removes.
    const model = railModelOver(["m1", "ap", "te"]);
    const removedMarkSequence = 4;
    expect(model.model().ticks.every((tick) => tick.sequence < removedMarkSequence)).toBe(true);
    expect(model.model().ticks.find((tick) => tick.sequence > removedMarkSequence)).toBeUndefined();
    expect(model.tickOfKind("tool-error", removedMarkSequence, "next")).toBeUndefined();
  });

  it("re-selects the person's own mark when the model admits it again", () => {
    // The recorded sequence is kept rather than cleared, so a replay scrubbed
    // back forward returns the mark they chose instead of leaving a substitute
    // selected in its place.
    const harness = railWithSelectedMarkWithheld();
    expect(harness.slider.getAttribute("aria-valuetext")).toBe("No mark selected");
    harness.showModel(railModel());
    expect(harness.slider.getAttribute("aria-valuetext")).toBe("handoff: a second agent joined");
    expect(harness.slider.getAttribute("aria-valuenow")).toBe("3");
  });

  it("reaches the last visible mark with ArrowUp from no selection", () => {
    const harness = railWithSelectedMarkWithheld();
    fireEvent.keyDown(harness.slider, { key: "ArrowUp" });
    expect(harness.jumps).toStrictEqual(["ha", "te"]);
  });
});

describe("rail — clip honesty is rendered, not implied", () => {
  it("offers to load earlier rows when the window is truncated", () => {
    const harness = renderRail({ model: railModel(true) });
    fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    expect(harness.loadEarlierCount()).toBe(1);
  });

  it("negative control: a complete window offers no such affordance", () => {
    // Offering it over a complete log would promise something the press could not
    // deliver.
    renderRail({ model: railModel(false) });
    expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();
  });

  it("keeps the dotted segment where the reader cannot page, and drops the button", () => {
    // Clip honesty is a fact about the WINDOW, so the segment is drawn
    // whether or not anybody can act on it; the button is a promise, so it is not.
    const { slider } = renderRail({ model: railModel(true), canLoadEarlier: false });
    expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();
    expect(slider.querySelector(".meridian-rail__unloaded")).not.toBeNull();
  });
});
