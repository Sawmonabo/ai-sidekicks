// Where a command with no view of its own states a refusal. Commands are contributed at
// composition time, so they cannot close over the window's banner; the mounted window
// publishes its banner sink here.

import type { Unsubscribe } from "@shared/preload-api.js";
import { RefusalError, type Refusal } from "@renderer/lib/refusal/refusal.js";

/** Publishes this window's refusal rendering; only the window calls it. */
export function publishCommandRefusalSink(sink: (refusal: Refusal) => void): Unsubscribe {
  return commandRefusals.publish(sink);
}

/**
 * States a refusal from a command with no view of its own. Throws the refusal as a
 * `RefusalError` when no window has published a sink, since a command runs only in a mounted
 * window and a refusal nobody draws must not vanish.
 */
export function raiseCommandRefusal(refusal: Refusal): void {
  commandRefusals.raise(refusal);
}

/** The one published sink, withdrawn only by the publisher that set it. */
class CommandRefusalChannel {
  #sink: ((refusal: Refusal) => void) | undefined;

  public publish(sink: (refusal: Refusal) => void): Unsubscribe {
    this.#sink = sink;
    return () => {
      if (this.#sink === sink) {
        this.#sink = undefined;
      }
    };
  }

  public raise(refusal: Refusal): void {
    if (this.#sink === undefined) {
      throw new RefusalError(refusal);
    }
    this.#sink(refusal);
  }
}

const commandRefusals = new CommandRefusalChannel();
