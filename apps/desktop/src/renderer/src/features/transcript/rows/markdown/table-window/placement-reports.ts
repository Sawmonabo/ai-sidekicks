// The changes a markdown body tells its long tables of, and the observation of the body's size
// behind its layouts. A table subscribes in an effect that can run a frame after the body's first
// layout, so a layout no table heard is told again in the body's next report, before it paints.

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
  /** Whether the body was laid out anew while no table listened, and no table has heard of it. */
  #isLayoutUnheard = false;

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
   * Hears each change that may move the body's tables. Where a layout went unheard, the body is
   * observed anew, so its next report, before the next paint, tells this table of it.
   */
  public subscribe(listener: (change: TablePlacementChange) => void): Unsubscribe {
    const unsubscribe = this.#changes.subscribe(listener);
    // A fresh observation reports the body's size in the next frame, before it paints; telling the
    // table here would redraw it from inside the effect that subscribes, where React defers it.
    if (this.#isLayoutUnheard && this.#element !== undefined) {
      this.#observe(this.#element);
    }
    return unsubscribe;
  }

  /** Tells every listening table of `change`, noting a layout none heard. */
  public announce(change: TablePlacementChange): void {
    if (change === "laid-out") {
      this.#isLayoutUnheard = !this.#changes.hasSinks;
    }
    this.#changes.emit(change);
  }

  #observe(element: HTMLElement): void {
    this.#stopObserving?.();
    this.#stopObserving = observeElementResize(element, (entries) => {
      this.#onLaidOut(element, entries.at(-1));
      // A body that reads only a change of its type announces none for this report.
      if (this.#isLayoutUnheard && this.#changes.hasSinks) {
        this.announce("laid-out");
      }
    });
  }
}
