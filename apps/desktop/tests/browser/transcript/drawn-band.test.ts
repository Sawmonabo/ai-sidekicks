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
 * later change `isAfterLand` picks mounts inside the box was late to the land.
 */
class RowMountRecorder {
  /** The rows the first counted change that mounted any mounted, by log position. */
  public firstMounted: readonly (number | undefined)[] | undefined;
  /** The rows a counted change both mounted and took down, by log position. */
  public readonly churned: (number | undefined)[] = [];
  /** The rows a change after a land mounted inside the box, by log position. */
  public readonly lateMounted: (number | undefined)[] = [];
  /** How many lands were counted. */
  public changeCount = 0;
  readonly #changes: MutationObserver;

  public constructor(
    root: HTMLElement,
    options: { readonly isLand?: () => boolean; readonly isAfterLand?: () => boolean } = {},
  ) {
    const { isLand = () => true, isAfterLand = () => false } = options;
    this.#changes = new MutationObserver((records) => {
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
    "lays out each page joining at the head without taking down a row on screen",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const { scroller } = await mountLongToolHistory();
      // The reader only turns toward the head, so the offset rises only when a page joins there
      // and the hold puts the reader back on the rows they saw; until the next turn, any row
      // mounted inside the box is one the land should have drawn.
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
        await userEvent.wheel(scroller, { delta: { y: -FEED_HEIGHT_PX } });
        await endGesture();
      }
      lands.stop();
      // The control: pages joined at the head, so a land was laid out.
      expect(lands.changeCount).toBeGreaterThan(0);
      expect({ churned: lands.churned, late: lands.lateMounted }).toEqual({
        churned: [],
        late: [],
      });
    },
  );

  it("fills the box on every frame of a fling right after a land", async () => {
    const clock = new HeldTimeoutClock();
    const { scroller } = await mountLongToolFeed(clock);
    // The control: the opening's land left the band narrow, nothing drawn past the box.
    expect(rowsOffScreen(scroller)).toEqual([]);
    const unfilledFramesPx: number[] = [];
    const stopWatching = watchEveryChange(scroller, () => {
      const unfilledPx = unfilledHeightPx(scroller);
      if (unfilledPx > 0) {
        unfilledFramesPx.push(unfilledPx);
      }
    });
    // A fling: the wheel's turns come back to back, faster than the band's tasks would widen it.
    for (let turn = 0; turn < FLING_TURN_COUNT; turn += 1) {
      await userEvent.wheel(scroller, { delta: { y: -FLING_TURN_PX } });
    }
    await endGesture();
    stopWatching();
    expect(unfilledFramesPx).toEqual([]);
  });
});
