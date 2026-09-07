// How far a wire reading has got, why it did not get further, and whether its tail
// can be opened again.
//
// TWO READINGS HAD WRITTEN THIS PAIR TWICE AND GOT IT WRONG THE SAME WAY TWICE.
// `queue-reading.ts` and `provider-account-quota.ts` each declared a three-value
// phase, a `readRefusal` beside it, one refusing writer that set both, and a served
// arm that set the phase and left the refusal standing. So a registry that refused
// once and then healed published `phase: "read"` with populated rows and a refusal
// from a read two triggers ago — which the composer's accessory rail rendered beside
// healthy chips for the life of the window, because a consumer reading the member
// bare has no way to know the two are coupled.
//
// THE COUPLING IS THE WHOLE SUBJECT, so it lives in one class with one meaning:
// `readRefusal` says the NEWEST read failed, never that a read has failed at some
// point. A served read clears it in the same act that moves the phase, and
// {@link readRefusalOf} derives what a surface renders from the phase rather than
// trusting the clear — two independent statements of one rule, so a later arm that
// forgets the clear still renders honestly.
//
// AND A STREAM THAT WOULD NOT OPEN IS NOT THE SAME AS ONE THAT CANNOT. Both readings
// open a tail before their first read and settle refused when the open throws, and
// both then sat with the stream flag still claiming to be up: every later focus,
// repair, and mount trigger was a guaranteed no-op on one of them, while on the other
// a later read COULD serve and published a current-looking reading with no live tail
// behind it. The two failing opens are different facts and are now named as such — a
// transport that refused this time may serve the next, and a registered request this
// reading's own scope does not satisfy will never parse — so the first leaves the
// reading re-openable and the second does not, and neither leaves a read reachable
// without the tail it depends on.
//
// WHAT THIS IS NOT. It is not the scheduler: when a re-read is asked for is
// `store/scheduling.ts`'s, and which moments ask is `store/read-triggers.ts`'s. It
// holds no bridge, opens no stream, and publishes nothing — the reading that owns it
// does all three, and calls one method here per outcome so that the outcome and the
// state it leaves behind cannot be spelled two ways.

import type { ConsoleRefusal } from "../../core/index.js";

/** How a wire read has gone. Three answers, and none of them is an empty list. */
export type WireReadPhase = "reading" | "read" | "refused";

/**
 * The phase-and-refusal pair every reading in this family publishes.
 *
 * Declared once and spread onto each reading's own readout, so a surface that renders
 * "why is this empty" reads the same two members whichever reading it holds.
 */
export interface WireReadState {
  readonly phase: WireReadPhase;
  /**
   * Why the NEWEST read could not be taken. Carried rather than swallowed.
   *
   * A chip's absence is not a health reading, so a read that failed and a node whose
   * answer is genuinely empty would otherwise look identical — and the one a person
   * needs to act on is the one that says nothing.
   */
  readonly readRefusal: ConsoleRefusal | undefined;
}

/**
 * The refusal a surface renders for this reading, or `undefined` when there is none.
 *
 * THE PHASE-AWARE ACCESSOR EVERY CONSUMER GOES THROUGH, so the coupling between the
 * two members is stated once rather than at each call site. Two consumers read the
 * member bare and rendered a healed reading's last failure indefinitely; both now ask
 * here, and a reading whose newest read served answers `undefined` even if some later
 * arm forgets {@link WireReadLifecycle.settleRead}'s clear.
 */
export function readRefusalOf(state: WireReadState): ConsoleRefusal | undefined {
  return state.phase === "refused" ? state.readRefusal : undefined;
}

/**
 * Whether this reading's tail is up, and what a trigger may do about it if not.
 *
 *   • `closed` — no tail, and opening one is worth trying. The seed state, the state
 *     a closed reading returns to, and the state a transport-level open failure
 *     leaves, because the transport that refused may serve the next caller.
 *   • `open` — the tail is up and this reading's reads are behind it.
 *   • `unopenable` — the open failed for a reason re-trying cannot change: the
 *     stream's own registered request did not admit the scope this reading is
 *     addressed at, and that request is composed from the same scope every time.
 */
type WireStreamState = "closed" | "open" | "unopenable";

/**
 * One reading's phase, its refusal, and its stream's openability.
 *
 * A class with private fields rather than three fields on each reading, because the
 * three move together and every transition here is one that got written twice: the
 * clear on a served read, the two different open failures, and the close. The reading
 * that owns one calls exactly one method per outcome and then publishes — this class
 * wakes nobody, so a caller can never be woken into a half-written state.
 */
export class WireReadLifecycle {
  #phase: WireReadPhase = "reading";
  #readRefusal: ConsoleRefusal | undefined = undefined;
  #streamState: WireStreamState = "closed";

  /** The pair a readout spreads. One object per composition, never held here. */
  public get state(): WireReadState {
    return { phase: this.#phase, readRefusal: this.#readRefusal };
  }

  /**
   * Whether the tail is up.
   *
   * What a read guards on: a snapshot taken with no tail behind it stops being true
   * the moment it lands, and publishing one as `read` is how a dead reading came to
   * present itself as current.
   */
  public get isOpen(): boolean {
    return this.#streamState === "open";
  }

  /** Whether opening the tail is worth attempting. False once and for all if not. */
  public get isOpenable(): boolean {
    return this.#streamState === "closed";
  }

  /** The tail is up. Called by the reading once the subscription is in hand. */
  public markOpen(): void {
    this.#streamState = "open";
  }

  /** The reading is closing. Its tail is down and a fresh reading opens its own. */
  public markClosed(): void {
    this.#streamState = "closed";
  }

  /**
   * A read served. Clears the refusal in the same act that moves the phase.
   *
   * The clear is the point: `readRefusal` means "the newest read failed", so a served
   * read leaves none. Without it a transient refusal became permanent on screen.
   */
  public settleRead(): void {
    this.#phase = "read";
    this.#readRefusal = undefined;
  }

  /** A read refused. The tail is left exactly as it was; only the read failed. */
  public refuseRead(refusal: ConsoleRefusal): void {
    this.#settleRefused(refusal);
  }

  /**
   * The tail would not open, and a later trigger may try again.
   *
   * The transport arm: a bridge that threw on `subscribe` this time is the same
   * bridge a repair, a focus, or a fresh mount asks again, so the reading stays
   * openable and its scheduler re-opens rather than reading behind a stream that is
   * not there.
   */
  public refuseOpen(refusal: ConsoleRefusal): void {
    this.#streamState = "closed";
    this.#settleRefused(refusal);
  }

  /**
   * The tail can never be opened by this reading, so nothing re-tries it.
   *
   * The registered-request arm: the request is composed from this reading's own
   * scope and parsed against the schema the corpus registers, so a scope that did
   * not parse will not parse on the next focus either. Re-trying it would republish
   * a fresh refusal object on every trigger and re-render every watcher for a fact
   * that has not moved.
   */
  public refuseOpenTerminally(refusal: ConsoleRefusal): void {
    this.#streamState = "unopenable";
    this.#settleRefused(refusal);
  }

  #settleRefused(refusal: ConsoleRefusal): void {
    this.#phase = "refused";
    this.#readRefusal = refusal;
  }
}
