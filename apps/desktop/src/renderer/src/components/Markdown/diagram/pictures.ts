// The pictures every diagram block shares, in every window: what each source came to under each
// palette, held in a cache bounded by the pictures' share of memory, and a queue that sends the
// app's one diagram worker one drawing at a time, the one nearest a reading position first. A
// drawing asked for by no block any more leaves the queue, and one that lands after every block
// that asked has gone is discarded. The cache keeps each picture as its SVG text. A picture on
// screen is shown at one object address, shared by every image showing it and revoked when the
// last lets go, so its decoded document goes with the rows that drew it. Showing pictures fills
// the renderer's own caches, which outlive the pictures, so once the pictures on screen fall by a
// large amount and stay down, those caches are emptied too.

import { createContext, type Context } from "react";

import { ByteBoundedCache } from "#renderer/lib/byte-bounded-cache.js";
import { measureUtf8ByteLength } from "#renderer/lib/utf8-byte-length.js";
import { defaultLabelFacesFor } from "./default-label-faces.js";
import type { DiagramPalette } from "./palette.js";
import { LabelMeasurer } from "./label-measurer.js";
import { DiagramWorkerConnection, type DiagramWorkerStart } from "./worker/connection.js";
import {
  LABEL_WIDTH_CACHE_BYTES,
  type DiagramOutcome,
  type DiagramPictureKind,
  type DrawnDiagram,
} from "./worker/messages.js";

/** Hears what one requested drawing came to. */
export type DiagramOutcomeListener = (outcome: DiagramOutcome) => void;

/** How far a block is from its window's reading position, in CSS pixels, read when it is asked. */
export type ReadingDistance = () => number;

/** The address one image shows a picture at, and the release it calls when it stops showing it. */
export interface PictureShowing {
  readonly url: string;
  readonly release: () => void;
}

/**
 * The cache and the drawing queue. One drawing runs at a time; asks for a key already waiting or
 * being drawn join it; an ask withdrawn by every block that made it leaves the queue.
 */
export class DiagramPictures {
  readonly #outcomes: ByteBoundedCache<DiagramOutcome>;
  readonly #connection: DiagramWorkerConnection;
  /** Drawings asked for and not started. */
  readonly #waiting = new Map<string, PendingDrawing>();
  /** Each picture on screen: its object address and how many images show it. */
  readonly #shown = new Map<DrawnDiagram, { readonly url: string; holders: number }>();
  readonly #cacheRelease: RendererCacheRelease;
  readonly #labelMeasurer = new LabelMeasurer();
  #drawing: PendingDrawing | undefined;
  #isDispatchQueued = false;

