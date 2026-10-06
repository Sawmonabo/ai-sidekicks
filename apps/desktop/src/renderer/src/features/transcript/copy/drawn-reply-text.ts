// What each reply row has drawn, kept while the window holds the row. A reply's foot reads its
// other rows' text from here once that text is gone from where it came: a live lane the engine
// retired at the turn's end, or a held body whose row was scrolled out of the window's range and
// unmounted. So the foot, its time and its Copy stay for the rest of the turn, and the Copy takes
// every row the reply drew.

import { Emitter } from "#renderer/lib/emitter.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { outputKindOf } from "../rows/bodies/output-kinds.js";
import { type CopyFlavor } from "./conversation-selection.js";

/** One reply row's drawn text and the flavor it copies as. */
export interface DrawnRowText {
  readonly text: string;
  readonly flavor: CopyFlavor;
}

/**
 * The text each reply row has drawn, by row id, for as long as the window holds the row.
 * Subscribers hear only when a row gains or loses its record or changes flavor: a foot draws
 * from those, and reads the text itself only when Copy is pressed.
 */
export class DrawnReplyText {
  readonly #drawnByRowId = new Map<string, DrawnRowText>();
  readonly #changes = new Emitter<void>("drawn reply text change");
  #revision = 0;

  /** Bumped on every change a subscriber hears, so a React read can compare it. */
  public get revision(): number {
    return this.#revision;
  }

  /** Records what one reply row drew; an empty text records nothing. */
  public note(rowId: string, drawn: DrawnRowText): void {
    if (drawn.text === "") {
      return;
    }
    const before = this.#drawnByRowId.get(rowId);
    this.#drawnByRowId.set(rowId, drawn);
    if (before?.flavor !== drawn.flavor) {
      this.#announceChange();
    }
  }

  /** What the row last drew, or `undefined` for a row that has drawn no text. */
  public drawnTextOf(rowId: string): DrawnRowText | undefined {
    return this.#drawnByRowId.get(rowId);
  }

  /** Drops every row the window no longer holds, so the record never outgrows the window. */
  public forgetRowsOutside(isHeld: (rowId: string) => boolean): void {
    let forgotAny = false;
    for (const rowId of this.#drawnByRowId.keys()) {
      if (!isHeld(rowId)) {
        this.#drawnByRowId.delete(rowId);
        forgotAny = true;
      }
    }
    if (forgotAny) {
      this.#announceChange();
    }
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  #announceChange(): void {
    this.#revision += 1;
    this.#changes.emit();
  }
}

/**
 * How a reply's text copies: as markdown when it is drawn as prose, as plain text otherwise.
 * `declaredMediaType` is the producer's `contentType`, absent for a row whose payload is not read.
 */
export function replyCopyFlavorOf(
  text: string,
  declaredMediaType?: string | undefined,
): CopyFlavor {
  return outputKindOf(text, declaredMediaType) === "prose" ? "markdown" : "text";
}
