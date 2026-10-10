// A landing waits for the screen it will show to draw whole, through the binding, the controller
// and the real virtualizer: a find step onto a row whose work is still out, and End onto a tail
// with such a row on its screen, move nothing until that work lands, then land in one step; and a
// find step onto or beside a row the feed still holds out of the list waits for it to join, so
// nothing joins the screen after the landing.

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { syntheticRows } from "../controller.test-support.js";
import { type ViewportRow } from "../snapshot.js";
import {
  MOUNTED_ROW_COUNT,
  mountViewport,
  type MountedViewport,
} from "./useTranscriptViewport.test-support.js";

/** Frames a case gives the rows; nothing may move across them while a landing waits. */
const SETTLING_FRAMES = 8;

/**
 * The rows whose work is still out, the rows held out of the list beside the listed row each
 * follows, and the listeners a landing hears that work land through.
 */
class RowPreparations {
  readonly #unpreparedRowKeys: Set<string>;
  readonly #listeners = new Set<() => void>();
  /** Each held row's key, by the key of the listed row it follows. */
  readonly #heldRowKeyByListedKey = new Map<string, string>();

  public readonly isRowPrepared = (rowKey: string): boolean => !this.#unpreparedRowKeys.has(rowKey);

  public readonly isRowHeldOut = (rowKey: string): boolean =>
    [...this.#heldRowKeyByListedKey.values()].includes(rowKey);

  public readonly holdsRowAfter = (rowKey: string | undefined): boolean =>
    rowKey !== undefined && this.#heldRowKeyByListedKey.has(rowKey);

  public readonly subscribeToRowWork = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  public constructor(unpreparedRowKeys: readonly string[]) {
    this.#unpreparedRowKeys = new Set(unpreparedRowKeys);
  }

  /** Hold `rowKey` out of the list, after the listed row `listedKey`. */
  public holdOut(rowKey: string, listedKey: string): void {
    this.#heldRowKeyByListedKey.set(listedKey, rowKey);
  }

  /** The held row after `listedKey` joins the list. */
  public join(listedKey: string): void {
    this.#heldRowKeyByListedKey.delete(listedKey);
  }

  /** The row's last work lands. */
  public land(rowKey: string): void {
    this.#unpreparedRowKeys.delete(rowKey);
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/** The mounted log without the rows the feed holds out. */
function listedRows(heldRowKeys: readonly string[]): readonly ViewportRow[] {
  return syntheticRows(MOUNTED_ROW_COUNT).filter((row) => !heldRowKeys.includes(row.key));
}

/** Where the reader stands and where `rowKey` sits: what a later join would move. */
function positionOf(subject: MountedViewport, rowKey: string): readonly [number, number] {
  const rowStartPx = subject.binding.result.current.rowStartPx(rowKey) ?? expect.fail("held");
  return [subject.scrollContainer.scrollTop, rowStartPx];
}

function runFrames(count: number): void {
  for (let frame = 0; frame < count; frame += 1) {
    act(() => {
      vi.advanceTimersToNextFrame();
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the transcript viewport — a landing onto rows still being prepared", () => {
  it("moves nothing on a find step until the row draws whole, then lands in one step", () => {
    const preparations = new RowPreparations(["row-2"]);
    const subject = mountViewport(600, undefined, preparations);
    const { scroll } = subject.controller;
    const modeBefore = subject.binding.result.current.snapshot.reading.mode;

    act(() => {
      subject.binding.result.current.jumpToRow("row-2");
    });
    runFrames(SETTLING_FRAMES);
    expect(subject.scrollContainer.scrollTop).toBe(600);
    expect(scroll.writeCount("find-match")).toBe(0);
    expect(scroll.writeCount("hold-reading-position")).toBe(0);
    expect(subject.binding.result.current.snapshot.reading.mode).toBe(modeBefore);

    act(() => {
      preparations.land("row-2");
    });
    runFrames(SETTLING_FRAMES);
    expect(scroll.writeCount("find-match")).toBeGreaterThan(0);
    const rowStartPx = subject.binding.result.current.rowStartPx("row-2") ?? expect.fail("held");
    const rowEndPx = rowStartPx + (subject.virtualizer.measurementsCache[2]?.size ?? 0);
    expect(subject.scrollContainer.scrollTop).toBeLessThanOrEqual(rowStartPx);
    expect(
      subject.scrollContainer.scrollTop + subject.scrollContainer.clientHeight,
    ).toBeGreaterThan(rowEndPx);
  });

  it("holds End off a tail with a row still being prepared on its screen, then follows", () => {
    // Not the last row itself: the row above it, which the tail's screen shows too.
    const screenRowKey = `row-${String(MOUNTED_ROW_COUNT - 2)}`;
    const preparations = new RowPreparations([screenRowKey]);
    const subject = mountViewport(600, undefined, preparations);
    const { scroll } = subject.controller;

    act(() => {
      subject.binding.result.current.jumpToTail();
    });
    runFrames(SETTLING_FRAMES);
    expect(subject.scrollContainer.scrollTop).toBe(600);
    expect(scroll.writeCount("jump-to-tail")).toBe(0);
    expect(subject.binding.result.current.snapshot.reading.mode).not.toBe("following");

    act(() => {
      preparations.land(screenRowKey);
    });
    runFrames(SETTLING_FRAMES);
    expect(scroll.writeCount("jump-to-tail")).toBeGreaterThan(0);
    expect(subject.scrollContainer.scrollTop).toBe(subject.tailOffsetPx());
    expect(subject.binding.result.current.snapshot.reading.mode).toBe("following");
  });

  it("waits for a row held out inside a find step's screen to join, and nothing joins after", () => {
    const preparations = new RowPreparations([]);
    const subject = mountViewport(600, undefined, preparations);
    preparations.holdOut("row-5", "row-4");
    act(() => {
      subject.binding.rerender(listedRows(["row-5"]));
    });
    const scrollTopBefore = subject.scrollContainer.scrollTop;
    const { scroll } = subject.controller;

    act(() => {
      subject.binding.result.current.jumpToRow("row-6");
    });
    runFrames(SETTLING_FRAMES);
    expect(subject.scrollContainer.scrollTop).toBe(scrollTopBefore);
    expect(scroll.writeCount("find-match")).toBe(0);

    preparations.join("row-4");
    act(() => {
      subject.binding.rerender(listedRows([]));
    });
    runFrames(SETTLING_FRAMES);
    expect(scroll.writeCount("find-match")).toBeGreaterThan(0);
    const landed = positionOf(subject, "row-6");
    runFrames(SETTLING_FRAMES);
    expect(positionOf(subject, "row-6")).toEqual(landed);
  });

  it("lands a find step on a held row once it and the held rows beside it join", () => {
    const preparations = new RowPreparations([]);
    const subject = mountViewport(600, undefined, preparations);
    preparations.holdOut("row-5", "row-4");
    preparations.holdOut("row-7", "row-6");
    act(() => {
      subject.binding.rerender(listedRows(["row-5", "row-7"]));
    });
    const { scroll } = subject.controller;

    act(() => {
      subject.binding.result.current.jumpToRow("row-5");
    });
    runFrames(SETTLING_FRAMES);
    // The row joins, but the held row below it would still join its screen.
    preparations.join("row-4");
    act(() => {
      subject.binding.rerender(listedRows(["row-7"]));
    });
    runFrames(SETTLING_FRAMES);
    expect(scroll.writeCount("find-match")).toBe(0);

    preparations.join("row-6");
    act(() => {
      subject.binding.rerender(listedRows([]));
    });
    runFrames(SETTLING_FRAMES);
    expect(scroll.writeCount("find-match")).toBeGreaterThan(0);
    const [scrollTopPx, rowStartPx] = positionOf(subject, "row-5");
    expect(scrollTopPx).toBeLessThanOrEqual(rowStartPx);
    expect(scrollTopPx + subject.scrollContainer.clientHeight).toBeGreaterThan(rowStartPx);
    runFrames(SETTLING_FRAMES);
    expect(positionOf(subject, "row-5")).toEqual([scrollTopPx, rowStartPx]);
  });
});
