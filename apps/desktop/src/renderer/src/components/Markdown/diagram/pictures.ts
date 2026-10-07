// The pictures every diagram block shares: what each source came to under each palette, held in a
// byte-bounded cache, and a queue that draws one missing picture at a time, in the idle time of the
// window that shows it. The drawing library loads on the first drawing, as a chunk of its own.
//
// A drawing cannot be split: once its diagram kind has loaded, the library parses and lays out in
// one task. So a drawing starts only in an idle period long enough that no frame is due inside it,
// which the browser grants only while nothing is waiting to be drawn; while a reply streams, frames
// keep every idle period short and the drawing waits for the stream to pause. A frame asked for
// after a drawing starts, such as the next streamed text, waits for that one drawing to end.

import type { Mermaid } from "mermaid";

import { describeFailure } from "#shared/failure-message.js";
import { ByteBoundedCache } from "#renderer/lib/byte-bounded-cache.js";
import { measureUtf8ByteLength } from "#renderer/lib/utf8-byte-length.js";
import { drawDiagram, type DiagramOutcome } from "./drawing.js";
import type { DiagramPalette } from "./palette.js";

/**
 * The shortest idle period a drawing starts in, in milliseconds. Longer than a frame at 30 Hz or
 * faster, so a period this long is one the browser grants with no frame due: inside a run of
 * frames it grants only what is left of the current one.
 */
const LONG_IDLE_PERIOD_MS = 34;

/**
 * Bytes of drawn pictures kept across every block. A picture's image address measured 6 to 47 KB,
 * 22 KB at the median, for ten common diagram kinds at the reading size, so this keeps about 190:
 * every diagram a long session draws, in both schemes, so scrolling back or switching the scheme
 * back redraws nothing.
 */
const DIAGRAM_PICTURE_CACHE_BYTE_CAP = 4_194_304;

/** What separates the palette from the source in a key; it occurs in neither once sanitized. */
const KEY_SEPARATOR = "\u0000";

/**
 * Characters a model's text can carry that change no word but would reach the parser: control
 * characters other than the tab and the line feed, and the invisible joiners and byte-order mark.
 */
const INVISIBLE_CHARACTERS = /[^\P{Cc}\t\n]|[\u200B-\u200D\u2060\uFEFF]/gu;

/** The window whose idle time a drawing waits for: the one that shows the diagram. */
type IdleWindow = Pick<Window, "requestIdleCallback" | "cancelIdleCallback">;

/** Hears what one requested drawing came to. */
type DiagramOutcomeListener = (outcome: DiagramOutcome) => void;

/** One drawing asked for: what to draw, where to wait for idle time, and who is waiting. */
interface PendingDrawing {
  readonly key: string;
  readonly source: string;
  readonly palette: DiagramPalette;
  readonly idleWindow: IdleWindow;
  readonly listeners: Set<DiagramOutcomeListener>;
}

/**
 * The cache and the drawing queue. One drawing runs at a time; asks for a key already waiting or
 * being drawn join it; an ask withdrawn by every block that made it leaves the queue.
 */
