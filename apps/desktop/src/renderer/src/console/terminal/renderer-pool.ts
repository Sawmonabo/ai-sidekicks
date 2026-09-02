// The WebGL context ledger, and the page's one instance of it.
//
// Its own module rather than a section inside `xterm-adapter.ts`, because the two
// answer different questions: the adapter owns ONE terminal's emulator, addons,
// and teardown, and this owns a page-wide budget that outlives any of them. A
// second reader — the endurance tier, which asserts that a run of create-and-
// dispose cycles leaves nothing drawing — reaches for this and needs nothing the
// adapter has.
//
// WHY A BUDGET EXISTS AT ALL, AND WHAT IT COUNTS. `@xterm/addon-webgl@0.19.0`
// tears a renderer down by disposing its render layers, removing its canvas from
// the DOM, and dropping the terminal's atlas-cache entry — and by doing nothing
// else. The package requests no `WEBGL_lose_context` extension and calls
// `loseContext()` nowhere, in the shipped `lib/addon-webgl.mjs` as well as in
// `src/WebglRenderer.ts` (xterm.js issue #6068). A disposed addon's WebGL2 context
// therefore outlives it, until the detached canvas is collected — while Chromium
// enforces its own ceiling at CREATION time by dropping the OLDEST live context,
// which a burst of open-and-close churn reaches long before a collection runs.
//
// SO THE QUANTITY TO BOUND IS HOW MANY CONTEXTS THIS PAGE HAS EVER CREATED, not
// how many terminals are drawing right now. The two readings below are kept apart
// for exactly that reason, and the cap is checked against the LIFETIME one: a
// ledger that fell on every teardown would sit under twelve forever while the page
// minted contexts without bound, and the terminal that lost its renderer would be
// an older one still on screen rather than the one that churned.
//
// WHICH LEAVES TWO WAYS TO STOP HOLDING A CONTEXT, AND THEY ARE NOT THE SAME.
// `release` says a terminal stopped drawing; the context it made is still out
// there, so the lifetime reading does not move. `reclaim` says the context does
// not exist — construction threw before one was made, or the host lost it and the
// addon did not restore it — and only that gives the allowance back.
//
// WHY DISPOSED INSTANCES ARE NOT RETAINED FOR REUSE INSTEAD. Reuse would keep the
// contexts and the terminals that own them alive, and a retained emulator holds
// its grid, its scrollback, and its texture atlas: the `terminal-instance-memory`
// budget bounds one of those, and the endurance tier's churn case asserts that a
// working day of open-and-close cycles drifts by less than one. Trading a bounded
// context leak for an unbounded memory one is the worse half of that trade, so the
// page degrades to the DOM renderer past the cap — a reflow of about a device
// pixel per cell (xterm.js issue #6015) — rather than growing.

import { TERMINAL_WEBGL_POOL_CAP } from "./constants.js";

/**
 * The WebGL context ledger.
 *
 * A class rather than a counter because two different quantities have to stay
 * apart — the contexts this page has created and the terminals drawing on one
 * right now — and because a slot is owned by ONE terminal id, so a remount that
 * re-acquires must not consume a second while the first is still drawing.
 */
export class TerminalRendererPool {
  readonly #cap: number;
  readonly #holderTerminalIds = new Set<string>();
  #createdContextCount = 0;

  public constructor(cap: number = TERMINAL_WEBGL_POOL_CAP) {
    this.#cap = cap;
  }

  /** How many terminals are drawing on a context right now. */
  public get heldSlotCount(): number {
    return this.#holderTerminalIds.size;
  }

  /**
   * How many contexts this page has created and not proven gone.
   *
   * The reading the cap is actually about. It does not fall when a terminal is
   * disposed, because disposing the addon does not release the context.
   */
  public get createdContextCount(): number {
    return this.#createdContextCount;
  }

  public get cap(): number {
    return this.#cap;
  }

  /** Whether the page has spent its whole allowance. Every later terminal is DOM. */
  public get isExhausted(): boolean {
    return this.#createdContextCount >= this.#cap;
  }

  /** Whether this terminal is drawing on one right now. Idempotent re-acquisition rests on it. */
  public holds(terminalId: string): boolean {
    return this.#holderTerminalIds.has(terminalId);
  }

  /**
   * Take a context, or answer false once the page has created its allowance.
   *
   * False is not a failure: it sends this instance to the DOM renderer, which
   * xterm.js issue #6015 says reflows the grid by up to about a device pixel per
   * cell — a far better outcome than a stolen context.
   */
  public acquire(terminalId: string): boolean {
    if (this.#holderTerminalIds.has(terminalId)) {
      return true;
    }
    if (this.#createdContextCount >= this.#cap) {
      return false;
    }
    this.#holderTerminalIds.add(terminalId);
    this.#createdContextCount += 1;
    return true;
  }

  /**
   * Stop drawing, and leave the context counted.
   *
   * What a teardown does. The addon's disposal does not hand the context back, so
   * neither does this: the terminal stops holding one, and the page's allowance
   * stays spent. Idempotent, because teardown paths run more than once.
   */
  public release(terminalId: string): void {
    this.#holderTerminalIds.delete(terminalId);
  }

  /**
   * Give the allowance back, for a context that demonstrably does not exist.
   *
   * The two arms that reach it are the host with no WebGL2, where the addon threw
   * before a context was made, and a context the host lost and did not restore.
   * Both are the same claim — there is nothing out there counting against the
   * page's ceiling — and it is the only claim that may move the lifetime reading
   * down. Idempotent: a terminal that is not holding one reclaims nothing.
   */
  public reclaim(terminalId: string): void {
    if (this.#holderTerminalIds.delete(terminalId) && this.#createdContextCount > 0) {
      this.#createdContextCount -= 1;
    }
  }
}

/** The page's ledger. A test builds its own; nothing else does. */
export const terminalRendererPool: TerminalRendererPool = new TerminalRendererPool();
