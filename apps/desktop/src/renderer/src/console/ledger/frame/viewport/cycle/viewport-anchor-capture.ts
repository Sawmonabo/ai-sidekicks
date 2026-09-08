// Which row the reader is looking at, read from measurements the library already holds.
//
// SPLIT FROM `viewport-controller.ts` on the seam its own two doc comments already
// state: every read here is affordable ON THE SCROLL PATH, because none of it touches
// an element. That is one property over two methods — where a row's top edge sits, and
// which row the top of the viewport is showing — and it is the reason the anchor is
// captured from a geometry sample rather than from a rect.
//
// WHY IT TAKES ITS MOVING INPUTS AS CALLS. The row keys change every reconcile and the
// virtualizer is bound after construction, so this object reads both through the
// accessors the controller supplies — the same shape `viewport-deferred-hold.ts` takes
// for the same reason. Holding copies would make this a second record of which rows the
// window holds, and the window is the one that decides.
//
// WHAT IT DOES NOT DECIDE. Not whether a reader is following (`reading-anchor.ts`), not
// whether a glide is in flight (`scroll-chokepoint.ts` answers that and this obeys it),
// and not what the tree is told afterwards — the controller publishes.

import {
  type LedgerGeometry,
  type ReadingAnchor,
  type RowMeasurementLedger,
} from "../../measurement/index.js";
import { type LedgerScrollController } from "../../scroll/index.js";
import { type LedgerRowVirtualizer } from "../surface/virtualizer-seams.js";

export interface LedgerAnchorCaptureOptions {
  readonly anchor: ReadingAnchor;
  readonly scroll: LedgerScrollController;
  readonly measurements: RowMeasurementLedger;
  /** The window's current keys, in order. Read per call — they move every reconcile. */
  readonly rowKeys: () => readonly string[];
  /** The bound virtualizer, or `undefined` before one is bound. */
  readonly virtualizer: () => LedgerRowVirtualizer | undefined;
}

export class LedgerAnchorCapture {
  readonly #anchor: ReadingAnchor;
  readonly #scroll: LedgerScrollController;
  readonly #measurements: RowMeasurementLedger;
  readonly #rowKeys: () => readonly string[];
  readonly #virtualizer: () => LedgerRowVirtualizer | undefined;

  public constructor(options: LedgerAnchorCaptureOptions) {
    this.#anchor = options.anchor;
    this.#scroll = options.scroll;
    this.#measurements = options.measurements;
    this.#rowKeys = options.rowKeys;
    this.#virtualizer = options.virtualizer;
  }

  /**
   * Where a row's top edge sits, from measurements the library already holds.
   *
   * No element is read, so this is affordable on the scroll path — which is the
   * whole reason the anchor is captured from here rather than from a rect.
   */
  public offsetOfIndex(index: number): number {
    const offsetForIndex = this.#virtualizer()?.getOffsetForIndex(index, "start");
    if (offsetForIndex !== undefined) {
      return offsetForIndex[0];
    }
    // Before the virtualizer has mounted there are no measurements to read, so the
    // ledger answers from its own priors rather than pretending the offset is zero.
    const rowKeys = this.#rowKeys();
    let offset = 0;
    for (let cursor = 0; cursor < index; cursor += 1) {
      offset += this.#measurements.heightOf(rowKeys[cursor] ?? "");
    }
    return offset;
  }

  /**
   * Which row the reader is looking at, and how far down the viewport it sits.
   *
   * Read from the library's measurements rather than from the DOM: no element is
   * touched, so this is affordable on the scroll path.
   */
  public captureFrom(geometry: LedgerGeometry): void {
    const rowKeys = this.#rowKeys();
    if (geometry.isAtTail || rowKeys.length === 0) {
      return;
    }
    if (this.#scroll.vetoesPrune()) {
      // This sample was published from INSIDE a programmatic glide, so it reports
      // where the ledger just put the reader rather than where the reader went. Two
      // reasons not to anchor to it, and either alone is sufficient: it would discard
      // the very position the glide was performed to preserve, and — because an
      // anchor change notifies the tree, and a render re-runs the virtualizer's
      // layout effects, which can glide again — it closes a loop that does not
      // settle. Only a scroll the READER performed moves the anchor.
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
