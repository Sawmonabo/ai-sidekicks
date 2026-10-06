// One value a single owner publishes for code that cannot be handed it, such as a command
// contributed once for the app reading the window it runs in.

import type { Unsubscribe } from "#shared/preload-api.js";

/** The one published value, withdrawn only by the publisher that set it. */
export class PublishedValue<Value> {
  #value: Value | undefined;

  /** Publish `value` over any before it; the returned handle withdraws it while it is current. */
  public publish(value: Value): Unsubscribe {
    this.#value = value;
    return () => {
      if (this.#value === value) {
        this.#value = undefined;
      }
    };
  }

  /** The value published now, or `undefined` when none is. */
  public get current(): Value | undefined {
    return this.#value;
  }
}
