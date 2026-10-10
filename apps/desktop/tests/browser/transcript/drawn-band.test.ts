// What a land draws, in the engine that lays the rows out: the render that lays a land out mounts
// the rows the reader ends on and no others, so no row mounts at an offset the box never shows,
// and the band beyond the box widens in the tasks after it, at once when the reader scrolls.

import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { RealClock, type Clock, type ScheduledHandle } from "#renderer/lib/clock.js";
import {
  FEED_HEIGHT_PX,
  ROW_SELECTOR,
  TOOL_ROW_COUNT,
  endGesture,
  mountLongToolFeed,
  mountLongToolHistory,
  positionOfRow,
} from "./long-tool-feed.js";
import { FASTEST_FLICK_SPEED, touchFling } from "./touch-fling.js";

/** Screens the reader wheels toward the head: far enough that pages join there. */
const SCREEN_COUNT = 15;
/** The case scrolls fifteen screens one real-time gesture at a time, past the default. */
const CASE_TIMEOUT_MS = 60_000;
/** The wheel turns one fling sends, back to back. */
const FLING_TURN_COUNT = 2;
/** Each fling turn's travel: the fling stays inside the band the reader's input draws. */
const FLING_TURN_PX = FEED_HEIGHT_PX * 0.4;
/** How far a row may stand past the box's edge and still be drawn for it: a device pixel. */
const GRAIN_PX = 1;
/** One wheel turn that moves the box further than the band reaches on a side it does not lead. */
const LONG_TURN_PX = FEED_HEIGHT_PX * 1.25;
/** A touch fling's travel before the hand lets go: three screens. */
const TOUCH_FLING_PX = FEED_HEIGHT_PX * 3;
/** A quick flick, whose momentum carries on long after the hand lets go, in pixels a second. */
const QUICK_FLICK_SPEED = 8000;
/** The wheel gestures before the first take-back a case may start at, near the window's end. */
const GESTURES_BEFORE_NEAR_END = 2;
/** The wheel gestures before a take-back a case may start at, deep in the window's middle. */
const GESTURES_BEFORE_MIDDLE = 8;

/**
 * The wall clock, except that its timeouts wait until the case runs them, so the band a land
 * narrowed stays narrow until the reader acts.
 */
class HeldTimeoutClock extends RealClock {
  readonly #held = new Map<ScheduledHandle, () => void>();
  #nextHeldHandle = -1;

  public override scheduleTimeout(callback: () => void): ScheduledHandle {
    const handle = this.#nextHeldHandle;
    this.#nextHeldHandle -= 1;
    this.#held.set(handle, callback);
    return handle;
  }

  public override cancel(handle: ScheduledHandle): void {
    if (!this.#held.delete(handle)) {
      super.cancel(handle);
    }
  }

  public override withFrames(): Clock {
    return this;
  }
}

/** The drawn rows' boxes, with each one's log position, top down. */
function drawnRows(scroller: HTMLElement): { position: number | undefined; rect: DOMRect }[] {
  return [...scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)]
    .map((row) => ({ position: positionOfRow(row), rect: row.getBoundingClientRect() }))
    .sort((first, second) => first.rect.top - second.rect.top);
}

/** The drawn rows the box does not show any of, by log position. */
function rowsOffScreen(scroller: HTMLElement): (number | undefined)[] {
  const box = scroller.getBoundingClientRect();
  return drawnRows(scroller)
    .filter(({ rect }) => rect.bottom <= box.top + GRAIN_PX || rect.top >= box.bottom - GRAIN_PX)
    .map(({ position }) => position);
}

/** How much of the box's height no drawn row covers, in pixels. */
function unfilledHeightPx(scroller: HTMLElement): number {
  const box = scroller.getBoundingClientRect();
  let coveredToPx = box.top;
  let unfilledPx = 0;
  for (const { rect } of drawnRows(scroller)) {
    if (rect.top > coveredToPx + GRAIN_PX) {
      unfilledPx += Math.min(rect.top, box.bottom) - coveredToPx;
    }
    coveredToPx = Math.max(coveredToPx, Math.min(rect.bottom, box.bottom));
  }
  return unfilledPx + Math.max(0, box.bottom - coveredToPx - GRAIN_PX);
}

/**
 * The rows each change to the DOM mounts and takes down, over the changes `isLand` picks (every
 * change by default). A row one change both mounts and takes down was drawn at an offset the box
 * never showed, or taken down and drawn again: either is work the reader never sees. A row a
 * later change `isAfterLand` picks mounts inside the box was late to the land. Over every change,
 * a row mounted again after an earlier change took it down, since `forgetTakenDown` last ran, was
 * drawn twice.
 */
class RowMountRecorder {
  /** The rows the first counted change that mounted any mounted, by log position. */
  public firstMounted: readonly (number | undefined)[] | undefined;
  /** The rows a counted change both mounted and took down, by log position. */
  public readonly churned: (number | undefined)[] = [];
  /** The rows a change after a land mounted inside the box, by log position. */
  public readonly lateMounted: (number | undefined)[] = [];
  /**
   * The rows a change mounted after an earlier change took them down, since `forgetTakenDown`, by
   * log position.
   */
  public readonly remounted: number[] = [];
  /** How many lands were counted. */
  public changeCount = 0;
  readonly #changes: MutationObserver;
  /** The log positions of every row a change has taken down so far. */
  readonly #takenDownPositions = new Set<number>();

