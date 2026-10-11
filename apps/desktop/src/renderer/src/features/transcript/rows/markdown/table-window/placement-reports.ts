// The changes a markdown body tells its long tables of, and the observation of the body's size
// behind its layouts. A table subscribes in an effect that can run a frame after it read the body,
// so a layout made in between is told again in the body's next report, before it paints.

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import { type TablePlacementChange } from "./context.js";

/**
 * A body's element, observed for its size, and the tables told of each change that may move
 * them.
 */
export class TablePlacementReports {
  readonly #changes: Emitter<TablePlacementChange>;
  readonly #onLaidOut: (element: HTMLElement, entry: ResizeObserverEntry | undefined) => void;
  #element: HTMLElement | undefined;
  #stopObserving: Unsubscribe | undefined;
  /** How many times the body was laid out anew, so a table can tell a layout made since it read. */
  #layoutCount = 0;
  /** Whether a table subscribed after a layout it missed, and is owed the body's next report. */
  #isReplayOwed = false;

  /**
   * `describeWhat` names the changes in a listener's failure; `onLaidOut` is called with the
   * element and the observation's entry each time the body is laid out anew.
   */
  public constructor(
    describeWhat: string,
    onLaidOut: (element: HTMLElement, entry: ResizeObserverEntry | undefined) => void,
  ) {
    this.#changes = new Emitter(describeWhat);
    this.#onLaidOut = onLaidOut;
  }

  /** The body's element, or `undefined` before it mounts. */
  public get element(): HTMLElement | undefined {
    return this.#element;
  }

  /** How many times the body was laid out anew; a table notes it when it reads the body. */
  public get layoutCount(): number {
    return this.#layoutCount;
  }

  /** Whether any table listens, so the body can leave a read only a table needs until asked. */
  public get hasListeners(): boolean {
    return this.#changes.hasSinks;
  }

  /** Observes `element` for every change of its size, or stops observing on `null`. */
  public attach(element: HTMLElement | null): void {
    this.#stopObserving?.();
    this.#stopObserving = undefined;
    this.#element = element ?? undefined;
    if (element !== null) {
      this.#observe(element);
    }
  }

  /**
   * Hears each change that may move the body's tables. Where the body was laid out since the table
   * read it at `seenLayoutCount`, the body is observed anew, so its next report, before the next
   * paint, tells this table of it.
   */
  public subscribe(
    listener: (change: TablePlacementChange) => void,
    seenLayoutCount: number,
  ): Unsubscribe {
    const unsubscribe = this.#changes.subscribe(listener);
    // A fresh observation reports the body's size in the next frame, before it paints; telling the
    // table here would redraw it from inside the effect that subscribes, where React defers it.
    if (seenLayoutCount !== this.#layoutCount && this.#element !== undefined) {
      this.#isReplayOwed = true;
      this.#observe(this.#element);
    }
    return unsubscribe;
  }

  /** Tells every listening table of `change`, counting a layout. */
  public announce(change: TablePlacementChange): void {
    if (change === "laid-out") {
      this.#layoutCount += 1;
      this.#isReplayOwed = false;
    }
    this.#changes.emit(change);
  }

  #observe(element: HTMLElement): void {
    this.#stopObserving?.();
    this.#stopObserving = observeElementResize(element, (entries) => {
      this.#onLaidOut(element, entries.at(-1));
      // A body that reads only a change of its type announces none for this report; the replay
      // is no new layout, so it leaves the count.
      if (this.#isReplayOwed) {
        this.#isReplayOwed = false;
        this.#changes.emit("laid-out");
      }
    });
  }
}
