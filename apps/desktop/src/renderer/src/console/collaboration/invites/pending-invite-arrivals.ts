// What has arrived on the pending feed and not been dealt with yet: one bounded
// queue, the identity it dedupes on, and the deferral that makes the bound safe.
//
// SPLIT FROM `pending-invite.ts` on the same line `pending-invite-feeds.ts` is split
// from it. That file dispatches acts on a handle and holds a latch and a scheduler;
// this one holds arrivals and answers questions about them. Neither knows the other's
// half, so a suite can drive the bound and the dedupe without opening a feed and
// without settling a promise.
//
// THREE ARMS IN ONE QUEUE, because they are three states of one thing: a deep link
// somebody followed. `Plan-023 §Phase 2 — IPC Bridge Registry And Per-Surface
// Handlers` task T-023r-2-5 keys them on `status` — a preview that succeeded, one the
// control plane refused, one that could not be put — and a person meets them the same
// way, one prompt at a time in arrival order. Holding the refusals somewhere else
// would be a second queue with a second head and a second release, for prompts that
// differ only in what they let a person do next.
//
// IDENTITY IS THE ARM'S OWN HANDLE AND NOT A COUNTER. A ready arrival is its
// reference and a preview that could not be put is its attempt, so the same frame
// arriving twice — which a replay guarantees — is held once. A refusal carries
// neither: main mints nothing for it and therefore replays nothing, so each refused
// arrival is its own prompt and there is no handle a duplicate could be recognised by.
//
// THE BOUND DEFERS RATHER THAN DROPS. `core/constants.ts` states the recovery beside
// the bound it belongs to: main holds each reference until an act releases it, and
// re-opening the pending feed re-delivers every one still held. So an arrival past
// the bound is recorded as deferred instead of forgotten, and the owner asks for that
// replay the moment the queue has room — which is what makes a bound admissible here
// at all.
//
// EXCEPT ON ONE ARM, WHERE THAT RECOVERY DOES NOT EXIST. A refused preview minted no
// reference, so main holds nothing for it and a re-opened feed brings nothing back:
// deferring one to the replay is deleting it, and what is deleted is the terminal
// explanation — expired, revoked, already accepted — that the person following that
// link is owed and can learn nowhere else. So a refusal past the bound goes into a
// SECOND bounded register beside the queue and is promoted into it the moment a
// release makes room.
//
// AND THE TWO WAIT IN ONE ORDER, WHICH IS THE ORDER THEY ARRIVED IN. Promoting the
// retained refusal on every release was the same rule stated without that clause, and
// it reversed the feed: an invitation turned away first records replay debt, a refusal
// arriving after it is retained, and the release that opens the slot hands it to the
// LATER refusal — after which the queue is full again, the replay is declined for want
// of room, and the older invitation stays off screen until every refusal ahead of it
// has been dealt with. A burst of refusals starved the actionable arrivals behind
// them. So both registers stamp one monotonic arrival sequence, and a slot goes to
// whichever is older: the refusal where it is, and otherwise nobody, leaving the room
// for the replay that is owed the arrival before it.

import type { GrowthPendingInviteRefused, GrowthPendingInviteState } from "../../bridge/index.js";
import { PENDING_INVITE_QUEUE_MAX, PENDING_INVITE_RETAINED_REFUSAL_MAX } from "../../core/index.js";

/**
 * The pending feed's arrivals, in the order they came.
 *
 * A class with private fields: it owns a bounded list and a deferral flag whose only
 * correct transitions are the ones below, and every reader above it wants a question
 * answered rather than the list handed over.
 */
export class PendingInviteArrivals {
  readonly #held: GrowthPendingInviteState[] = [];
  /**
   * Refusals the bound turned away, in arrival order, waiting for a slot.
   *
   * Never a second queue with a second head: nothing reads these but the promotion
   * below, so a person still meets one prompt at a time in the order they arrived.
   */
  readonly #retainedRefusals: RetainedRefusal[] = [];
  /**
   * How many arrivals this window has been offered. The order both registers share.
   *
   * Stamped at arrival and never reissued, so a refusal held here and an arrival the
   * bound turned away can be compared at all — which is what a slot is handed out on.
   * A frame already held takes no number: it is not an arrival, it is the replay
   * re-delivering one.
   */
  #arrivalsSeen = 0;
  /**
   * Where the OLDEST arrival a replay still owes this window sits in that order.
   *
   * `undefined` where nothing is owed. The oldest rather than the newest, because the
   * question it answers is which of the two registers has waited longer — and a debt
   * re-stamped by each later arrival would lose to every refusal that followed the
   * first one.
   */
  #deferredSequence: number | undefined;

  /** The prompt on screen, in whichever state it arrived. */
  public get head(): GrowthPendingInviteState | undefined {
    return this.#held[0];
  }