class DiagramPictures {
  readonly #outcomes = new ByteBoundedCache<DiagramOutcome>(
    DIAGRAM_PICTURE_CACHE_BYTE_CAP,
    measureOutcomeBytes,
  );
  /** Drawings asked for and not started, oldest first. */
  readonly #waiting = new Map<string, PendingDrawing>();
  #drawing: PendingDrawing | undefined;
  /** The idle callback armed for the oldest waiting drawing. */
  #armedIdle: { readonly drawing: PendingDrawing; readonly handle: number } | undefined;
  #renderCount = 0;

  /** What `source` came to under `palette`, if it has been drawn and is still kept. */
  public read(source: string, palette: DiagramPalette): DiagramOutcome | undefined {
    return this.#outcomes.get(keyOf(sanitizeDiagramSource(source), palette));
  }

  /**
   * Ask for `source` under `palette` to be drawn in `idleWindow`'s idle time; `listener` hears the
   * outcome once. Returns the withdrawal, which a block calls when it no longer needs the picture.
   */
  public request(
    source: string,
    palette: DiagramPalette,
    idleWindow: IdleWindow,
    listener: DiagramOutcomeListener,
  ): () => void {
    const sanitizedSource = sanitizeDiagramSource(source);
    const key = keyOf(sanitizedSource, palette);
    // Another block may have drawn it since this one last read.
    const kept = this.#outcomes.get(key);
    if (kept !== undefined) {
      listener(kept);
      return () => undefined;
    }
    const joined = this.#drawing?.key === key ? this.#drawing : this.#waiting.get(key);
    const drawing = joined ?? {
      key,
      source: sanitizedSource,
      palette,
      idleWindow,
      listeners: new Set<DiagramOutcomeListener>(),
    };
    drawing.listeners.add(listener);
    if (joined === undefined) {
      this.#waiting.set(key, drawing);
      this.#armNext();
    }
    return () => {
      this.#withdraw(drawing, listener);
    };
  }

  #withdraw(drawing: PendingDrawing, listener: DiagramOutcomeListener): void {
    drawing.listeners.delete(listener);
    if (drawing.listeners.size > 0 || this.#waiting.get(drawing.key) !== drawing) {
      return;
    }
    this.#waiting.delete(drawing.key);
    if (this.#armedIdle?.drawing === drawing) {
      drawing.idleWindow.cancelIdleCallback(this.#armedIdle.handle);
      this.#armedIdle = undefined;
      this.#armNext();
    }
  }

  #armNext(): void {
    if (this.#drawing !== undefined || this.#armedIdle !== undefined) {
      return;
    }
    const [next] = this.#waiting.values();
    if (next === undefined) {
      return;
    }
    const handle = next.idleWindow.requestIdleCallback((deadline) => {
      this.#armedIdle = undefined;
      if (deadline.timeRemaining() < LONG_IDLE_PERIOD_MS) {
        // Asked from inside an idle period, the next callback waits for the next period.
        this.#armNext();
        return;
      }
      void this.#draw(next);
    });
    this.#armedIdle = { drawing: next, handle };
  }

  async #draw(drawing: PendingDrawing): Promise<void> {
    this.#waiting.delete(drawing.key);
    this.#drawing = drawing;
    const outcome = await this.#drawOutcome(drawing);
    this.#drawing = undefined;
    for (const listener of drawing.listeners) {
      listener(outcome);
    }
    this.#armNext();
  }

  /** The outcome, kept unless the library itself failed to load, which a later ask retries. */
  async #drawOutcome(drawing: PendingDrawing): Promise<DiagramOutcome> {
    let mermaid: Mermaid;
    try {
      mermaid = (await import("mermaid")).default;
    } catch (error) {
      return {
        kind: "failed",
        reason: `The diagram library did not load: ${describeFailure(error)}`,
      };
    }
    this.#renderCount += 1;
    const outcome = await drawDiagram(
      mermaid,
      drawing.source,
      drawing.palette,
      `meridian-diagram-${String(this.#renderCount)}`,
    );
    this.#outcomes.set(drawing.key, outcome);
    return outcome;
  }
}

/** The pictures every diagram block reads and asks for. */
export const diagramPictures: DiagramPictures = new DiagramPictures();

/**
 * The source as the parser should read it: line endings made line feeds and invisible characters
 * removed. Nothing else changes, since some diagram kinds read indentation.
 */
function sanitizeDiagramSource(source: string): string {
  return source.replace(/\r\n?/gu, "\n").replace(INVISIBLE_CHARACTERS, "");
}

function keyOf(sanitizedSource: string, palette: DiagramPalette): string {
  return palette.identity + KEY_SEPARATOR + sanitizedSource;
}

function measureOutcomeBytes(outcome: DiagramOutcome): number {
  return outcome.kind === "drawn"
    ? outcome.pictureUrl.length
    : measureUtf8ByteLength(outcome.reason);
}
