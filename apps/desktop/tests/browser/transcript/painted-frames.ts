// Reading a list's layout in each frame exactly as that frame paints it, for the browser tier.
//
// The read runs in the frame's resize observation, after the list's: observers are told in the
// order they were made, the list's was made when its first row mounted, before this reader, and
// the list moves the rows below a resized row in its own callback. A probe element resized each
// frame gives this reader a turn every frame. A callback that resizes a row starts another pass in
// the same frame, where only deeper elements are told, so the reader watches the listed rows too:
// every pass that resizes a row ends with this read, after the list's. A reader made before the
// list has drawn a row, as a feed whose first rows still wait on their parse is, makes its observer
// again once the first row mounts, so it is still told after the list. The frame's last read is the
// layout it paints, handed on once the next frame begins. A state a task commits after one paint
// and the next frame's observation corrects is never painted, so it is never read.

/**
 * Calls `read` in every frame's resize observation, after the list's, and hands `onPainted` the
 * last value each frame read once that frame is painted. Rows matching `rowSelector` are watched
 * as they mount; a reader made before the list's first row makes its observer again when it does.
 */
export class PaintedFrameReader<Value> {
  readonly #probe: HTMLElement;
  readonly #read: () => Value;
  #observer: ResizeObserver;
  /** Whether the observer was made once a row was listed, after the list's own. */
  #isAfterList = false;
  readonly #listing: MutationObserver;
  readonly #observedRows = new WeakSet<Element>();
  readonly #rowSelector: string;
  readonly #onPainted: (value: Value) => void;
  /** The frame's latest read, until the frame is painted. */
  #frameValue: { readonly value: Value } | undefined;
  #isWatching = true;

  public constructor(rowSelector: string, read: () => Value, onPainted: (value: Value) => void) {
    this.#rowSelector = rowSelector;
    this.#read = read;
    this.#onPainted = onPainted;
    this.#probe = document.createElement("div");
    this.#probe.style.cssText = "position: fixed; top: 0; left: 0; width: 1px; height: 1px;";
    document.body.append(this.#probe);
    this.#observer = this.#makeObserver();
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

  /** An observer told after every one made before it, watching the probe. */
  #makeObserver(): ResizeObserver {
    const observer = new ResizeObserver(() => {
      this.#frameValue = { value: this.#read() };
    });
    observer.observe(this.#probe);
    return observer;
  }

  #observeListedRows(): void {
    const rows = document.querySelectorAll(this.#rowSelector);
    // The list makes its observer as its first row mounts, which a listing observation follows.
    if (!this.#isAfterList && rows.length > 0) {
      this.#isAfterList = true;
      this.#observer.disconnect();
      this.#observer = this.#makeObserver();
    }
    for (const row of rows) {
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
