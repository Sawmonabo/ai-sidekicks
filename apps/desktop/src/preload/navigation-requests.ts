// The navigation requests main hands the console document. Main answers the request it held once
// per document, so the preload reads it once, at the first subscription, and keeps it, like a push
// that lands while no handler is subscribed, until a handler takes it: a subscription removed and
// added again while the read crosses, as an effect's re-run does, still hears it once.

import type { NavigationRequest, Unsubscribe } from "#shared/preload-api.js";

/** The console document's navigation requests, kept until a subscribed handler takes each one. */
export class NavigationRequests {
  readonly #readHeld: () => Promise<NavigationRequest | null>;
  readonly #handlers = new Set<(request: NavigationRequest) => void>();
  /** The latest request no handler has taken. */
  #untaken: NavigationRequest | undefined;
  #hasRead = false;

  /** Over `readHeld`, main's one answer of the request it held for this document. */
  public constructor(readHeld: () => Promise<NavigationRequest | null>) {
    this.#readHeld = readHeld;
  }

  /** Hands `request` to every handler subscribed now, or keeps it for the next one. */
  public deliver(request: NavigationRequest): void {
    if (this.#handlers.size === 0) {
      this.#untaken = request;
      return;
    }
    for (const handler of [...this.#handlers]) {
      handler(request);
    }
  }

  /**
   * Adds `handler`, handing it the request no handler has taken yet; the first subscription reads
   * main's held one. A failed read is thrown on as an unhandled rejection, never dropped.
   */
  public subscribe(handler: (request: NavigationRequest) => void): Unsubscribe {
    // A wrapper per subscription, so the same function subscribed twice is two subscriptions.
    const subscription = (request: NavigationRequest): void => {
      handler(request);
    };
    this.#handlers.add(subscription);
    if (!this.#hasRead) {
      this.#hasRead = true;
      void this.#readHeld().then((held) => {
        if (held !== null) {
          this.deliver(held);
        }
      });
    } else if (this.#untaken !== undefined) {
      const untaken = this.#untaken;
      this.#untaken = undefined;
      subscription(untaken);
    }
    return () => {
      this.#handlers.delete(subscription);
    };
  }
}
