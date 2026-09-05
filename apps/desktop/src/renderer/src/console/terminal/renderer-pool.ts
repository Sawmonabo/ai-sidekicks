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
// AND THE ALLOCATION IS PER CONTEXT, NOT PER TERMINAL. A terminal id is the
// SESSION's id (`terminal/pane/TerminalPane.tsx` binds the emulator to
// `sessionStore.sessionId`), and more than one pane can be open on one session —
// the fixture pane harness mounts exactly that, deliberately, because the
// per-instance slope the `terminal-instance-memory` budget reads depends on it.
// Each of those panes builds its own `WebglAddon` and its own context. A ledger
// keyed on the terminal id therefore treated the second pane's acquisition as an
// idempotent re-entry: the lifetime count stayed at one while two contexts were
// live, disposing EITHER pane removed the one holder record while the other kept
// drawing, and a page churning duplicate panes walked past the cap into Chromium's
// own eviction — which is the failure the cap exists to prevent. So a context is
// the unit: `acquire` mints a lease per created context, `release` and `reclaim`
// require the lease back, and the per-terminal readings below are a GROUPING over
// the leases rather than the key they are stored under.
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

import { TERMINAL_WEBGL_POOL_CAP } from "../core/index.js";

/**
 * One created context's standing in the ledger.
 *
 * Minted by `acquire` and handed back to `release` or `reclaim`, which is what
 * makes the allocation per CONTEXT rather than per terminal: two panes on one
 * session hold two of these, and each hands back only its own.
 *
 * Compared by IDENTITY and never by its contents. A ledger honours the objects it
 * minted, so a value a caller assembled itself — or one minted by a different
 * ledger — is refused, and the terminal it names is carried for the grouping
 * readings below rather than as a key anything is stored under.
 */
export interface TerminalContextLease {
  /** The terminal the context was taken for. Read by the groupings, never matched on. */
  readonly terminalId: string;
}

/**
 * The WebGL context ledger.
 *
 * A class rather than a counter because two different quantities have to stay
 * apart — the contexts this page has created and the contexts being drawn on right
 * now — and because a hand-back has to name the context it is about, which is what
 * keeps one pane's teardown from retiring a sibling pane's live renderer.
 */
export class TerminalRendererPool {
  readonly #cap: number;
  readonly #heldLeases = new Set<TerminalContextLease>();
  #createdContextCount = 0;

  public constructor(cap: number = TERMINAL_WEBGL_POOL_CAP) {
    this.#cap = cap;
  }

  /** How many contexts are being drawn on right now. */
  public get heldSlotCount(): number {
    return this.#heldLeases.size;
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

  /**
   * Whether anything mounted for this terminal is drawing on a context right now.
   *
   * A GROUPING over the leases rather than a lookup: one session can have several
   * panes open, so this answers "any of them", and the count that the cap is
   * checked against is never derived from it.
   */
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
   * Take a context, or answer nothing once the page has created its allowance.
   *
   * `undefined` is not a failure: it sends this instance to the DOM renderer, which
   * xterm.js issue #6015 says reflows the grid by up to about a device pixel per
   * cell — a far better outcome than a stolen context.
   *
   * Every call that is granted mints a context and counts one, including a second
   * call naming a terminal that already holds one: that second caller is a second
   * pane with a second `WebglAddon`, and the page pays for it whether or not the
   * ledger notices.
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
   * Stop drawing on this context, and leave it counted.
   *
   * What a teardown does. The addon's disposal does not hand the context back, so
   * neither does this: the lease stops being held, and the page's allowance stays
   * spent. Idempotent, because teardown paths run more than once — and a lease this
   * ledger did not mint is refused rather than silently accounted for, which is
   * what keeps one pane's teardown off a sibling pane's renderer.
   */
  public release(lease: TerminalContextLease): void {
    this.#heldLeases.delete(lease);
  }

  /**
   * Give the allowance back, for a context that demonstrably does not exist.
   *
   * The two arms that reach it are the host with no WebGL2, where the addon threw
   * before a context was made, and a context the host lost and did not restore.
   * Both are the same claim — there is nothing out there counting against the
   * page's ceiling — and it is the only claim that may move the lifetime reading
   * down. Idempotent, and refused for a lease this ledger is not holding: a
   * reclaim that trusted its argument would let a stale or foreign token spend the
   * allowance of a context still on screen.
   */
  public reclaim(lease: TerminalContextLease): void {
    if (this.#heldLeases.delete(lease) && this.#createdContextCount > 0) {
      this.#createdContextCount -= 1;
    }
  }

  /**
   * Reclaim every context this terminal is holding, for a caller that has no lease.
   *
   * The grouping's write half, and the only hand-back that is keyed by terminal. It
   * exists for a page-wide sweep — a suite clearing the module ledger between cases,
   * where the leases were minted inside a component that has since been unmounted —
   * and it is deliberately not what a pane's own teardown calls: a pane that reached
   * for this would reclaim a sibling pane's live context along with its own, which
   * is the defect the lease keying exists to close, reintroduced from the other side.
   */
  public reclaimEveryContextFor(terminalId: string): void {
    for (const lease of [...this.#heldLeases]) {
      if (lease.terminalId === terminalId) {
        this.reclaim(lease);
      }
    }
  }
}

/** The page's ledger. A test builds its own; nothing else does. */
export const terminalRendererPool: TerminalRendererPool = new TerminalRendererPool();
