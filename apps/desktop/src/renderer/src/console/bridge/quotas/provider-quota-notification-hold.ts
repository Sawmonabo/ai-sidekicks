// Account-plane notifications held across the registry's opening read.
//
// WHY ANYTHING IS HELD AT ALL. The tail opens BEFORE the read, and the read answers
// with the whole registry at ONE instant — an instant the tail has already moved past
// by the time the reply lands. An `account_removed` or an `account_changed` arriving
// in between, applied on arrival, was then overwritten by the reply's unconditional
// writes: the removed account came back and the newer credential generation regressed,
// and both stayed that way INDEFINITELY, because the tail emits no second notification
// for a mutation it already reported. Holding those frames and replaying them once the
// snapshot is seated is what puts them back in order.
//
// EVERY KIND IS HELD, not only the ones that move state. The rule a reader carries is
// then one sentence rather than a second list of which kinds may be reordered, and a
// kind that moves nothing costs one slot and no correctness.
//
// AND THE CAP DEGRADES TO A RE-READ RATHER THAN A DROP. `overflowed` is not a refusal
// and not a loss: it tells the caller to apply what is held, apply the frame that
// overflowed, and take a FRESH read, whose own hold starts empty. Dropping would be
// exactly the silent loss this class exists to prevent. Each overflow costs a full
// buffer's worth of traffic, so the re-read rate is the tail's rate divided by the cap
// and converges as the tail quiets.
//
// A SECOND ATTEMPT INHERITS WHAT THE FIRST WAS HOLDING, WHICH IS THE SAME RULE
// ARRIVED AT FROM THE OTHER SIDE. `begin()` used to clear, and a read begun while an
// earlier one was still travelling therefore threw away every frame that earlier one
// had held — silently, and by the very method whose purpose is that no frame is
// dropped. It is reachable without anything failing: the opening read is taken
// straight, a tail frame is held across it, and a `window-focus` trigger begins a
// second read before the first reply lands. The superseded reply is then discarded by
// its ordinal, so nothing releases what it held, and on the refused arm the console is
// left presenting a removed account as present with no second notification coming.
// Holding is CUMULATIVE instead: the cap applies to the union, so an inherited buffer
// that fills degrades to the same re-read as any other, and the frames reach the fold
// in arrival order whichever attempt was holding when each one landed.

import type { ProviderAccountNotification } from "@ai-sidekicks/contracts";

import { PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP } from "../../core/index.js";

/**
 * What holding one notification did. Two outcomes, and `overflowed` is an
 * instruction to the caller rather than a failure — see the header.
 */
export type QuotaNotificationHoldOutcome = "held" | "overflowed";

/**
 * The notifications one reading is holding, and whether it is holding at all.
 *
 * A class with private fields rather than an array on the reading, because "am I
 * holding" and "what am I holding" are one piece of state, and only one transition
 * may move both: a caller able to lower the flag without taking the frames would
 * strand them, and one able to take them without lowering it would hand the same
 * frames over twice. {@link release} is that transition and is the only one.
 */
export class ProviderQuotaNotificationHold {
  #held: ProviderAccountNotification[] = [];
  #isHolding = false;

  /** Whether an opening read is in flight and its frames are being held. */
  public get isHolding(): boolean {
    return this.#isHolding;
  }

  /**
   * Start holding for a read attempt, keeping whatever a superseded one held.
   *
   * NOTHING IS CLEARED HERE, and {@link release} is the only thing that empties the
   * buffer — which is what makes the two safe together: a released hold is already
   * empty, so the frames a fresh attempt inherits are exactly the frames of an
   * attempt that began and never released. That attempt is the one whose reply the
   * caller's ordinal will discard, so this is the only path by which its frames can
   * still reach the fold.
   */
  public begin(): void {
    this.#isHolding = true;
  }

  /** Hold one frame, or say the caller must apply live and re-read. */
  public hold(notification: ProviderAccountNotification): QuotaNotificationHoldOutcome {
    if (this.#held.length >= PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP) {
      return "overflowed";
    }
    this.#held.push(notification);
    return "held";
  }

  /**
   * Stop holding and hand back everything held, in arrival order.
   *
   * Order is what makes the replay correct: a removal followed by a re-registration
   * and the reverse pair are the same two frames, and only their sequence says which
   * state the registry ended in.
   */
  public release(): readonly ProviderAccountNotification[] {
    this.#isHolding = false;
    const held = this.#held;
    this.#held = [];
    return held;
  }
}