  /**
   * Arrivals behind the head. Rendered as a count, never as a second card.
   *
   * The retained refusals are counted here because they ARE waiting: a reading that
   * left them out would tell a person nothing is behind the prompt they are looking
   * at while three terminal explanations sit in this object.
   */
  public get waitingBehind(): number {
    return Math.max(0, this.#held.length - 1) + this.#retainedRefusals.length;
  }

  /** Whether the bound turned an arrival away that a replay has not brought back. */
  public get hasDeferredArrivals(): boolean {
    return this.#deferredSequence !== undefined;
  }

  /**
   * Hold one arrival, and say whether the reading moved.
   *
   * `false` for a frame already held, which is the ordinary replay case and must not
   * publish: a re-opened feed re-delivers everything main is still holding, and a
   * reading that changed on each of those would redraw the whole queue for nothing.
   */
  public admit(arrival: GrowthPendingInviteState): boolean {
    const identity = arrivalIdentity(arrival);
    if (identity !== undefined && this.#held.some((held) => arrivalIdentity(held) === identity)) {
      return false;
    }
    const sequence = (this.#arrivalsSeen += 1);
    if (this.#held.length >= PENDING_INVITE_QUEUE_MAX) {
      return arrival.status === "refused"
        ? this.#retain(arrival, sequence)
        : this.#recordDeferredArrival(sequence);
    }
    this.#held.push(arrival);
    return true;
  }

  /**
   * Drop the head, hand it back, and give the slot to the oldest thing waiting.
   *
   * THE PROMOTION HAPPENS HERE AND NOT ON THE NEXT ADMISSION, because a window whose
   * feed has gone quiet admits nothing: a refusal held until the next arrival would
   * wait on an event that may never come, which is the same disappearance the retain
   * exists to prevent, one step later.
   *
   * AND IT PROMOTES NOTHING WHERE THE REPLAY IS OWED SOMETHING OLDER, which is the
   * whole of the ordering rule: the slot is left open so {@link takeDeferredReplay}
   * finds room, and the refusal takes the next one. Filling it regardless is what put
   * the queue back at its bound with the replay declined and the older arrival hidden
   * behind every refusal that followed it.
   */
  public releaseHead(): GrowthPendingInviteState | undefined {
    const released = this.#held.shift();
    const promoted = this.#takeNextRetainedRefusal();
    if (promoted !== undefined) {
      this.#held.push(promoted);
    }
    return released;
  }

  /**
   * Whether a replay is owed now that the queue has room, clearing the debt.
   *
   * Taking it is what makes one release ask for one replay: a flag read without
   * clearing would ask again on the next release and re-open a feed that had already
   * brought everything back.
   */
  public takeDeferredReplay(): boolean {
    if (this.#deferredSequence === undefined || this.#held.length >= PENDING_INVITE_QUEUE_MAX) {
      return false;
    }
    this.#deferredSequence = undefined;
    return true;
  }

  /** Whether one reference is among the arrivals held. Only a ready arm carries one. */
  public holdsReference(reference: string): boolean {
    return this.#held.some((held) => held.status === "ready" && held.reference === reference);
  }

  /** Forget everything. Terminal, and it asks for no replay. */
  public clear(): void {
    this.#held.length = 0;
    this.#retainedRefusals.length = 0;
    this.#deferredSequence = undefined;
  }

  /**
   * The retained refusal a freed slot belongs to, where one of them is the oldest.
   *
   * `undefined` on two different facts, deliberately answered the same way: nothing is
   * retained, and something is retained that arrived AFTER the invitation the replay
   * still owes. In both cases the slot is not this register's to take.
   */
  #takeNextRetainedRefusal(): GrowthPendingInviteRefused | undefined {
    const next = this.#retainedRefusals[0];
    if (next === undefined) {
      return undefined;
    }
    if (this.#deferredSequence !== undefined && this.#deferredSequence < next.sequence) {
      return undefined;
    }
    this.#retainedRefusals.shift();
    return next.arrival;
  }

  /**
   * Hold one refusal beside the queue, and say whether the reading moved.
   *
   * Past the register's own bound the OLDEST goes rather than this arrival: a
   * register that refused new arrivals while holding stale ones would let a single
   * burst blind the window to every later refusal for the rest of the visit, and the
   * explanation a person most likely still wants is the one their last press
   * produced.
   */
  #retain(arrival: GrowthPendingInviteRefused, sequence: number): boolean {
    this.#retainedRefusals.push({ arrival, sequence });
    if (this.#retainedRefusals.length > PENDING_INVITE_RETAINED_REFUSAL_MAX) {
      this.#retainedRefusals.shift();
      return false;
    }
    return true;
  }

  /**
   * Record that the bound turned away an arrival a replay can bring back.
   *
   * The FIRST one keeps its place in the order and every later one joins it silently:
   * one replay brings back everything main still holds, so the debt is one fact, and
   * the position that matters is the oldest turned-away arrival's.
   */
  #recordDeferredArrival(sequence: number): boolean {
    if (this.#deferredSequence !== undefined) {
      return false;
    }
    this.#deferredSequence = sequence;
    return true;
  }
}

/**
 * One retained refusal and where it sits in the order both registers share.
 *
 * The sequence is carried BESIDE the arrival rather than written into it: what comes
 * off the feed is main's frame, held unchanged and handed back unchanged, and a member
 * this console added to it would travel to every reader of the head as though the wire
 * had sent it.
 */
interface RetainedRefusal {
  readonly arrival: GrowthPendingInviteRefused;
  readonly sequence: number;
}

/**
 * The handle one arrival is recognised by, where its arm carries one.
 *
 * `undefined` on the refused arm rather than a fabricated key: a refused preview
 * mints nothing main can resolve, so there is no handle a second copy could be
 * matched on — and a synthetic one would either collide two unrelated refusals or
 * never match at all, which are both worse than admitting the arm has no identity.
 */
function arrivalIdentity(arrival: GrowthPendingInviteState): string | undefined {
  switch (arrival.status) {
    case "ready":
      return `reference:${arrival.reference}`;
    case "unavailable":
      return `attempt:${arrival.attempt}`;
    case "refused":
      return undefined;
  }
}
