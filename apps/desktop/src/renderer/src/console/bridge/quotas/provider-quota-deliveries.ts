// What arrives on the account-plane tail, and what it is allowed to do to the fold.
//
// Split from `provider-account-quota.ts`, which owns the WIRE — opening the stream,
// taking the registry read, saying what the console renders when either could not be
// read — and had been carrying this second job beside it: the ORDER in which a frame
// reaches the fold. The two are separable because nothing here opens, reads, closes,
// or publishes; it is handed the fold, applies frames to it, and says when something
// moved.
//
// TWO OF THE THREE DECISIONS THAT FILE ANNOUNCES ARE MADE HERE, each argued at the
// site that makes it rather than twice:
//
//   • A frame arriving across the opening read is HELD and replayed rather than
//     silently overwritten by the snapshot, and an overflowing hold degrades to a
//     fresh read rather than a drop ({@link ProviderQuotaDeliveries.deliver},
//     `#holdAcrossSeedRead`).
//   • A same-window reading below the high-water mark is recorded as a diagnostic
//     rather than rendered as a regression ({@link ProviderQuotaDeliveries.mergeWindow}).
//
// The third — that a delivery outside the registered union is counted rather than
// dropped — is `unreadable-deliveries.ts`', and the one part of it this stream owns
// is that it NEVER clears the count. The registry read answers for an instant the
// tail has already moved past, which is the very reason frames are held across it, so
// it may not claim to cover a frame that arrived after it; and a payload outside the
// registered union is a BUILD-level fact rather than a transient one, so the same
// shape keeps arriving unreadable and a count that reset would report a live gap as
// closed. That is exactly where this stream parts from the queue's, whose snapshot
// restates its whole list at one moment and does clear.

import type {
  ProviderAccountNotification,
  ProviderAccountUsageWindow,
} from "@ai-sidekicks/contracts";
import { ProviderAccountNotificationSchema } from "@ai-sidekicks/contracts";

import {
  PROVIDER_QUOTA_REFUSAL_ORIGIN,
  unreadableDeliveryRefusal,
} from "./provider-quota-refusals.js";
import { ProviderQuotaNotificationHold } from "./provider-quota-notification-hold.js";
import { UnreadableDeliveryLedger, type UnreadableDeliveryReading } from "../readings/index.js";
import type { ProviderQuotaFold } from "./provider-quota-fold.js";

/** What the reading hands over so a frame can reach a surface without this module publishing. */
export interface ProviderQuotaDeliverySink {
  /** Something moved, or a delivery was recorded unreadably. Publish. */
  readonly onChanged: () => void;
  /**
   * The hold overflowed and what it held has been applied live.
   *
   * The reply now in flight describes an older registry than the fold does, so the
   * reading takes a FRESH read whose reply supersedes it. Separate from
   * {@link onChanged} because it is a repair rather than a render.
   */
  readonly onSupersededRead: () => void;
}

/**
 * One account-plane tail: the frames it carries, and the order they reach the fold in.
 *
 * A class with private fields rather than methods on the reading, because the hold,
 * the unreadable ledger, and the once-only high-water diagnostic are three pieces of
 * state that only ever move on a delivery — and a reading that could move one of them
 * from its own read path is how a held frame comes to be applied twice.
 *
 * The FOLD is a constructor parameter rather than something built here: the reading
 * seats the registry snapshot's accounts into the same fold and composes its readout
 * off it, so a fold owned here would be a second one to keep in step with the first.
 */
export class ProviderQuotaDeliveries {
  readonly #fold: ProviderQuotaFold;
  readonly #sink: ProviderQuotaDeliverySink;
  readonly #hold = new ProviderQuotaNotificationHold();
  readonly #unreadable = new UnreadableDeliveryLedger(unreadableDeliveryRefusal);
  #hasReportedHighWaterDrop = false;

