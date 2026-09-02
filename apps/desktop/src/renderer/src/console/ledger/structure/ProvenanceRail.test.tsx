// The rail's surface, driven where a DOM shim can answer honestly.
//
// happy-dom reports zeroes for every rect and answers `null` from `getContext`,
// and both are deliberate here rather than worked around: the rail's own guards
// make a zero-height strip and an absent 2D context no-ops, so what this tier
// drives is the layer that survives them — the slider, the keyboard walk, the clip
// affordance, and the preview grace on the frozen clock. Geometry belongs to the
// browser tier, which has a real box to measure.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "../../core/index.js";
import { RAIL_PREVIEW_GRACE_MS } from "./constants.js";
import { ProvenanceRail } from "./ProvenanceRail.js";
import { ProvenanceRailModel } from "./rail-model.js";
import { generalRow, runRow } from "./row-fixtures.js";

/** Four marks: a message, an approval, a tool error, and a handoff. */
function railModel(hasEarlierRows = false): ProvenanceRailModel {
  return new ProvenanceRailModel({
    hasEarlierRows,
    rows: [
      generalRow({
        id: "m1",
        sequence: 1,
        type: "user.message",
        category: "interactive_request",
        summary: "asked for the deploy plan",
      }),
      runRow({
        id: "ap",
        sequence: 2,
        type: "approval.requested",
        category: "approval_flow",
        runId: "run-a",
        position: 1,
        summary: "wants to write outside the worktree",
      }),
      runRow({
        id: "te",
        sequence: 3,
        type: "tool.error",
        category: "tool_activity",
        runId: "run-a",
        position: 2,
        summary: "the build step exited 1",
      }),
      runRow({
        id: "ha",
        sequence: 4,
        type: "agent.attached",
        category: "membership_change",
        runId: "run-a",
        position: 3,
        summary: "a second agent joined",
      }),
    ],
  });
}

/** A rail over a session that has produced nothing yet. Built per case: the
 * model memoizes on first read, and two cases sharing one memo would share a
 * cache rather than a fixture. */
function emptyRail(): ProvenanceRailModel {
  return new ProvenanceRailModel({ rows: [], hasEarlierRows: false });
}

/** What a mounted rail lets a case observe. */
interface RailHarness {
  readonly slider: HTMLElement;
  /** Row ids the rail asked the ledger to scroll to, in press order. */
  readonly jumps: readonly string[];
  /** How many times it asked for earlier rows. */
  loadEarlierCount(): number;
}

function renderRail(
  options: {
    readonly model?: ProvenanceRailModel;
    readonly clock?: ManualClock;
  } = {},
): RailHarness {
  const jumps: string[] = [];
  let loadEarlierCount = 0;
  render(
    <ProvenanceRail
      model={options.model ?? railModel()}
      viewportPosition={0}
      viewportExtent={0.25}
      isFollowing={false}
      onJumpToRow={(rowId) => jumps.push(rowId)}
      onLoadEarlier={() => {
        loadEarlierCount += 1;
      }}
      clock={options.clock ?? new ManualClock()}
    />,
  );
  return {
    slider: screen.getByRole("slider"),
    jumps,
    loadEarlierCount: () => loadEarlierCount,
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

  it("walks one kind on its digit, and back on Shift plus the same digit", () => {
    // Digit 3 is the third entry of `RAIL_TICK_KINDS`, which is `tool-error`;
    // digit 1 is `participant-message`. The mapping is derived from that tuple,
    // so this also pins that a kind added there becomes walkable with no second
    // table edited.
    const { slider, jumps } = renderRail();
    fireEvent.keyDown(slider, { key: "3" });
    expect(jumps).toStrictEqual(["te"]);
    fireEvent.keyDown(slider, { key: "1", shiftKey: true });
    expect(jumps).toStrictEqual(["te", "m1"]);
  });

  it("negative control: a key the rail does not bind moves nothing", () => {
    const { slider, jumps } = renderRail();
    fireEvent.keyDown(slider, { key: "a" });
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    fireEvent.keyDown(slider, { key: "0" });
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
});

describe("rail — the preview opens after a grace, measured on the injected clock", () => {
  it("opens no card before the grace has elapsed", () => {
    const clock = new ManualClock();
    const { slider } = renderRail({ clock });
    fireEvent.pointerMove(slider, { clientY: 0 });
    act(() => {
      clock.advance(RAIL_PREVIEW_GRACE_MS - 1);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("opens the card the pointer was over once the grace elapses", () => {
    const clock = new ManualClock();
    const { slider } = renderRail({ clock });
    fireEvent.pointerMove(slider, { clientY: 0 });
    act(() => {
      clock.advance(RAIL_PREVIEW_GRACE_MS);
    });
    expect(screen.getByRole("status").textContent).toContain("asked for the deploy plan");
  });

  it("reads no wall clock: with the frozen clock never advanced, no card ever opens", () => {
    // Which is the whole reason the grace takes a `ConsoleClock`. A rail that
    // reached past it to `setTimeout` would open this card on its own, and the
    // armed count is what says one grace — not none, and not one per tick — is
    // waiting.
    const clock = new ManualClock();
    const { slider } = renderRail({ clock });
    fireEvent.pointerMove(slider, { clientY: 0 });
    fireEvent.pointerMove(slider, { clientY: 0 });
    fireEvent.pointerMove(slider, { clientY: 0 });
    expect(screen.queryByRole("status")).toBeNull();
    expect(clock.pendingCount).toBe(1);
  });

  it("negative control: a rail with no marks arms no grace at all", () => {
    // `tickNearest` answers `undefined` over an empty rail, and the grace shows
    // the absence immediately rather than scheduling a card with nothing in it.
    const clock = new ManualClock();
    const { slider } = renderRail({ clock, model: emptyRail() });
    fireEvent.pointerMove(slider, { clientY: 0 });
    expect(clock.pendingCount).toBe(0);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
