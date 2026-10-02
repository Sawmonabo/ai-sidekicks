// What one session's transcript viewport is showing, and the registry that carries the reading from
// the transcript feature down to `services/session-events/session-event-subscriber.ts`.
//
// It sits in `lib/` because the producer (the transcript feature) is above the consumer (a
// service) in the import layering, so the consumer cannot import it. A mount registers a function,
// not a value: the figures are scroll geometry that the transcript keeps off its React snapshot to
// avoid notifying the tree on every scrolled pixel, so the reading is taken when someone asks.
//
// Last writer wins, and an unregister is identity-checked: a route change remounts a pane before
// React runs the outgoing mount's cleanup, and a blind delete would remove the incoming reader.

import { type Unsubscribe } from "./emitter.js";

/**
 * What a transcript viewport is showing for one session, at one instant. Each figure reads one
 * thing, because a windowed transcript showing nothing can mean an unmeasured viewport, rows the
 * view could not index, a sizer without the log's height, or an empty log. Read together they are
 * equations: `virtualItemCount` = `mountedRowCount`, `totalContentHeightPx` =
 * `viewportScrollHeightPx`, `totalRowCount` = `indexableRowCount`, and `viewportClientHeightPx` =
 * `rangedAgainstClientHeightPx`. A break in one names its defect.
 */
export interface TranscriptWindowReading {
  /** Rows the virtualizer INTENDS on screen: `getVirtualItems().length`. */
  readonly virtualItemCount: number;
  /**
   * Rows actually in the document under the scroll container, counted by the index attribute the
   * virtualizer resolves elements through. The view renders nothing for a virtual item it cannot
   * index, so a window can intend seven rows and mount none.
   */
  readonly mountedRowCount: number;
  /** Rows the window holds and could mount: the virtualizer's own `count`. */
  readonly totalRowCount: number;
  /** Rows the VIEW can index — the published snapshot's own row array length. */
  readonly indexableRowCount: number;
  /**
   * How many rows the box itself intersects, without overscan. Zero before any measurement, since
   * the virtualizer's range is `null` until a pass has run over a box with non-zero size.
   */
  readonly visibleRowCount: number;
  /**
   * The height the log occupies: the virtualizer's `getTotalSize()`. The library writes it to the
   * sizer's inline height under `directDomUpdates`, so against `viewportScrollHeightPx` it says
   * whether the scrollbar describes the log.
   */
  readonly totalContentHeightPx: number;
  /** The scroll element's `clientHeight` — the box the virtualizer ranges against. */
  readonly viewportClientHeightPx: number;
  /** The scroll element's `scrollHeight` — what the browser thinks it contains. */
  readonly viewportScrollHeightPx: number;
  /**
   * The viewport height the virtualizer ranges against: the last published geometry sample, the
   * only box the library sees. It sits beside `viewportClientHeightPx` because a reading taken
   * from the sample alone always agrees with the window; measured once, the sample said 32 px
   * while the element was 149 px. The gap means the sample is stale, which `publishOnResize` in
   * `features/transcript/viewport/overflow-measurement-batch.ts` closes by republishing on resize.
   */
  readonly rangedAgainstClientHeightPx: number;
}

/** One mounted viewport's live answer. Called by a reader, never by the transcript. */
export type TranscriptWindowReader = () => TranscriptWindowReading;

/** Which session's transcript can be read right now. */
export class TranscriptWindowDiagnosticsRegistry {
  readonly #readerBySessionId = new Map<string, TranscriptWindowReader>();

  /**
   * Publishes one mount's reader and returns the way to retire it. The returned function removes
   * this reader, not whichever is current, so a remount that registered first keeps its own.
   */
  public register(sessionId: string, reader: TranscriptWindowReader): Unsubscribe {
    this.#readerBySessionId.set(sessionId, reader);
    return () => {
      if (this.#readerBySessionId.get(sessionId) === reader) {
        this.#readerBySessionId.delete(sessionId);
      }
    };
  }

  /** This session's transcript window, or `null` where no viewport is mounted for it. */
  public readingFor(sessionId: string): TranscriptWindowReading | null {
    return this.#readerBySessionId.get(sessionId)?.() ?? null;
  }
}

/** The app's registry, one per renderer process. */
export const transcriptWindowDiagnostics: TranscriptWindowDiagnosticsRegistry =
  new TranscriptWindowDiagnosticsRegistry();