  /**
   * `byteCap` bounds the kept pictures and the worker's label widths together; `startWorker`
   * starts the worker on the first drawing; `freeUnusedMemory` frees the cached memory pictures on
   * screen left, once they have gone.
   */
  public constructor(
    byteCap: number,
    startWorker: DiagramWorkerStart,
    freeUnusedMemory: () => void,
  ) {
    this.#outcomes = new ByteBoundedCache<DiagramOutcome>(
      byteCap - LABEL_WIDTH_CACHE_BYTES,
      measureOutcomeBytes,
    );
    this.#connection = new DiagramWorkerConnection(startWorker, this.#labelMeasurer);
    this.#cacheRelease = new RendererCacheRelease(freeUnusedMemory);
  }

  /**
   * Warm the faces merman labels diagrams in under `palette`, in idle time, before one needs them.
   */
  public warmDefaultFaces(palette: DiagramPalette): void {
    this.#labelMeasurer.warm(defaultLabelFacesFor(palette));
  }

  /** Starts the worker ahead of a diagram on its way, so merman has loaded when it is asked. */
  public startWorker(): void {
    this.#connection.start();
  }

  /** What `source` came to under `palette`, if it has been drawn and is still kept. */
  public read(source: string, palette: DiagramPalette): DiagramOutcome | undefined {
    return this.#outcomes.get(keyOf("shown", sanitizeDiagramSource(source), palette));
  }

  /**
   * Ask for `source` under `palette` to be drawn; `listener` hears the outcome once. Among the
   * drawings waiting, the one whose nearest asking block `readingDistance` puts closest goes
   * first. Returns the withdrawal, which a block calls when it no longer needs the picture.
   */
  public request(
    source: string,
    palette: DiagramPalette,
    readingDistance: ReadingDistance,
    listener: DiagramOutcomeListener,
  ): () => void {
    const sanitizedSource = sanitizeDiagramSource(source);
    const key = keyOf("shown", sanitizedSource, palette);
    // Another block may have drawn it since this one last read.
    const kept = this.#outcomes.get(key);
    if (kept !== undefined) {
      listener(kept);
      return () => undefined;
    }
    const drawing = this.#join(key, sanitizedSource, palette, "shown");
    drawing.listeners.set(listener, readingDistance);
    return () => {
      this.#withdraw(drawing, listener);
    };
  }

  /**
   * The object address `picture` is shown at, created by the first image to show it and shared by
   * every other. The returned release lets it go; the last release revokes the address.
   */
  public showPicture(picture: DrawnDiagram): PictureShowing {
    let shown = this.#shown.get(picture);
    if (shown === undefined) {
      shown = { url: URL.createObjectURL(pictureBlobOf(picture)), holders: 0 };
      this.#shown.set(picture, shown);
      this.#cacheRelease.noteShown(measureOutcomeBytes(picture));
    }
    shown.holders += 1;
    const held = shown;
    return {
      url: held.url,
      release: () => {
        held.holders -= 1;
        if (held.holders === 0) {
          this.#shown.delete(picture);
          URL.revokeObjectURL(held.url);
          this.#cacheRelease.noteReleased(measureOutcomeBytes(picture));
        }
      },
    };
  }

  /**
   * Draw `source` under `palette` as the picture a copy paints, ahead of every waiting drawing,
   * since a person is waiting for it. It carries no HTML labels, so it never taints the canvas;
   * it is drawn for each copy and never kept.
   */
  public drawCopy(source: string, palette: DiagramPalette): Promise<DiagramOutcome> {
    const sanitizedSource = sanitizeDiagramSource(source);
    return new Promise((resolve) => {
      this.#join(
        keyOf("copied", sanitizedSource, palette),
        sanitizedSource,
        palette,
        "copied",
      ).listeners.set(resolve, () => Number.NEGATIVE_INFINITY);
    });
  }

  #join(
    key: string,
    source: string,
    palette: DiagramPalette,
    pictureKind: DiagramPictureKind,
  ): PendingDrawing {
    const joined = this.#drawing?.key === key ? this.#drawing : this.#waiting.get(key);
    if (joined !== undefined) {
      return joined;
    }
    const drawing: PendingDrawing = { key, source, palette, pictureKind, listeners: new Map() };
    this.#waiting.set(key, drawing);
    this.#queueDispatch();
    return drawing;
  }

  #withdraw(drawing: PendingDrawing, listener: DiagramOutcomeListener): void {
    drawing.listeners.delete(listener);
    if (drawing.listeners.size === 0 && this.#waiting.get(drawing.key) === drawing) {
      this.#waiting.delete(drawing.key);
    }
  }

  /**
   * Choose the next drawing once the asks made in the same turn have all arrived, so the blocks a
   * commit mounted are ordered among themselves.
   */
  #queueDispatch(): void {
    if (this.#isDispatchQueued) {
      return;
    }
    this.#isDispatchQueued = true;
    queueMicrotask(() => {
      this.#isDispatchQueued = false;
      this.#dispatchNext();
    });
  }

  #dispatchNext(): void {
    if (this.#drawing !== undefined) {
      return;
    }
    const next = this.#nearestWaiting();
    if (next === undefined) {
      return;
    }
    this.#waiting.delete(next.key);
    this.#drawing = next;
    void this.#connection
      .draw(next.source, next.palette, next.pictureKind)
      .then(({ status, outcome }) => {
        this.#drawing = undefined;
        // A drawing every asking block has left is discarded rather than kept.
        if (next.listeners.size > 0) {
          if (status === "settled" && next.pictureKind === "shown") {
            this.#outcomes.set(next.key, outcome);
          }
          for (const listener of next.listeners.keys()) {
            listener(outcome);
          }
        }
        this.#dispatchNext();
      });
  }

  #nearestWaiting(): PendingDrawing | undefined {
    let nearest: { readonly drawing: PendingDrawing; readonly distance: number } | undefined;
    for (const drawing of this.#waiting.values()) {
      const distance = Math.min(...[...drawing.listeners.values()].map((measure) => measure()));
      if (nearest === undefined || distance < nearest.distance) {
        nearest = { drawing, distance };
      }
    }
    return nearest?.drawing;
  }
}

