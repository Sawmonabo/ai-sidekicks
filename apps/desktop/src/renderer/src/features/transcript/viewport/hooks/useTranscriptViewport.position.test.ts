// Where the reader ends up, through the binding, the controller and the real virtualizer: a
// follower kept on the last row by the library's own end anchor and landing on appended rows, a
// reader's gesture never undone by a landing still re-aiming, Home and End landing exactly, and a
// held reading position computed from no element. `happy-dom` lays nothing out, so the scroll
// container's content is the virtualizer's own total, as the sizer the library writes makes it,
// and a row "measuring" is the library's `resizeItem`, the call its row observer makes.

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SCROLL_TAIL_TOLERANCE_PX } from "#renderer/lib/scroll/geometry/publisher.js";
import { syntheticRows } from "../controller.test-support.js";
import {
  MOUNTED_ROW_COUNT,
  MOUNTED_ROW_ESTIMATE_PX,
  mountViewport,
} from "./useTranscriptViewport.test-support.js";

/** Frames a case gives the rows to measure; a landing must be exact by the last of them. */
const SETTLING_FRAMES = 8;

/** Run animation frames, the library's re-aim loop among them, doing `eachFrame` before each. */
function runFrames(count: number, eachFrame: () => void = () => undefined): void {
  for (let frame = 0; frame < count; frame += 1) {
    act(() => {
      eachFrame();
      vi.advanceTimersToNextFrame();
    });
  }
}

/** One keydown, as the platform dispatches it, on `target`. */
function pressKey(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the transcript viewport — a follower", () => {
  it("stays on the last row through an append and its growth, by the library's own options", () => {
    const subject = mountViewport("tail");
    expect(subject.binding.result.current.snapshot.reading.mode).toBe("following");

    act(() => {
      subject.binding.rerender(syntheticRows(MOUNTED_ROW_COUNT + 4));
    });
    expect(subject.scrollContainer.scrollTop).toBe(subject.tailOffsetPx());

    // The last row streams: it grows under a follower every frame.
    let lastRowHeightPx = MOUNTED_ROW_ESTIMATE_PX;
    runFrames(SETTLING_FRAMES, () => {
      lastRowHeightPx += 60;
      subject.virtualizer.resizeItem(MOUNTED_ROW_COUNT + 3, lastRowHeightPx);
    });
    expect(subject.scrollContainer.scrollTop).toBe(subject.tailOffsetPx());
    expect(subject.binding.result.current.snapshot.reading.mode).toBe("following");

    // Every write was the library keeping the follower on the tail; nothing else moved them.
    const { scroll } = subject.controller;
    expect(scroll.writeCount("follow-tail")).toBeGreaterThan(0);
    expect(scroll.writeCount("jump-to-tail")).toBe(0);
    expect(scroll.writeCount("hold-reading-position")).toBe(0);
    expect(scroll.writeCount("measurement-compensation")).toBe(0);
  });

  it("is put back on the tail when the box shrinks under them", () => {
    // The library re-anchors a follower when a row or the row set changes, never the box alone.
    const subject = mountViewport("tail");
    const shrunkViewportHeightPx = 250;

    act(() => {
      subject.scrollContainer.resizeTo(shrunkViewportHeightPx, 0);
      subject.resizeObserver.deliverFor(subject.scrollContainer, shrunkViewportHeightPx);
      subject.clock.runFrame();
    });

    expect(subject.scrollContainer.scrollTop).toBe(subject.tailOffsetPx());
    expect(subject.binding.result.current.snapshot.reading.mode).toBe("following");
    expect(subject.controller.scroll.writeCount("follow-tail")).toBe(1);
  });
});

describe("the transcript viewport — a follower only the reader moves", () => {
  it("stays on the tail when the stream's end re-keys the last row and the library writes short", async () => {
    // The last row is replaced at an unchanged count, which the library answers by holding the
    // row at the top of the viewport; that write can land short of the tail. Only the reader's
    // own scroll leaves the tail, so the follower is landed back on it.
    const subject = mountViewport("tail");
    const rows = syntheticRows(MOUNTED_ROW_COUNT);
    const lastRow = rows[MOUNTED_ROW_COUNT - 1];
    if (lastRow === undefined) {
      throw new Error("the mounted log has no last row");
    }
    act(() => {
      subject.binding.rerender([...rows.slice(0, -1), { ...lastRow, key: "row-replaced" }]);
    });
    await act(async () => {
      subject.virtualizer.scrollToOffset(subject.tailOffsetPx() - 85);
      await Promise.resolve();
    });
    runFrames(SETTLING_FRAMES);

    expect(subject.binding.result.current.snapshot.reading.mode).toBe("following");
    expect(subject.tailOffsetPx() - subject.scrollContainer.scrollTop).toBeLessThanOrEqual(
      SCROLL_TAIL_TOLERANCE_PX,
    );
  });
});

