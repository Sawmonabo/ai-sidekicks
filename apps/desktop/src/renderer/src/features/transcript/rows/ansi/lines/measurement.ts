// A long output's chunks measured off screen, so its window lays out the chunks it has not drawn at
// their own heights before the reader scrolls to them. A slice draws a few chunks in the window's
// measuring frames, at the lines' width and in the output's own type, and reads each one's height
// in the resize observation that follows the browser's layout of them, so reading lays nothing
// out. Each slice starts in a task of its own, and draws more chunks or fewer than the last by
// what the last took, its drawing and its layout timed by the wall clock, to stay inside a slice.

import type { Unsubscribe } from "#shared/preload-api.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import { queueTaskIn } from "#renderer/lib/queued-task.js";
import { SLICE_MS } from "#renderer/lib/work-slices.js";
import { type AnsiLineChunk } from "./chunks.js";
import { ANSI_LINE_CHUNK_INDEX_ATTRIBUTE } from "./markers.js";

/** One chunk of an output, by its index. */
export interface AnsiIndexedChunk {
  readonly index: number;
  readonly chunk: AnsiLineChunk;
}

/** What one slice draws hidden: some of an output's chunks, at its lines' width and type. */
export interface AnsiChunkMeasuringFrame {
  /** The document the frame is drawn in, the output's own, whose fonts it is set in. */
  readonly ownerDocument: Document;
  /** The lines' content width, in CSS pixels. */
  readonly widthPx: number;
  /** The lines' type in their row, as CSS declarations. */
  readonly textStyle: string;
  /** Which slice drew the frame, so each slice's chunks mount anew and are observed. */
  readonly slice: number;
  readonly chunks: readonly AnsiIndexedChunk[];
}

/** One chunk's height as a frame measured it, its border box in CSS pixels. */
export interface AnsiMeasuredChunkHeight extends AnsiIndexedChunk {
  readonly heightPx: number;
}

/** What a measurement reads its output from, and hands the heights it measured to. */
export interface AnsiChunkMeasurementHost {
  /** The output's lines once laid out: their document, content width and type; else `undefined`. */
  readonly readLines: () =>
    | {
        readonly ownerDocument: Document;
        readonly widthPx: number;
        readonly textStyle: string;
      }
    | undefined;
  /** The chunks still to measure, in order, `count` at most. */
  readonly readUnmeasuredChunks: (count: number) => readonly AnsiIndexedChunk[];
  readonly takeHeights: (heights: readonly AnsiMeasuredChunkHeight[]) => void;
}

/**
 * One output's off-screen measurement of its chunks, a slice at a time while any is unmeasured.
 * It draws through the frame it publishes, which `attachChunk` observes as each chunk mounts.
 */
export class AnsiChunkMeasurement {
  readonly #host: AnsiChunkMeasurementHost;
  readonly #listeners = new Set<() => void>();
  #frame: AnsiChunkMeasuringFrame | undefined;
  /** Each frame chunk's height as it is read, by index, until the frame's last is. */
  readonly #heightsPx = new Map<number, number>();
  #observations: Unsubscribe[] = [];
  /** Moved on by each stop, so a slice queued before it never draws. */
  #run = 0;
  #isQueued = false;
  #sliceCount = 0;
  /** How many chunks the next slice draws, doubled or halved by what the last slice took. */
  #chunksPerSlice = 1;
  #drawStartMs = 0;
  /** When the frame's last chunk mounted, which ends the slice's drawing. */
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
  public readonly read = (): AnsiChunkMeasuringFrame | undefined => this.#frame;