  public constructor(
    root: HTMLElement,
    options: { readonly isLand?: () => boolean; readonly isAfterLand?: () => boolean } = {},
  ) {
    const { isLand = () => true, isAfterLand = () => false } = options;
    this.#changes = new MutationObserver((records) => {
      this.#noteRemounts(records);
      if (isLand()) {
        this.#count(records);
      } else if (isAfterLand()) {
        const box = root.getBoundingClientRect();
        for (const row of mountedRowsOf(records)) {
          const rect = row.getBoundingClientRect();
          if (rect.bottom > box.top + GRAIN_PX && rect.top < box.bottom - GRAIN_PX) {
            this.lateMounted.push(positionOfRow(row));
          }
        }
      }
    });
    this.#changes.observe(root, { childList: true, subtree: true });
  }

  public stop(): void {
    this.#changes.disconnect();
  }

  /** Counts a row taken down from now on as drawn twice only if a later change mounts it. */
  public forgetTakenDown(): void {
    this.#takenDownPositions.clear();
  }

  #noteRemounts(records: readonly MutationRecord[]): void {
    for (const row of mountedRowsOf(records)) {
      const position = positionOfRow(row);
      if (position !== undefined && this.#takenDownPositions.has(position)) {
        this.remounted.push(position);
      }
    }
    for (const row of rowsAmong(records.flatMap((record) => [...record.removedNodes]))) {
      const position = positionOfRow(row);
      if (position !== undefined) {
        this.#takenDownPositions.add(position);
      }
    }
  }

  #count(records: readonly MutationRecord[]): void {
    this.changeCount += 1;
    const mounted = mountedRowsOf(records);
    const takenDown = rowsAmong(records.flatMap((record) => [...record.removedNodes]));
    if (this.firstMounted === undefined && mounted.length > 0) {
      this.firstMounted = mounted.map((row) => positionOfRow(row));
    }
    const takenDownPositions = new Set(takenDown.map((row) => positionOfRow(row)));
    for (const row of mounted) {
      const position = positionOfRow(row);
      // A row with no position, such as a run's header, is matched as the same element.
      if (position === undefined ? takenDown.includes(row) : takenDownPositions.has(position)) {
        this.churned.push(position);
      }
    }
  }
}

/** The drawn rows among `nodes`. */
function rowsAmong(nodes: readonly Node[]): HTMLElement[] {
  return nodes.filter(
    (node): node is HTMLElement => node instanceof HTMLElement && node.matches(ROW_SELECTOR),
  );
}

/** The drawn rows a change to the DOM mounted. */
function mountedRowsOf(records: readonly MutationRecord[]): HTMLElement[] {
  return rowsAmong(records.flatMap((record) => [...record.addedNodes]));
}

/** Calls `onChange` after every change to the rows' DOM and on every frame until stopped. */
function watchEveryChange(scroller: HTMLElement, onChange: () => void): () => void {
  let isWatching = true;
  const onFrame = (): void => {
    if (isWatching) {
      onChange();
      requestAnimationFrame(onFrame);
    }
  };
  requestAnimationFrame(onFrame);
  const changes = new MutationObserver(onChange);
  changes.observe(scroller, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style"],
  });
  return () => {
    isWatching = false;
    changes.disconnect();
  };
}

/**
 * Wheels toward the head one gesture at a time until, after `minimumGestureCount`, one takes rows
 * back from the head: the box then stands in the window's middle, rows cut on both sides.
 */
async function wheelToTakeBack(scroller: HTMLElement, minimumGestureCount: number): Promise<void> {
  for (let gesture = 0; gesture < SCREEN_COUNT; gesture += 1) {
    const scrollHeightPx = scroller.scrollHeight;
    await userEvent.wheel(scroller, { delta: { y: -FEED_HEIGHT_PX } });
    await endGesture();
    if (gesture + 1 >= minimumGestureCount && scroller.scrollHeight > scrollHeightPx) {
      return;
    }
  }
  expect.fail("no gesture took rows back from the head");
}

/** The unfilled height of the box after every change to the rows while `drive` runs. */
async function unfilledFramesPxDuring(
  scroller: HTMLElement,
  drive: () => Promise<void>,
): Promise<number[]> {
  const unfilledFramesPx: number[] = [];
  const stopWatching = watchEveryChange(scroller, () => {
    const unfilledPx = unfilledHeightPx(scroller);
    if (unfilledPx > 0) {
      unfilledFramesPx.push(unfilledPx);
    }
  });
  try {
    await drive();
  } finally {
    stopWatching();
  }
  return unfilledFramesPx;
}