describe("the transcript viewport — a reader taking the scroll back", () => {
  it("is never pulled back toward the tail while the last row keeps growing", () => {
    // A landing on the last row keeps re-aiming for up to five seconds whenever its target moves,
    // and a streaming last row moves it every frame. The pill set one running, an append replaced
    // it with the library's own, and the reader scrolled up mid-stream.
    const subject = mountViewport(600);
    act(() => {
      subject.binding.result.current.jumpToTail();
    });
    act(() => {
      subject.binding.rerender(syntheticRows(MOUNTED_ROW_COUNT + 2));
    });
    let lastRowHeightPx = MOUNTED_ROW_ESTIMATE_PX;
    const growLastRow = (): void => {
      lastRowHeightPx += 80;
      subject.virtualizer.resizeItem(MOUNTED_ROW_COUNT + 1, lastRowHeightPx);
    };
    act(growLastRow);
    expect(subject.scrollContainer.scrollTop).toBe(subject.tailOffsetPx());

    const readerOffsetPx = 900;
    act(() => {
      subject.scrollContainer.moveTo(readerOffsetPx);
    });
    expect(subject.binding.result.current.snapshot.reading.mode).not.toBe("following");

    runFrames(SETTLING_FRAMES, growLastRow);

    expect(subject.scrollContainer.scrollTop).toBe(readerOffsetPx);
  });
});

describe("the transcript viewport — Home and End on the log", () => {
  it("land exactly on the last and the first row once the rows near them measure", () => {
    const subject = mountViewport(600);

    const end = pressKey(subject.scrollContainer, { key: "End" });
    expect(end.defaultPrevented).toBe(true);
    // The rows the jump brought into view measure taller than their estimate.
    runFrames(SETTLING_FRAMES, () => {
      for (let index = MOUNTED_ROW_COUNT - 4; index < MOUNTED_ROW_COUNT; index += 1) {
        subject.virtualizer.resizeItem(index, 150);
      }
    });
    expect(subject.scrollContainer.scrollTop).toBe(subject.tailOffsetPx());
    expect(subject.binding.result.current.snapshot.reading.mode).toBe("following");

    const home = pressKey(subject.scrollContainer, { key: "Home" });
    expect(home.defaultPrevented).toBe(true);
    runFrames(SETTLING_FRAMES, () => {
      for (let index = 0; index < 4; index += 1) {
        subject.virtualizer.resizeItem(index, 130);
      }
    });
    expect(subject.scrollContainer.scrollTop).toBe(0);
    expect(subject.binding.result.current.snapshot.reading.mode).not.toBe("following");

    expect(subject.controller.scroll.writeCount("jump-to-tail")).toBeGreaterThan(0);
    expect(subject.controller.scroll.writeCount("jump-to-head")).toBeGreaterThan(0);
  });

  it("leaves a key pressed in a row's control, with a modifier, or already handled, alone", () => {
    const subject = mountViewport(600);
    const field = document.createElement("input");
    subject.scrollContainer.append(field);

    const fromField = pressKey(field, { key: "End" });
    const withShift = pressKey(subject.scrollContainer, { key: "End", shiftKey: true });
    const handled = (event: Event): void => {
      event.preventDefault();
    };
    subject.scrollContainer.addEventListener("keydown", handled, { capture: true });
    const alreadyHandled = pressKey(subject.scrollContainer, { key: "Home" });
    subject.scrollContainer.removeEventListener("keydown", handled, { capture: true });
    runFrames(SETTLING_FRAMES);

    expect(fromField.defaultPrevented).toBe(false);
    expect(withShift.defaultPrevented).toBe(false);
    expect(alreadyHandled.defaultPrevented).toBe(true);
    expect(subject.scrollContainer.scrollTop).toBe(600);
    expect(subject.controller.scroll.writeCount("jump-to-tail")).toBe(0);
    expect(subject.controller.scroll.writeCount("jump-to-head")).toBe(0);
  });
});

describe("the transcript viewport — a row's offset", () => {
  it("is read from the library's measurements, and holding a reader reads no element", () => {
    const subject = mountViewport(600);
    // A row above the reader measures 100 px taller than its estimate.
    act(() => {
      subject.virtualizer.resizeItem(2, MOUNTED_ROW_ESTIMATE_PX + 100);
    });
    expect(subject.binding.result.current.rowStartPx("row-6")).toBeCloseTo(
      6 * MOUNTED_ROW_ESTIMATE_PX + 100,
      6,
    );
    expect(subject.binding.result.current.rowStartPx("row-not-held")).toBeUndefined();

    const scrollHeightReads = vi.spyOn(subject.scrollContainer, "scrollHeight", "get");
    const clientHeightReads = vi.spyOn(subject.scrollContainer, "clientHeight", "get");
    const holdsBefore = subject.controller.scroll.writeCount("hold-reading-position");
    // An append under a reader: the reconcile holds their anchored row.
    act(() => {
      subject.binding.rerender(syntheticRows(MOUNTED_ROW_COUNT + 3));
    });

    expect(subject.controller.scroll.writeCount("hold-reading-position")).toBe(holdsBefore + 1);
    expect(scrollHeightReads).not.toHaveBeenCalled();
    expect(clientHeightReads).not.toHaveBeenCalled();
  });
});
