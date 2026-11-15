// The order one session's messages leave in: the order they were pressed. A message pressed while
// an earlier one still waits for its file's copy waits behind it, so the service queues them as
// they were pressed; one that failed lets the next go. Held with the session's store, so a composer
// mounted again keeps the order of the sends already on their way.

import { HeldValueKey } from "#renderer/store/session/held-values.js";

/** One session's sends, each let out once the one pressed before it has settled. */
export class SendOrder {
  #last: Promise<unknown> = Promise.resolve();

  /** Runs `send` once every send queued before it has settled, answering what it answers. */
  public async after<TValue>(send: () => Promise<TValue>): Promise<TValue> {
    const run = this.#last.then(send, send);
    this.#last = run;
    return await run;
  }
}

/** The key one session's send order is held under in its store. */
export const SEND_ORDER: HeldValueKey<SendOrder> = new HeldValueKey<SendOrder>();
