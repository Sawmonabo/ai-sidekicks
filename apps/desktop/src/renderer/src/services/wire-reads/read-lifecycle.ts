// How far a wire reading has got, why it did not get further, and whether its tail can be opened
// again. A phase and a `readRefusal` set by separate writers could publish `phase: "read"` beside
// a refusal from an older read, so the pair moves together in one class: `readRefusal` says the
// newest read failed, a served read clears it in the same act that moves the phase, and
// {@link findReadRefusal} also derives what a view renders from the phase, so a later arm that
// forgets the clear still renders honestly.
//
// A reading opens a tail before its first read and settles refused when the open throws. A
// transport that refused this time may serve the next, so that failure leaves the reading
// re-openable; a registered request this reading's scope does not satisfy will never parse, so
// that one does not. Neither leaves a read reachable without its tail. This is not the scheduler
// (`lib/reads/refresh-scheduler.ts` decides when, `store/reads/read-triggers.ts` which moments):
// it holds no bridge, opens no stream and publishes nothing.

import type { Refusal } from "@renderer/lib/refusal.js";

/** How a wire read has gone; none of the three is an empty list. */
export type WireReadPhase = "reading" | "read" | "refused";

/**
 * The phase-and-refusal pair every wire reading publishes, spread onto each reading's readout so a
 * view rendering "why is this empty" reads the same two members whichever reading it holds.
 */
export interface WireReadState {
  readonly phase: WireReadPhase;
  /**
   * Why the newest read could not be taken. Carried rather than swallowed: a chip's absence is not
   * a health reading, so a failed read and a genuinely empty answer would otherwise look alike.
   */
  readonly readRefusal: Refusal | undefined;
}

/**
 * One reading's phase, its refusal and its stream's openability. The three move together, so the
 * owning reading calls one method per outcome and then publishes; this class wakes nobody, so a
 * caller is never woken into a half-written state.
 */
export class WireReadLifecycle {
  #phase: WireReadPhase = "reading";
  #readRefusal: Refusal | undefined = undefined;
  #streamState: WireStreamState = "closed";

  /** The pair a readout spreads. One object per composition, never held here. */
  public get state(): WireReadState {
    return { phase: this.#phase, readRefusal: this.#readRefusal };
  }

  /** Whether the tail is up. A read guards on it, since a snapshot with no tail goes stale. */
  public get isOpen(): boolean {
    return this.#streamState === "open";
  }

  /** Whether opening the tail is worth attempting. */
  public get isOpenable(): boolean {
    return this.#streamState === "closed";
  }

  /** The tail is up; called once the subscription is in hand. */
  public markOpen(): void {
    this.#streamState = "open";
  }

  /** The reading is closing; its tail is down and a fresh reading opens its own. */
  public markClosed(): void {
    this.#streamState = "closed";
  }

  /**
   * A read served. Clears the refusal in the same act that moves the phase, since `readRefusal`
   * means the newest read failed.
   */
  public settleRead(): void {
    this.#phase = "read";
    this.#readRefusal = undefined;
  }

  /** A read refused. The tail is left exactly as it was; only the read failed. */
  public refuseRead(refusal: Refusal): void {
    this.#settleRefused(refusal);
  }

  /**
   * The tail would not open, and a later trigger may try again. The transport arm: the bridge that
   * threw on `subscribe` this time may serve a repair, focus or fresh mount, so the reading stays
   * openable.
   */
  public refuseOpen(refusal: Refusal): void {
    this.#streamState = "closed";
    this.#settleRefused(refusal);
  }

  /**
   * The tail can never be opened by this reading, so nothing re-tries it. The registered-request
   * arm: the request is composed from the reading's own scope, so a scope that did not parse will
   * not parse next time, and retrying would republish a fresh refusal and re-render every watcher.
   */
  public refuseOpenTerminally(refusal: Refusal): void {
    this.#streamState = "unopenable";
    this.#settleRefused(refusal);
  }

  #settleRefused(refusal: Refusal): void {
    this.#phase = "refused";
    this.#readRefusal = refusal;
  }
}

/**
 * The refusal a view renders for this reading, or `undefined` when there is none. Every consumer
 * goes through it so the phase-and-refusal coupling is stated once, and a reading whose newest
 * read served answers `undefined` even if a later arm forgets the clear.
 */
export function findReadRefusal(state: WireReadState): Refusal | undefined {
  return state.phase === "refused" ? state.readRefusal : undefined;
}

/**
 * Whether this reading's tail is up, and what a trigger may do about it if not.
 *
 * - `closed`: no tail, and opening one is worth trying (the seed state, the state after close, and
 *   after a transport-level open failure).
 * - `open`: the tail is up and the reading's reads are behind it.
 * - `unopenable`: the open failed for a reason retrying cannot change, since the stream's
 *   registered request did not admit the scope and is composed from the same scope every time.
 */
type WireStreamState = "closed" | "open" | "unopenable";
