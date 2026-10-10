// When the reader's selection in one viewport settles: at the release of the press, of the pointer
// or of a key, that changed it, so a drag or a held shift-arrow's repeats settle once, as the
// reader lets go. A key press is told by its `code` and starts at its first keydown, so the
// shift held under an arrow is no press of its own. A change no press made, such as the Edit
// menu's Select All, settles at once.

import type { Unsubscribe } from "#shared/preload-api.js";

/**
 * The settle points of one viewport's selection, for listeners that act once per selection the
 * reader makes rather than at each change.
 */
export class SelectionSettling {
  readonly #listeners = new Set<() => void>();
  /** Whether the viewport holds a selection, which a settle point reports only while it does. */
  readonly #hasSelection: () => boolean;
  #press: Press | undefined;

  public constructor(hasSelection: () => boolean) {
    this.#hasSelection = hasSelection;
  }

  /** Hears the reader's presses on `ownerDocument` until `options.signal` aborts. */
  public attach(ownerDocument: Document, options: AddEventListenerOptions): void {
    ownerDocument.addEventListener(
      "pointerdown",
      (event) => {
        this.#startPress(event.button === 0 ? { key: undefined, hasSelected: false } : undefined);
      },
      options,
    );
    ownerDocument.addEventListener(
      "pointerup",
      () => {
        this.#releasePress(undefined);
      },
      options,
    );
    ownerDocument.addEventListener(
      "pointercancel",
      () => {
        if (this.#press?.key === undefined) {
          this.#press = undefined;
        }
      },
      options,
    );
    ownerDocument.addEventListener(
      "keydown",
      (event) => {
        if (!event.repeat) {
          this.#startPress({ key: event.code, hasSelected: false });
        }
      },
      options,
    );
    ownerDocument.addEventListener(
      "keyup",
      (event) => {
        this.#releasePress(event.code);
      },
      options,
    );
  }

  /** Calls `listener` once each time the selection settles while the viewport holds one. */
  public subscribe(listener: () => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The selection changed: it settles at the held press's release, or now with none held. */
  public noteSelected(): void {
    if (this.#press === undefined) {
      this.#settle();
      return;
    }
    this.#press.hasSelected = true;
  }

  /** A new press: the one it replaces settles first, if it changed the selection. */
  #startPress(press: Press | undefined): void {
    this.#releasePress(this.#press?.key);
    this.#press = press;
  }

  #releasePress(key: string | undefined): void {
    const press = this.#press;
    if (press === undefined || press.key !== key) {
      return;
    }
    this.#press = undefined;
    if (press.hasSelected) {
      this.#settle();
    }
  }

  #settle(): void {
    if (!this.#hasSelection()) {
      return;
    }
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/** A press the reader holds: the key's `code`, or `undefined` for the pointer's main button. */
interface Press {
  readonly key: string | undefined;
  hasSelected: boolean;
}