describe("a land draws the rows the reader ends on first", () => {
  it("opens on the tail, mounting no row it takes down before the box shows it", async () => {
    const clock = new HeldTimeoutClock();
    const opening = new RowMountRecorder(document.body);
    const { scroller } = await mountLongToolFeed(clock);
    opening.stop();

    // The control: the box shows the last call, so the feed opened on its tail.
    expect(drawnRows(scroller).map(({ position }) => position)).toContain(TOOL_ROW_COUNT - 1);
    expect(opening.firstMounted).toContain(TOOL_ROW_COUNT - 1);
    expect(opening.churned).toEqual([]);
    expect(rowsOffScreen(scroller)).toEqual([]);
  });

  it(
    "lays out each page joining at the head without taking down a row on screen or near it",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const { scroller } = await mountLongToolHistory();
      // The reader only turns toward the head, so the offset rises only when a page joins there
      // and the hold puts the reader back on the rows they saw; until the next turn, any row
      // mounted inside the box is one the land should have drawn, and a row taken down and drawn
      // again before the next turn was taken down by a land that should have kept it.
      let lastScrollTopPx = scroller.scrollTop;
      let isAfterLand = false;
      const lands = new RowMountRecorder(scroller, {
        isLand: () => {
          const isLand = scroller.scrollTop > lastScrollTopPx + FEED_HEIGHT_PX / 2;
          lastScrollTopPx = scroller.scrollTop;
          isAfterLand ||= isLand;
          return isLand;
        },
        isAfterLand: () => isAfterLand,
      });
      for (let screen = 0; screen < SCREEN_COUNT; screen += 1) {
        isAfterLand = false;
        lands.forgetTakenDown();
        await userEvent.wheel(scroller, { delta: { y: -FEED_HEIGHT_PX } });
        await endGesture();
      }
      lands.stop();
      // The control: pages joined at the head, so a land was laid out.
      expect(lands.changeCount).toBeGreaterThan(0);
      expect({
        churned: lands.churned,
        late: lands.lateMounted,
        remounted: lands.remounted,
      }).toEqual({ churned: [], late: [], remounted: [] });
    },
  );

  it("fills the box on every frame of a fling right after a land", async () => {
    const clock = new HeldTimeoutClock();
    const { scroller } = await mountLongToolFeed(clock);
    // The control: the opening's land left the band narrow, nothing drawn past the box.
    expect(rowsOffScreen(scroller)).toEqual([]);
    const unfilledFramesPx = await unfilledFramesPxDuring(scroller, async () => {
      // A fling: the wheel's turns come back to back, faster than the band's tasks would widen it.
      for (let turn = 0; turn < FLING_TURN_COUNT; turn += 1) {
        await userEvent.wheel(scroller, { delta: { y: -FLING_TURN_PX } });
      }
      await endGesture();
    });
    expect(unfilledFramesPx).toEqual([]);
  });

  it(
    "fills the box when one frame moves it further than a screen the way the reader moves",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const { scroller } = await mountLongToolFeed();
      await wheelToTakeBack(scroller, GESTURES_BEFORE_MIDDLE);
      // A turn toward the tail inside the band, so the reader moves that way with the band whole.
      await userEvent.wheel(scroller, { delta: { y: FEED_HEIGHT_PX / 2 } });
      await endGesture();
      const startScrollTopPx = scroller.scrollTop;
      const unfilledFramesPx = await unfilledFramesPxDuring(scroller, async () => {
        await userEvent.wheel(scroller, { delta: { y: LONG_TURN_PX } });
        await endGesture();
      });
      // The control: the turn moved the box toward the tail.
      expect(scroller.scrollTop).not.toBe(startScrollTopPx);
      expect(unfilledFramesPx).toEqual([]);
    },
  );

  it(
    "fills the box on every frame of a touch fling's momentum after it takes rows back",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      // The band's own steps never run, so only the scroll the momentum sends can widen it again
      // after the take-back's land narrows it; the hand has let go, so no touch says so.
      const { scroller } = await mountLongToolFeed(new HeldTimeoutClock());
      await wheelToTakeBack(scroller, GESTURES_BEFORE_NEAR_END);
      const unfilledFramesPx = await unfilledFramesPxDuring(scroller, async () => {
        await touchFling(scroller, TOUCH_FLING_PX, QUICK_FLICK_SPEED);
      });
      // The control: the fling reached the head, taking rows back on the way.
      expect(scroller.scrollTop).toBe(0);
      expect(unfilledFramesPx).toEqual([]);
    },
  );

  it(
    "fills the box on every frame of the fastest touch fling toward the tail",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const { scroller } = await mountLongToolFeed();
      await wheelToTakeBack(scroller, GESTURES_BEFORE_MIDDLE);
      const startScrollHeightPx = scroller.scrollHeight;
      const unfilledFramesPx = await unfilledFramesPxDuring(scroller, async () => {
        await touchFling(scroller, -TOUCH_FLING_PX, FASTEST_FLICK_SPEED);
      });
      // The control: the fling cut rows from the head on its way, moving the offset under it.
      expect(scroller.scrollHeight).toBeLessThan(startScrollHeightPx);
      expect(unfilledFramesPx).toEqual([]);
    },
  );
});
