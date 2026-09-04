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

import type { ProviderAccountNotification } from "@ai-sidekicks/contracts";

import { PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP } from "../core/index.js";

/**
 * What holding one notification did. Two outcomes, and `overflowed` is an
 * instruction to the caller rather than a failure — see the header.
 */
export type QuotaNotificationHoldOutcome = "held" | "overflowed";

/**
 * The notifications one reading is holding, and whether it is holding at all.
 *
 * A class with private fields rather than an array on the reading, because "am I
 * holding" and "what am I holding" are one piece of state: a caller that could set the
 * flag without clearing the list would replay one read's frames into the next.
 */
export class ProviderQuotaNotificationHold {
  #held: ProviderAccountNotification[] = [];
  #isHolding = false;

  /** Whether an opening read is in flight and its frames are being held. */
  public get isHolding(): boolean {
    return this.#isHolding;
  }

  /** Start holding for a read attempt. Anything a previous attempt held is dropped. */
  public begin(): void {
    this.#isHolding = true;
    this.#held = [];
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
