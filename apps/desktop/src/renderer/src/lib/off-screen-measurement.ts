// A window's undrawn items measured off screen, so it lays them out at their own heights before the
// reader scrolls to them: a command output's chunks of lines, or a diff's steps of rows. A slice
// draws a few items in the window's measuring frame, at the window's width and in its own type,
// and reads each one's height in the resize observation that follows the browser's layout of them,
// so reading lays nothing out. Each slice starts in a task of its own, and draws more items or
// fewer than the last by what the last took, its drawing and its layout timed by the wall clock, to
// stay inside a slice.

import type { Unsubscribe } from "#shared/preload-api.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import { queueTaskIn } from "#renderer/lib/queued-task.js";
import { SLICE_MS } from "#renderer/lib/work-slices.js";

/** One item of a window, by its index. */
export interface OffScreenItem<Item> {
  readonly index: number;
  readonly item: Item;
}

/** One item's height as a frame measured it, its border box in CSS pixels. */
export interface OffScreenItemHeight<Item> extends OffScreenItem<Item> {
  readonly heightPx: number;
}

/** The box a window's items are drawn in off screen: its document, width and type. */
export interface OffScreenBox {
  /** The document the frame is drawn in, the window's own, whose fonts it is set in. */
  readonly ownerDocument: Document;
  /** The items' content width, in CSS pixels. */
  readonly widthPx: number;
  /** The type the items inherit where they are drawn, as CSS declarations. */
  readonly textStyle: string;
}

/** What one slice draws hidden: some of a window's items, in its box. */
export interface OffScreenFrame<Item> {
  readonly box: OffScreenBox;
  /** Which slice drew the frame, so each slice's items mount anew and are observed. */
  readonly slice: number;
  readonly items: readonly OffScreenItem<Item>[];
}

/** What a measurement reads its window from, and hands the heights it measured to. */
export interface OffScreenMeasurementHost<Item> {
  /** The window's box once laid out, else `undefined`. */
  readonly readBox: () => OffScreenBox | undefined;
  /** The items still to measure, in order, `count` at most. */
  readonly readUnmeasuredItems: (count: number) => readonly OffScreenItem<Item>[];
  readonly takeHeights: (heights: readonly OffScreenItemHeight<Item>[]) => void;
}

/**
 * One window's off-screen measurement of its items, a slice at a time while any is unmeasured.
 * It draws through the frame it publishes, which `attachItem` observes as each item mounts, each
 * marked with its index under `indexAttribute`.
 */
export class OffScreenMeasurement<Item> {
  readonly #host: OffScreenMeasurementHost<Item>;
  readonly #indexAttribute: string;
  readonly #listeners = new Set<() => void>();
  #frame: OffScreenFrame<Item> | undefined;
  /** Each frame item's height as it is read, by index, until the frame's last is. */
  readonly #heightsPx = new Map<number, number>();
  #observations: Unsubscribe[] = [];
  /** Moved on by each stop, so a slice queued before it never draws. */
  #run = 0;
  #isQueued = false;
  #sliceCount = 0;
  /** How many items the next slice draws, doubled or halved by what the last slice took. */
  #itemsPerSlice = 1;
  #drawStartMs = 0;
  /** When the frame's last item mounted, which ends the slice's drawing. */
  #drawEndMs = 0;
  /** When the browser began the rendering step that lays the frame out. */
  #layoutStartMs: number | undefined;

  /** Hears each change of the frame to draw; returns the unsubscribe. */
  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The frame to draw hidden now, or `undefined` between slices. */
  public readonly read = (): OffScreenFrame<Item> | undefined => this.#frame;

