// One shell's size changes on their way to it. One is sent at a time, and while it is out only the
// newest size waits, so a drag's backlog collapses and the shell is told the size it stopped at.

import type { TerminalGridSize } from "../emulator/xterm/adapter.js";

/**
 * Sends a shell's sizes through `send`, which settles once the daemon answers and never rejects.
 */
export class ShellResizeQueue {
  readonly #send: (size: TerminalGridSize) => Promise<void>;
  #newest: TerminalGridSize | undefined;
  #isInFlight = false;

  public constructor(send: (size: TerminalGridSize) => Promise<void>) {
    this.#send = send;
  }

  /** Send `size` now, or once the size already out is answered, unless a newer one comes first. */
  public resize(size: TerminalGridSize): void {
    this.#newest = size;
    this.#sendNewest();
  }

  #sendNewest(): void {
    const size = this.#newest;
    if (this.#isInFlight || size === undefined) {
      return;
    }
    this.#newest = undefined;
    this.#isInFlight = true;
    void this.#send(size).finally(() => {
      this.#isInFlight = false;
      this.#sendNewest();
    });
  }
}
