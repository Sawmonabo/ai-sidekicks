// The page-wide WebGL context pool and the page's one instance of it.
//
// `@xterm/addon-webgl@0.19.0` never calls `loseContext()`, so a disposed addon's context
// lives until its canvas is collected, while Chromium drops the oldest live context when a
// new one is created past its ceiling (xterm.js issue #6068). The cap is therefore checked
// against contexts ever created, not terminals drawing now: a count that fell on teardown
// would let a churning page mint contexts without bound.
//
// Allocation is per context, not per terminal id: a terminal id is the session's id and
// several panes can be open on one session, each with its own addon and context. `acquire`
// mints a lease per context; `release` and `reclaim` require it back.
//
// `release` says a terminal stopped drawing, and the context still counts. `reclaim` says the
// context does not exist (construction threw, or the host lost it) and gives the allowance
// back. Disposed instances are not kept for reuse, because a retained emulator holds its
// grid, scrollback and texture atlas; past the cap a terminal uses the DOM renderer, which
// reflows about a device pixel per cell (xterm.js issue #6015).

import { TERMINAL_WEBGL_POOL_CAP } from "../caps.js";

/**
 * One created context's standing in the pool, minted by `acquire` and handed back to
 * `release` or `reclaim`. Compared by identity: a lease this pool did not mint is refused.
 */
export interface TerminalContextLease {
  /** The terminal the context was taken for. Read by the groupings, never matched on. */
  readonly terminalId: string;
}

/**
 * The WebGL context pool. A class because the contexts created and the contexts drawn on now
 * are separate counts, and a hand-back names its own context so one pane's teardown cannot
 * retire a sibling pane's renderer.
 */
export class TerminalRendererPool {
  readonly #cap: number;
  readonly #heldLeases = new Set<TerminalContextLease>();
  #createdContextCount = 0;

  /** A pool that grants at most `cap` contexts over the page's life. */
  public constructor(cap: number = TERMINAL_WEBGL_POOL_CAP) {
    this.#cap = cap;
  }

  /** How many contexts are being drawn on right now. */
  public get heldContextCount(): number {
    return this.#heldLeases.size;
  }

  /**
   * How many contexts this page has created and not proven gone. Does not fall when a
   * terminal is disposed, because disposing the addon does not release the context.
   */
  public get createdContextCount(): number {
    return this.#createdContextCount;
  }

  /** Whether the page has spent its whole allowance. Every later terminal is DOM. */
  public get isExhausted(): boolean {
    return this.#createdContextCount >= this.#cap;
  }

  /** Whether any pane mounted for this terminal is drawing on a context now. */
  public holds(terminalId: string): boolean {
    return this.heldContextCountFor(terminalId) > 0;
  }

  /** How many contexts this terminal's mounted panes are drawing on right now. */
  public heldContextCountFor(terminalId: string): number {
    let held = 0;
    for (const lease of this.#heldLeases) {
      if (lease.terminalId === terminalId) {
        held += 1;
      }
    }
    return held;
  }

  /**
   * Take a context, or return `undefined` once the page has created its allowance, which sends
   * the caller to the DOM renderer. Every granted call counts one, including a second pane on
   * a terminal that already holds one, since that pane builds its own context.
   */
  public acquire(terminalId: string): TerminalContextLease | undefined {
    if (this.#createdContextCount >= this.#cap) {
      return undefined;
    }
    const lease: TerminalContextLease = Object.freeze({ terminalId });
    this.#heldLeases.add(lease);
    this.#createdContextCount += 1;
    return lease;
  }

  /**
   * Stop drawing on this context and leave it counted, which is what a teardown does.
   * Idempotent; a lease this pool did not mint is ignored.
   */
  public release(lease: TerminalContextLease): void {
    this.#heldLeases.delete(lease);
  }

  /**
   * Give the allowance back for a context that does not exist: the host has no WebGL2 and
   * the addon threw before making one, or the host lost the context and it was not restored.
   * Idempotent, and ignores a lease the pool is not holding so a stale token cannot spend
   * the allowance of a context still on screen.
   */
  public reclaim(lease: TerminalContextLease): void {
    if (this.#heldLeases.delete(lease) && this.#createdContextCount > 0) {
      this.#createdContextCount -= 1;
    }
  }

  /**
   * Reclaim every context this terminal holds, for a caller with no lease, such as a suite
   * clearing the page pool. A pane's own teardown must not call this: it would reclaim a
   * sibling pane's live context too.
   */
  public reclaimEveryContextFor(terminalId: string): void {
    for (const lease of [...this.#heldLeases]) {
      if (lease.terminalId === terminalId) {
        this.reclaim(lease);
      }
    }
  }
}

/** The page's pool. A test builds its own; nothing else does. */
export const terminalRendererPool: TerminalRendererPool = new TerminalRendererPool();
