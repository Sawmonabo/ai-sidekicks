// Which row the reader is looking at, read from measurements the library already holds so no
// element is touched on the scroll path.
//
// Row keys and the virtualizer change after construction, so they are read through the
// controller's accessors; copies would be a second record of the window's rows. Whether a reader
// is following is `reading-anchor.ts`'s call, and whether a glide is in flight is
// `scroll-chokepoint.ts`'s.

import { type ScrollGeometry } from "../scroll/geometry-sample.js";
import { type ReadingAnchor } from "../scroll/reading-anchor.js";
import { type RowMeasurementTable } from "./row-measurement-table.js";
import { type ScrollController } from "../scroll/scroll-chokepoint.js";
import { type TranscriptRowVirtualizer } from "./virtualizer-options.js";

/** Dependencies of a `ViewportAnchorCapture`; the two accessors are read on every call. */
export interface ViewportAnchorCaptureOptions {
  readonly anchor: ReadingAnchor;
  readonly scroll: ScrollController;
  readonly measurements: RowMeasurementTable;
  /** The window's current keys, in order. Read per call — they move every reconcile. */
  readonly rowKeys: () => readonly string[];
  /** The bound virtualizer, or `undefined` before one is bound. */
  readonly virtualizer: () => TranscriptRowVirtualizer | undefined;
}

/** Captures the reader's anchor row from library measurements, without touching an element. */
export class ViewportAnchorCapture {
  readonly #anchor: ReadingAnchor;
  readonly #scroll: ScrollController;
  readonly #measurements: RowMeasurementTable;
  readonly #rowKeys: () => readonly string[];
  readonly #virtualizer: () => TranscriptRowVirtualizer | undefined;

  public constructor(options: ViewportAnchorCaptureOptions) {
    this.#anchor = options.anchor;
    this.#scroll = options.scroll;
    this.#measurements = options.measurements;
    this.#rowKeys = options.rowKeys;
    this.#virtualizer = options.virtualizer;
  }

  /** Where a row's top edge sits, from the library's measurements; no element is read. */
  public offsetOfIndex(index: number): number {
    const offsetForIndex = this.#virtualizer()?.getOffsetForIndex(index, "start");
    if (offsetForIndex !== undefined) {
      return offsetForIndex[0];
    }
    // Before the virtualizer mounts there are no measurements, so the ledger's priors answer.
    const rowKeys = this.#rowKeys();
    let offset = 0;
    for (let cursor = 0; cursor < index; cursor += 1) {
      offset += this.#measurements.heightOf(rowKeys[cursor] ?? "");
    }
    return offset;
  }

  /**
   * Records which row the reader is looking at and how far down the viewport it sits, from the
   * library's measurements rather than the DOM.
   */
  public captureFrom(geometry: ScrollGeometry): void {
    const rowKeys = this.#rowKeys();
    if (geometry.isAtTail || rowKeys.length === 0) {
      return;
    }
    if (this.#scroll.vetoesPrune()) {
      // This sample was published from inside a programmatic glide, so it reports where the
      // transcript put the reader. Anchoring to it would discard the position the glide
      // preserved and, since an anchor change re-renders and can glide again, loop without
      // settling. Only the reader's own scroll moves the anchor.
      return;
    }
    const topItem = this.#virtualizer()?.getVirtualItemForOffset(geometry.scrollTop);
    const index = topItem?.index ?? 0;
    const rowKey = rowKeys[index];
    if (rowKey === undefined) {
      return;
    }
    this.#anchor.capture({
      rowKey,
      offsetWithinViewportPx: (topItem?.start ?? this.offsetOfIndex(index)) - geometry.scrollTop,
    });
  }
}
