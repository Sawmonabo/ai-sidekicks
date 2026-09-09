// The preview card's grace, and the card it opens.
//
// Its own module beside the component for the reason the rail's model is: this is a
// timer with a lifetime, and a component's render body is the one place a lifetime
// cannot live. The class holds exactly one armed handle, so a pointer crossing the
// rail arms and cancels rather than opening a card per tick, and the component's
// unmount has exactly one thing to cancel.
//
// The rail's "no debounce on the READ" is why the tick is captured at `open` time and
// not re-read when the timeout fires: the summary a card shows is the one carried on
// the tick the pointer was over, not whatever is under the pointer a grace later.

import { type ConsoleClock } from "../../../core/index.js";
import { type RailTick } from "./rail-model.js";
import { RAIL_PREVIEW_GRACE_MS } from "../structure-bounds.js";

/** The one preview card open at a time, or none. */
export interface RailPreview {
  readonly tick: RailTick;
  readonly offsetFraction: number;
}

/**
 * The grace before a preview card opens.
 */
export class PreviewGrace {
  readonly #clock: ConsoleClock;
  #armedHandle: number | undefined;

  public constructor(clock: ConsoleClock) {
    this.#clock = clock;
  }

  public open(
    tick: RailTick | undefined,
    offsetFraction: number,
    show: (preview: RailPreview | undefined) => void,
  ): void {
    this.#cancel();
    if (tick === undefined) {
      show(undefined);
      return;
    }
    this.#armedHandle = this.#clock.scheduleTimeout(() => {
      this.#armedHandle = undefined;
      show({ tick, offsetFraction });
    }, RAIL_PREVIEW_GRACE_MS);
  }

  public close(show: (preview: RailPreview | undefined) => void): void {
    this.#cancel();
    show(undefined);
  }

  public dispose(): void {
    this.#cancel();
  }

  #cancel(): void {
    if (this.#armedHandle !== undefined) {
      this.#clock.cancel(this.#armedHandle);
      this.#armedHandle = undefined;
    }
  }
}