/** `picture` as an SVG file an image can load. */
export function pictureBlobOf(picture: DrawnDiagram): Blob {
  return new Blob([picture.markup], { type: "image/svg+xml" });
}

/**
 * The app's diagram pictures, provided once by the app so every window shares one cache and one
 * worker; `undefined` outside the app, where a diagram block cannot draw.
 */
export const DiagramPicturesContext: Context<DiagramPictures | undefined> = createContext<
  DiagramPictures | undefined
>(undefined);

/**
 * Empties the renderer's caches once the pictures on screen have fallen from their height since
 * the last emptying by `CACHE_RELEASE_DROP_BYTES` and stayed down for `CACHE_RELEASE_DWELL_MS`, so
 * a scroll past a few pictures or a quick return to a session costs nothing.
 */
class RendererCacheRelease {
  readonly #freeUnusedMemory: () => void;
  /** The markup bytes of the pictures on screen, and their most since the last emptying. */
  #shownBytes = 0;
  #peakBytes = 0;
  #dwell: ReturnType<typeof setTimeout> | undefined;

  public constructor(freeUnusedMemory: () => void) {
    this.#freeUnusedMemory = freeUnusedMemory;
  }

  public noteShown(byteLength: number): void {
    this.#shownBytes += byteLength;
    this.#peakBytes = Math.max(this.#peakBytes, this.#shownBytes);
    if (!this.#hasFallen()) {
      clearTimeout(this.#dwell);
      this.#dwell = undefined;
    }
  }

  public noteReleased(byteLength: number): void {
    this.#shownBytes -= byteLength;
    if (this.#hasFallen() && this.#dwell === undefined) {
      this.#dwell = setTimeout(() => {
        this.#dwell = undefined;
        this.#peakBytes = this.#shownBytes;
        this.#freeUnusedMemory();
      }, CACHE_RELEASE_DWELL_MS);
    }
  }

  #hasFallen(): boolean {
    return this.#peakBytes - this.#shownBytes >= CACHE_RELEASE_DROP_BYTES;
  }
}

/**
 * How far the pictures on screen must fall, in markup bytes, before the caches they filled are
 * emptied: about 20 MB of caches, since 45 pictures of 750 KB of markup left 32 MB to empty.
 */
const CACHE_RELEASE_DROP_BYTES = 512 * 1024;

/**
 * How long the pictures must stay down before the emptying, in milliseconds. Memory left by gone
 * pictures stays put, so waiting longer frees nothing more, and a person back sooner keeps them.
 */
const CACHE_RELEASE_DWELL_MS = 30_000;

/** One drawing asked for: what to draw, and who is waiting with how far each is from reading. */
interface PendingDrawing {
  readonly key: string;
  readonly source: string;
  readonly palette: DiagramPalette;
  readonly pictureKind: DiagramPictureKind;
  readonly listeners: Map<DiagramOutcomeListener, ReadingDistance>;
}

/** What separates the parts of a key; it occurs in none of them once sanitized. */
const KEY_SEPARATOR = "\u0000";

/**
 * Characters a model's text can carry that change no word but would reach the parser: control
 * characters other than the tab and the line feed, and the invisible joiners and byte-order mark.
 */
const INVISIBLE_CHARACTERS = /[^\P{Cc}\t\n]|[\u200B-\u200D\u2060\uFEFF]/gu;

/** The HTML entities a model's text can carry in place of the characters the parser reads. */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

const HTML_ENTITY = /&(?:lt|gt|amp|quot|#39|apos|nbsp);/gu;

/**
 * The source as the parser should read it: line endings made line feeds, invisible characters
 * removed, HTML entities decoded once and curly quotes made straight. Nothing else changes, since
 * some diagram kinds read indentation.
 */
function sanitizeDiagramSource(source: string): string {
  return source
    .replace(/\r\n?/gu, "\n")
    .replace(INVISIBLE_CHARACTERS, "")
    .replace(HTML_ENTITY, (entity) => HTML_ENTITIES[entity] ?? entity)
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201C\u201D]/gu, '"');
}

function keyOf(
  pictureKind: DiagramPictureKind,
  sanitizedSource: string,
  palette: DiagramPalette,
): string {
  return pictureKind + KEY_SEPARATOR + palette.identity + KEY_SEPARATOR + sanitizedSource;
}

function measureOutcomeBytes(outcome: DiagramOutcome): number {
  return measureUtf8ByteLength(outcome.kind === "drawn" ? outcome.markup : outcome.reason);
}
