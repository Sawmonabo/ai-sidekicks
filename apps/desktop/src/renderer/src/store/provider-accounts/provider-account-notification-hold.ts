// Provider-account notifications held across the registry's opening read.
//
// The tail opens before the read, and the read answers with the whole registry at one instant
// the tail has already moved past. A removal or change arriving in between would be
// overwritten by the reply's unconditional writes (the removed account returns, the credential
// generation regresses) and stay that way, since the tail emits no second notification. So
// every frame is held, of any kind, and replayed once the snapshot is applied.
//
// Past the cap, `overflowed` is not a loss: the caller applies what is held, applies the
// overflowing frame, and takes a fresh read whose own hold starts empty. Each overflow costs a full
// buffer's worth of traffic, so the re-read rate is the tail's rate divided by the cap and falls as
// the tail quiets.
//
// Holding is cumulative: `begin()` does not clear, because a second read begun while an
// earlier one is still traveling (a `window-focus` trigger) would otherwise drop the frames the
// earlier one held, whose superseded reply is discarded. The cap applies to the union, and the
// frames reach the fold in arrival order.

import type { ProviderAccountNotification } from "@ai-sidekicks/contracts/provider-account";

/**
 * The cap on provider-account notifications held while the registry's opening read is in flight.
 *
 * A memory bound, not a policy: a machine's accounts and limit windows are a handful. Past it the
 * reading applies what it holds live and takes a fresh read, so nothing is dropped.
 */
export const PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP = 64;

/** What holding one notification did. `overflowed` is an instruction to the caller. */
export type NotificationHoldOutcome = "held" | "overflowed";

/**
 * The notifications one reading is holding, and whether it is holding at all.
 *
 * "Holding" and "what is held" are one piece of state, and {@link release} is the only
 * transition that moves both, so frames are never stranded or handed over twice.
 */
export class ProviderAccountNotificationHold {
  #held: ProviderAccountNotification[] = [];
  #isHolding = false;

  /** Whether an opening read is in flight and its frames are being held. */
  public get isHolding(): boolean {
    return this.#isHolding;
  }

  /**
   * Starts holding for a read attempt, keeping whatever a superseded one held. Nothing is
   * cleared here; only {@link release} empties the buffer. That is the only path by which a
   * superseded attempt's frames, whose reply the caller's ordinal discards, still reach the
   * fold.
   */
  public begin(): void {
    this.#isHolding = true;
  }

  /** Hold one frame, or say the caller must apply live and re-read. */
  public hold(notification: ProviderAccountNotification): NotificationHoldOutcome {
    if (this.#held.length >= PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP) {
      return "overflowed";
    }
    this.#held.push(notification);
    return "held";
  }

  /**
   * Stops holding and hands back everything held, in arrival order, which is what makes the
   * replay correct.
   */
  public release(): readonly ProviderAccountNotification[] {
    this.#isHolding = false;
    const held = this.#held;
    this.#held = [];
    return held;
  }
}
