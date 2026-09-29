// Where a command with no surface of its own states its refusal.
//
// A feature's commands are contributed at composition time and a refusal happens at
// press time, so the act cannot close over the banner of the window that is open when
// it runs. The window publishes its banner sink here while it is mounted; one sink,
// because the window's banner is the only rendering such an act has.

import { type Unsubscribe } from "@renderer/lib/emitter.js";
import { type ConsoleRefusal } from "@renderer/lib/refusal.js";

/** Publish this window's refusal rendering. The window calls it; nothing else does. */
export function publishCommandRefusalSink(sink: (refusal: ConsoleRefusal) => void): Unsubscribe {
  return commandRefusals.publish(sink);
}

/**
 * State a refusal from a command that has no surface of its own.
 *
 * Answers whether anything rendered it, so a caller with its own surface can fall back.
 */
export function raiseCommandRefusal(refusal: ConsoleRefusal): boolean {
  return commandRefusals.raise(refusal);
}

/** The one published sink, withdrawn only by the publisher that set it. */
class CommandRefusalChannel {
  #sink: ((refusal: ConsoleRefusal) => void) | undefined;

  public publish(sink: (refusal: ConsoleRefusal) => void): Unsubscribe {
    this.#sink = sink;
    return () => {
      if (this.#sink === sink) {
        this.#sink = undefined;
      }
    };
  }

  public raise(refusal: ConsoleRefusal): boolean {
    if (this.#sink === undefined) {
      return false;
    }
    this.#sink(refusal);
    return true;
  }
}

const commandRefusals = new CommandRefusalChannel();
