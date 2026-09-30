// Where a command with no view of its own states a refusal. Commands are contributed at
// composition time, so they cannot close over the window's banner; the mounted window
// publishes its banner sink here.

import { type Unsubscribe } from "@renderer/lib/emitter.js";
import { type Refusal } from "@renderer/lib/refusal.js";

/** Publishes this window's refusal rendering; only the window calls it. */
export function publishCommandRefusalSink(sink: (refusal: Refusal) => void): Unsubscribe {
  return commandRefusals.publish(sink);
}

/** States a refusal from a command with no view of its own; returns whether a sink rendered it. */
export function raiseCommandRefusal(refusal: Refusal): boolean {
  return commandRefusals.raise(refusal);
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

  public raise(refusal: Refusal): boolean {
    if (this.#sink === undefined) {
      return false;
    }
    this.#sink(refusal);
    return true;
  }
}

const commandRefusals = new CommandRefusalChannel();
