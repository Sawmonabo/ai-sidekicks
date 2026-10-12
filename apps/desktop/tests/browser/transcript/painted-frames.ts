// Reading a list's layout in each frame exactly as that frame paints it, for the browser tier.
//
// The read runs in the frame's resize observation, after the list's: observers are told in the
// order they were made, the list's was made when its first row mounted, before this reader, and
// the list moves the rows below a resized row in its own callback. A probe element resized each
// frame gives this reader a turn every frame. A callback that resizes a row starts another pass in
// the same frame, where only deeper elements are told, so the reader watches the listed rows too:
// every pass that resizes a row ends with this read, after the list's. The frame's last read is the
// layout it paints, handed on once the next frame begins. A state a task commits after one paint
// and the next frame's observation corrects is never painted, so it is never read.

/**
 * Calls `read` in every frame's resize observation, after the list's, and hands `onPainted` the
 * last value each frame read once that frame is painted. Rows matching `rowSelector` are watched
 * as they mount. Must be made after the list has drawn its first row.
 */
export class PaintedFrameReader<Value> {
  readonly #probe: HTMLElement;
  readonly #observer: ResizeObserver;
  readonly #listing: MutationObserver;
  readonly #observedRows = new WeakSet<Element>();
  readonly #rowSelector: string;
  readonly #onPainted: (value: Value) => void;
  /** The frame's latest read, until the frame is painted. */
  #frameValue: { readonly value: Value } | undefined;
  #isWatching = true;

  public constructor(rowSelector: string, read: () => Value, onPainted: (value: Value) => void) {
    this.#rowSelector = rowSelector;
    this.#onPainted = onPainted;
    this.#probe = document.createElement("div");
    this.#probe.style.cssText = "position: fixed; top: 0; left: 0; width: 1px; height: 1px;";
    document.body.append(this.#probe);
    this.#observer = new ResizeObserver(() => {
      this.#frameValue = { value: read() };
    });
    this.#observer.observe(this.#probe);
    this.#listing = new MutationObserver(() => {
      this.#observeListedRows();
    });
    this.#listing.observe(document.body, { childList: true, subtree: true });
    this.#observeListedRows();
    const onFrame = (): void => {
      this.#handOnPaintedFrame();
      if (!this.#isWatching) {
        return;
      }
      this.#probe.style.width = this.#probe.style.width === "1px" ? "2px" : "1px";
      requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);
  }

  /** Stops reading, handing on the last frame's read first. */
  public stop(): void {
    this.#isWatching = false;
    this.#handOnPaintedFrame();
    this.#observer.disconnect();
    this.#listing.disconnect();
    this.#probe.remove();
  }

  #observeListedRows(): void {
    for (const row of document.querySelectorAll(this.#rowSelector)) {
      if (!this.#observedRows.has(row)) {
        this.#observedRows.add(row);
        this.#observer.observe(row);
      }
    }
  }

  #handOnPaintedFrame(): void {
    if (this.#frameValue !== undefined) {
      this.#onPainted(this.#frameValue.value);
    }
    this.#frameValue = undefined;
  }
}
