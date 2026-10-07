import type { Unsubscribe } from "#shared/preload-api.js";

/** The values main pushes on one channel, and the handlers subscribed to them. */
export class MainPushes<Value> {
  readonly #handlers = new Set<(value: Value) => void>();

  /** Hands `value` to every handler subscribed now. */
  public deliver(value: Value): void {
    for (const handler of [...this.#handlers]) {
      handler(value);
    }
  }

  /**
   * Adds `handler`, first handing it the value `readCurrent` answers when there is one to read,
   * unless it was removed first. A failed read is thrown on as an unhandled rejection, never
   * dropped.
   */
  public subscribe(
    handler: (value: Value) => void,
    readCurrent?: () => Promise<Value>,
  ): Unsubscribe {
    // A wrapper per subscription, so the same function subscribed twice is two subscriptions.
    const subscription = (value: Value): void => {
      handler(value);
    };
    this.#handlers.add(subscription);
    if (readCurrent !== undefined) {
      void readCurrent().then((current) => {
        if (this.#handlers.has(subscription)) {
          subscription(current);
        }
      });
    }
    return () => {
      this.#handlers.delete(subscription);
    };
  }
}