  /**
   * One item of the frame as it mounts, observed until the frame is read; an item that unmounts
   * goes with its frame, whose observations end as it is read or stopped.
   */
  public readonly attachItem = (element: HTMLElement | null): void => {
    const frame = this.#frame;
    if (element === null || frame === undefined) {
      return;
    }
    this.#drawEndMs = performance.now();
    this.#observations.push(
      observeElementResize(element, (entries) => {
        this.#readItem(frame, element, entries.at(-1));
      }),
    );
  };

  public constructor(host: OffScreenMeasurementHost<Item>, indexAttribute: string) {
    this.#host = host;
    this.#indexAttribute = indexAttribute;
  }

  /** Measures every item the window holds unmeasured, unless a slice is already under way. */
  public measure(): void {
    if (this.#isQueued || this.#frame !== undefined) {
      return;
    }
    const view = this.#host.readBox()?.ownerDocument.defaultView;
    if (view === undefined) {
      return;
    }
    if (view === null) {
      throw new Error("A window's items were measured in a document with no window.");
    }
    this.#isQueued = true;
    const run = this.#run;
    queueTaskIn(view, () => {
      if (run === this.#run) {
        this.#isQueued = false;
        this.#drawSlice(view);
      }
    });
  }

  /** Stops measuring and drops the frame under way; `measure` starts again. */
  public stop(): void {
    this.#run += 1;
    this.#isQueued = false;
    if (this.#frame !== undefined) {
      this.#endFrame();
      this.#tell();
    }
  }

  /** Draws the next unmeasured items hidden, timing the rendering step that lays them out. */
  #drawSlice(view: Window): void {
    const box = this.#host.readBox();
    const items = this.#host.readUnmeasuredItems(this.#itemsPerSlice);
    if (box === undefined || items.length === 0) {
      return;
    }
    this.#drawStartMs = performance.now();
    this.#drawEndMs = this.#drawStartMs;
    this.#layoutStartMs = undefined;
    this.#sliceCount += 1;
    const frame = { box, slice: this.#sliceCount, items };
    this.#frame = frame;
    view.requestAnimationFrame(() => {
      if (this.#frame === frame) {
        this.#layoutStartMs = performance.now();
      }
    });
    this.#tell();
  }

  /**
   * Reads one frame item's height; the frame's last fits the slice, then hands them all over and
   * draws the next slice in a task.
   */
  #readItem(
    frame: OffScreenFrame<Item>,
    element: HTMLElement,
    entry: ResizeObserverEntry | undefined,
  ): void {
    if (frame !== this.#frame || entry === undefined) {
      return;
    }
    const index = Number(element.getAttribute(this.#indexAttribute));
    this.#heightsPx.set(index, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
    if (this.#heightsPx.size < frame.items.length) {
      return;
    }
    const heights = frame.items.map((drawn) => ({
      ...drawn,
      heightPx: this.#heightsPx.get(drawn.index) ?? 0,
    }));
    const spentMs =
      this.#drawEndMs -
      this.#drawStartMs +
      performance.now() -
      (this.#layoutStartMs ?? this.#drawEndMs);
    this.#endFrame();
    this.#fitSlice(spentMs);
    this.#tell();
    // The heights are taken in a task of their own, outside this resize report: the window's room
    // grows as it takes them, and the report of its conversation row, which sits above the frame,
    // would otherwise be held back to the next frame.
    const view = frame.box.ownerDocument.defaultView;
    if (view === null) {
      throw new Error("A window's items were measured in a document with no window.");
    }
    this.#isQueued = true;
    const run = this.#run;
    queueTaskIn(view, () => {
      if (run === this.#run) {
        this.#isQueued = false;
        this.#host.takeHeights(heights);
        this.#drawSlice(view);
      }
    });
  }

  /** Draws twice the items after a slice that took under half its time, half after one over. */
  #fitSlice(spentMs: number): void {
    if (spentMs > SLICE_MS) {
      this.#itemsPerSlice = Math.max(1, Math.floor(this.#itemsPerSlice / 2));
    } else if (spentMs < SLICE_MS / 2) {
      this.#itemsPerSlice = Math.min(MAX_ITEMS_PER_SLICE, this.#itemsPerSlice * 2);
    }
  }

  #endFrame(): void {
    for (const stopObserving of this.#observations) {
      stopObserving();
    }
    this.#observations = [];
    this.#heightsPx.clear();
    this.#frame = undefined;
  }

  #tell(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/**
 * The type of the text `style` was computed for, as CSS declarations a frame's box takes: the
 * inherited properties that set how its lines break and how tall they stand, which a frame drawn
 * outside the text's own row takes from it.
 */
export function inheritedTextStyleOf(style: CSSStyleDeclaration): string {
  const declarations = INHERITED_TEXT_PROPERTIES.map(
    (name) => `${name}: ${style.getPropertyValue(name)};`,
  );
  // Line heights are set as a share of the type's size, and Chromium lays a line height set in
  // pixels at another pitch, a fraction of a pixel a line that adds up down a long window; so the
  // frame takes the share.
  const lineHeightShare = parseFloat(style.lineHeight) / parseFloat(style.fontSize);
  declarations.push(
    `line-height: ${Number.isFinite(lineHeightShare) ? lineHeightShare.toFixed(6) : style.lineHeight};`,
  );
  return declarations.join(" ");
}

/** The inherited properties that set how text breaks and how tall its lines stand. */
const INHERITED_TEXT_PROPERTIES = [
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-stretch",
  "font-kerning",
  "font-feature-settings",
  "font-variation-settings",
  "font-variant-caps",
  "font-variant-ligatures",
  "font-variant-numeric",
  "letter-spacing",
  "word-spacing",
  "tab-size",
  "text-transform",
  "text-rendering",
  "word-break",
  "line-break",
  "hyphens",
] as const;

/** The most items one slice draws, however quickly the last one went. */
const MAX_ITEMS_PER_SLICE = 64;