  /**
   * One chunk of the frame as it mounts, observed until the frame is read; a chunk that unmounts
   * goes with its frame, whose observations end as it is read or stopped.
   */
  public readonly attachChunk = (element: HTMLElement | null): void => {
    const frame = this.#frame;
    if (element === null || frame === undefined) {
      return;
    }
    this.#drawEndMs = performance.now();
    this.#observations.push(
      observeElementResize(element, (entries) => {
        this.#readChunk(frame, element, entries.at(-1));
      }),
    );
  };

  public constructor(host: AnsiChunkMeasurementHost) {
    this.#host = host;
  }

  /** Measures every chunk the output holds unmeasured, unless a slice is already under way. */
  public measure(): void {
    if (this.#isQueued || this.#frame !== undefined) {
      return;
    }
    const view = this.#host.readLines()?.ownerDocument.defaultView;
    if (view === undefined) {
      return;
    }
    if (view === null) {
      throw new Error("An output's chunks were measured in a document with no window.");
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

  /** Draws the next unmeasured chunks hidden, timing the rendering step that lays them out. */
  #drawSlice(view: Window): void {
    const lines = this.#host.readLines();
    const chunks = this.#host.readUnmeasuredChunks(this.#chunksPerSlice);
    if (lines === undefined || chunks.length === 0) {
      return;
    }
    this.#drawStartMs = performance.now();
    this.#drawEndMs = this.#drawStartMs;
    this.#layoutStartMs = undefined;
    this.#sliceCount += 1;
    const frame = { ...lines, slice: this.#sliceCount, chunks };
    this.#frame = frame;
    view.requestAnimationFrame(() => {
      if (this.#frame === frame) {
        this.#layoutStartMs = performance.now();
      }
    });
    this.#tell();
  }

  /** Reads one frame chunk's height; the frame's last hands them all over and fits the slice. */
  #readChunk(
    frame: AnsiChunkMeasuringFrame,
    element: HTMLElement,
    entry: ResizeObserverEntry | undefined,
  ): void {
    if (frame !== this.#frame || entry === undefined) {
      return;
    }
    const index = Number(element.getAttribute(ANSI_LINE_CHUNK_INDEX_ATTRIBUTE));
    this.#heightsPx.set(index, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
    if (this.#heightsPx.size < frame.chunks.length) {
      return;
    }
    const heights = frame.chunks.map((drawn) => ({
      ...drawn,
      heightPx: this.#heightsPx.get(drawn.index) ?? 0,
    }));
    this.#endFrame();
    this.#host.takeHeights(heights);
    const spentMs =
      this.#drawEndMs -
      this.#drawStartMs +
      performance.now() -
      (this.#layoutStartMs ?? this.#drawEndMs);
    this.#fitSlice(spentMs);
    this.#tell();
    this.measure();
  }

  /** Draws twice the chunks after a slice that took under half its time, half after one over. */
  #fitSlice(spentMs: number): void {
    if (spentMs > SLICE_MS) {
      this.#chunksPerSlice = Math.max(1, Math.floor(this.#chunksPerSlice / 2));
    } else if (spentMs < SLICE_MS / 2) {
      this.#chunksPerSlice = Math.min(MAX_CHUNKS_PER_SLICE, this.#chunksPerSlice * 2);
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

/** The type of the lines `style` was computed for, as CSS declarations a frame's box takes. */
export function linesTextStyleOf(style: CSSStyleDeclaration): string {
  const declarations = LINES_TEXT_PROPERTIES.map(
    (name) => `${name}: ${style.getPropertyValue(name)};`,
  );
  // The transcript sets its line heights as a share of the type's size, and Chromium lays a line
  // height set in pixels at another pitch, a fraction of a pixel a line that adds up down a long
  // output; so the frame takes the share.
  const lineHeightShare = parseFloat(style.lineHeight) / parseFloat(style.fontSize);
  declarations.push(
    `line-height: ${Number.isFinite(lineHeightShare) ? lineHeightShare.toFixed(6) : style.lineHeight};`,
  );
  return declarations.join(" ");
}

/**
 * The inherited properties that set how an output's lines break and how tall they stand, which a
 * frame drawn outside the lines' row takes from them.
 */
const LINES_TEXT_PROPERTIES = [
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

/** The most chunks one slice draws, however quickly the last one went. */
const MAX_CHUNKS_PER_SLICE = 64;
