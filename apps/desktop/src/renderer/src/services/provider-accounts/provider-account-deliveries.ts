// What arrives on the provider-account tail and the order in which it reaches the fold. Nothing
// here opens, reads, closes or publishes; it applies frames to the fold it is handed and says when
// something moved.
//
// A frame arriving across the opening read is held and replayed rather than overwritten by the
// snapshot, and an overflowing hold degrades to a fresh read rather than a drop. A same-window
// reading below the high-water mark is recorded as a diagnostic, not rendered as a regression.
// `login_completed` is carried without moving the fold: it reports that a brokered sign-in attempt
// is over, which the view that started it cannot learn otherwise (a refused cancellation
// establishes nothing), and the daemon publishes `account_changed` next for the account itself.
// The newest one is held, correlated by the caller on `attemptId`, never taken as an account
// verdict. Unreadable deliveries are counted in `unreadable-deliveries.ts`; this stream never
// clears the count, because the registry read answers for an instant the tail has moved past and
// an unreadable payload is a build-level fact, not a transient one.

import type {
  ProviderAccountNotification,
  ProviderAccountUsageWindow,
} from "@ai-sidekicks/contracts/provider-account";
import { ProviderAccountNotificationSchema } from "@ai-sidekicks/contracts/provider-account";
import { RealClock } from "@renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "@renderer/lib/diagnostic-capture/diagnostic-capture.js";
import {
  PROVIDER_QUOTA_DELIVERY_STREAM,
  PROVIDER_QUOTA_REFUSAL_ORIGIN,
} from "./provider-account-refusals.js";
import { ProviderAccountNotificationHold } from "@renderer/store/provider-accounts/provider-account-notification-hold.js";
import {
  UnreadableDeliveryCounter,
  type UnreadableDeliveryReading,
} from "../wire-reads/unreadable-deliveries.js";
import type { ProviderAccountFold } from "@renderer/store/provider-accounts/provider-account-fold.js";

/**
 * One brokered sign-in the provider reported finished, as the tail carried it. Derived from the
 * registered notification union so its members are the wire's own.
 */
export type ProviderLoginCompletion = Extract<
  ProviderAccountNotification,
  { kind: "login_completed" }
>;

/** What the reading hands over so a frame can reach a view without this module publishing. */
export interface ProviderAccountDeliverySink {
  /** Something moved, or a delivery was recorded unreadably. Publish. */
  readonly onChanged: () => void;
  /**
   * The hold overflowed and what it held has been applied live. The reply in flight describes an
   * older registry than the fold, so the reading takes a fresh read that supersedes it. Separate
   * from {@link onChanged} because it is a repair, not a render.
   */
  readonly onSupersededRead: () => void;
}

/**
 * One provider-account tail: the frames it carries and the order they reach the fold in. The hold,
 * the unreadable count and the once-only high-water diagnostic move only on a delivery, so a
 * reading cannot apply a held frame twice. The fold is a constructor parameter because the reading
 * also loads the registry snapshot into it and draws its accounts and readings from it.
 */
export class ProviderAccountDeliveries {
  readonly #fold: ProviderAccountFold;
  readonly #sink: ProviderAccountDeliverySink;
  readonly #hold = new ProviderAccountNotificationHold();
  readonly #unreadable = new UnreadableDeliveryCounter(PROVIDER_QUOTA_DELIVERY_STREAM);
  #hasReportedHighWaterDrop = false;
  #newestLoginCompletion: ProviderLoginCompletion | undefined = undefined;

  public constructor(fold: ProviderAccountFold, sink: ProviderAccountDeliverySink) {
    this.#fold = fold;
    this.#sink = sink;
  }

  /** What the readout carries about the frames this build could not read. */
  public get unreadable(): UnreadableDeliveryReading {
    return this.#unreadable.reading;
  }

  /**
   * The newest completion the tail has carried, or `undefined` before any. One, not a list: the
   * daemon runs one brokered flow at a time and a set would grow for the tail's life with nothing
   * entitled to prune it.
   */
  public get newestLoginCompletion(): ProviderLoginCompletion | undefined {
    return this.#newestLoginCompletion;
  }

  /** Begin holding, for a registry read that is about to go out. */
  public beginHold(): void {
    this.#hold.begin();
  }

  /**
   * Applies everything held across the read, in arrival order, and stops holding. It does not
   * publish; every caller does.
   */
  public releaseHold(): void {
    for (const notification of this.#hold.release()) {
      this.#applyNotification(notification);
    }
  }

  /**
   * Delivers one notification off the tail. A payload the registered union does not admit moves
   * no account or window but is counted, so the reading does not present a stale snapshot as
   * current. A readable one either moves the fold now or is held until the opening read lands.
   */
  public deliver(payload: unknown): void {
    const parsed = ProviderAccountNotificationSchema.safeParse(payload);
    if (!parsed.success) {
      // Every delivery publishes: an unreadable one moves nothing but changes what the chips
      // mean, and a count that never reached a render could not say so.
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

  /** Merges one reading, and says so once if the monotonicity guard had to hold it. */
  public mergeUsageWindow(usageWindow: ProviderAccountUsageWindow): void {
    const disposition = this.#fold.mergeUsageWindow(usageWindow);
    if (disposition !== "dropped-below-high-water" || this.#hasReportedHighWaterDrop) {
      return;
    }
    this.#hasReportedHighWaterDrop = true;
    // Consumption does not fall inside one window, so the higher reading stands; the drop is a
    // wire fact for diagnostics, recorded once.
    windowDiagnosticCapture.record({
      at: diagnosticStampAt(new RealClock()),
      severity: "warning",
      source: PROVIDER_QUOTA_REFUSAL_ORIGIN,
      kind: "dropped-below-high-water",
      detail:
        `account ${usageWindow.accountId} limit "${usageWindow.limitId}" reported ` +
        `${String(usageWindow.usedPercent)}% used inside a window already observed higher`,
    });
  }

  /** Holds one notification across the opening read, or takes the overflow's way out. */
  #holdAcrossSeedRead(notification: ProviderAccountNotification): void {
    if (this.#hold.hold(notification) === "held") {
      return;
    }
    // Overflowed: apply what is held plus the overflowing frame, then ask for a read that
    // supersedes the one in flight. Nothing is dropped.
    this.releaseHold();
    this.#applyNotification(notification);
    this.#sink.onChanged();
    this.#sink.onSupersededRead();
  }

  /**
   * Applies one notification to the fold and says whether anything moved. Every kind is a state
   * update, not a delta: a changed account is written whole, and a removed one takes its readings
   * with it because a quota row for a departed account cannot be labeled.
   */
  #applyNotification(notification: ProviderAccountNotification): boolean {
    switch (notification.kind) {
      case "account_changed":
        this.#fold.putAccount(notification.account);
        return true;
      case "account_removed":
        this.#fold.forgetAccount(notification.accountId);
        return true;
      case "usage_window_updated":
        this.mergeUsageWindow(notification.window);
        return true;
      case "login_completed":
        // The fold is untouched: a finished login flow is not a reading of the account, and the
        // daemon publishes `account_changed` next for that. It records that the attempt is over and
        // publishes, so a card does not stay up over a flow the service reported finished.
        this.#newestLoginCompletion = notification;
        return true;
    }
  }
}
