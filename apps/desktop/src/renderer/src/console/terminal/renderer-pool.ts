// The WebGL slot allocator, and the page's one instance of it.
//
// Its own module rather than a section inside `xterm-adapter.ts`, because the two
// answer different questions: the adapter owns ONE terminal's emulator, addons,
// and teardown, and this owns a page-wide budget that outlives any of them. A
// second reader — the endurance tier, which asserts that a run of create-and-
// dispose cycles leaves the budget where it started — reaches for this and needs
// nothing the adapter has.
//
// WHY A BUDGET EXISTS AT ALL. `WebglAddon.dispose()` does not release its WebGL2
// context (xterm.js issue #6068) and Chromium drops the OLDEST context once a page
// holds more than sixteen. So the quantity to bound is not "how many terminals are
// open" but "how many contexts this page has ever created", and a terminal that
// churned renderers would eventually take the context away from one still on
// screen.

import { TERMINAL_WEBGL_POOL_CAP } from "./constants.js";

/**
 * The WebGL slot allocator.
 *
 * A class rather than a counter because a slot is owned by ONE terminal id — a
 * remount that re-acquires must not consume a second — and a bare number could not
 * express that, drifting the moment an adapter released twice.
 */
export class TerminalRendererPool {
  readonly #cap: number;
  readonly #holderTerminalIds = new Set<string>();

  public constructor(cap: number = TERMINAL_WEBGL_POOL_CAP) {
    this.#cap = cap;
  }

  /** How many terminals hold a slot right now. */
  public get heldSlotCount(): number {
    return this.#holderTerminalIds.size;
  }

  public get cap(): number {
    return this.#cap;
  }

  /** Whether this terminal already holds one. Idempotent re-acquisition rests on it. */
  public holds(terminalId: string): boolean {
    return this.#holderTerminalIds.has(terminalId);
  }

  /**
   * Take a slot, or answer false at the cap. False is not a failure: it sends this
   * instance to the DOM renderer, which xterm.js issue #6015 says reflows the grid
   * by up to about a device pixel per cell — a far better outcome than a stolen
   * context.
   */
  public acquire(terminalId: string): boolean {
    if (this.#holderTerminalIds.has(terminalId)) {
      return true;
    }
    if (this.#holderTerminalIds.size >= this.#cap) {
      return false;
    }
    this.#holderTerminalIds.add(terminalId);
    return true;
  }

  /** Give a slot back. Idempotent, because teardown paths run more than once. */
  public release(terminalId: string): void {
    this.#holderTerminalIds.delete(terminalId);
  }
}

/** The page's pool. A test builds its own; nothing else does. */
export const terminalRendererPool: TerminalRendererPool = new TerminalRendererPool();
