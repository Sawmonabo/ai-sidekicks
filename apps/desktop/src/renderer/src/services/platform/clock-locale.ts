// The locale this window writes every clock figure and date in, held once for the bridge: it starts
// from the machine's region and clock the window started with and follows each change main pushes,
// so a person who turns on 24-hour time in the operating system sees every figure redraw at once.

import type { PreloadApi, Unsubscribe } from "#shared/preload-api.js";
import { clockLocaleFor } from "#renderer/lib/wire/figures.js";

/** The clock locale in force, and the listeners told when the machine's region or clock changes. */
export class ClockLocale {
  readonly #listeners = new Set<() => void>();
  #current: string;

  /** Starts from `app`'s facts and hears every change main pushes for the life of the window. */
  public constructor(app: PreloadApi["app"]) {
    this.#current = clockLocaleFor(app);
    app.subscribeMachineClock((clock) => {
      const next = clockLocaleFor(clock);
      if (next === this.#current) {
        return;
      }
      this.#current = next;
      for (const listener of [...this.#listeners]) {
        listener();
      }
    });
  }

  /** The tag to pass as a clock or date formatter's locale, such as `en-US-u-hc-h23`. */
  public get current(): string {
    return this.#current;
  }

  /** Calls `listener` after each change of `current`. */
  public subscribe(listener: () => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