  public constructor(fold: ProviderQuotaFold, sink: ProviderQuotaDeliverySink) {
    this.#fold = fold;
    this.#sink = sink;
  }

  /** What the readout carries about the frames this build could not read. */
  public get unreadable(): UnreadableDeliveryReading {
    return this.#unreadable.reading;
  }

  /** Begin holding, for a registry read that is about to go out. */
  public beginHold(): void {
    this.#hold.begin();
  }

  /**
   * Apply everything held across the read, in arrival order, and stop holding.
   *
   * Every caller publishes after it, so the replay itself does not.
   */
  public releaseHold(): void {
    for (const notification of this.#hold.release()) {
      this.#applyNotification(notification);
    }
  }

  /**
   * One notification off the tail.
   *
   * A payload the registered union does not admit moves no account and no window: it
   * is a frame this build cannot read, and guessing at it would be worse than
   * ignoring it. It is COUNTED rather than ignored, though — a reading that went on
   * presenting its previous snapshot as current would be saying something it no
   * longer knows. A readable one either moves the fold now or is held until the
   * opening read has seated — a question of ORDER and never of whether it is applied.
   */
  public deliver(payload: unknown): void {
    const parsed = ProviderAccountNotificationSchema.safeParse(payload);
    if (!parsed.success) {
      // EVERY delivery publishes, readable or not. One this build cannot read moves
      // no account and no window — the fold never saw it — but it does change what
      // the chips MEAN, and a count that never reached a render could not say so.
      this.#unreadable.record(parsed.error.issues);
      this.#sink.onChanged();
      return;
    }
    if (this.#hold.isHolding) {
      this.#holdAcrossSeedRead(parsed.data);
      return;
    }
    if (this.#applyNotification(parsed.data)) {
      this.#sink.onChanged();
    }
  }

  /** Merge one reading, and say so once if the monotonicity guard had to hold it. */
  public mergeWindow(usageWindow: ProviderAccountUsageWindow): void {
    const disposition = this.#fold.mergeWindow(usageWindow);
    if (disposition !== "dropped-below-high-water" || this.#hasReportedHighWaterDrop) {
      return;
    }
    this.#hasReportedHighWaterDrop = true;
    console.warn(
      `${PROVIDER_QUOTA_REFUSAL_ORIGIN}: dropped-below-high-water: account ${usageWindow.accountId} limit "${usageWindow.limitId}" reported ${String(usageWindow.usedPercent)}% used inside a window already observed higher; consumption does not fall inside one window, so the higher reading stands. Further such readings are dropped without another line.`,
    );
  }

  /** Hold one notification across the opening read, or take the overflow's way out. */
  #holdAcrossSeedRead(notification: ProviderAccountNotification): void {
    if (this.#hold.hold(notification) === "held") {
      return;
    }
    // Overflowed: apply what is held plus the frame that overflowed, then ask for a
    // read whose reply supersedes the one now in flight. Nothing is dropped.
    this.releaseHold();
    this.#applyNotification(notification);
    this.#sink.onChanged();
    this.#sink.onSupersededRead();
  }

  /**
   * Apply one notification to the fold, and say whether anything moved.
   *
   * Every kind is a re-entrant state update rather than a delta, so an account that
   * changed is written whole and a removed one takes its readings with it — a quota
   * row whose account has left the registry names an account nothing can label.
   */
  #applyNotification(notification: ProviderAccountNotification): boolean {
    switch (notification.kind) {
      case "account_changed":
        this.#fold.seatAccount(notification.account);
        return true;
      case "account_removed":
        this.#fold.forgetAccount(notification.accountId);
        return true;
      case "usage_window_updated":
        this.mergeWindow(notification.window);
        return true;
      case "login_completed":
        // Deliberately nothing. A provider reporting its flow finished is not itself
        // a reading; the daemon observes health next and publishes `account_changed`,
        // which is the notification that moves anything here.
        return false;
    }
  }
}
