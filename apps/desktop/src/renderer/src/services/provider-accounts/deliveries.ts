// What arrives on the provider-account tail and the order in which it reaches the fold. Nothing
// here opens, reads, closes or publishes; it applies frames to the fold it is handed and says when
// something moved.
//
// A frame arriving across the opening read is buffered and released rather than overwritten by the
// snapshot, and an overflowing hold degrades to a fresh read rather than a drop. A same-window
// reading below the high-water mark is recorded as a diagnostic, not rendered as a regression.
// `signInCompleted` is carried without moving the fold: it reports that a brokered sign-in attempt
// is over, which the view that started it cannot learn otherwise (a refused cancellation
// establishes nothing), and the daemon publishes `accountChanged` next for the account itself.
// The newest one is held, correlated by the caller on `attemptId`, never taken as an account
// verdict.

import type {
  ProviderAccountNotification,
  ProviderAccountUsageWindow,
} from "@ai-sidekicks/contracts/provider/account/record";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type { ProviderSection } from "@ai-sidekicks/contracts/provider/settings";

import { RealClock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import { PROVIDER_QUOTA_REFUSAL_ORIGIN } from "./refusals.js";
import { ProviderAccountNotificationHold } from "#renderer/store/provider-accounts/notification-hold.js";
import type { ProviderAccountFold } from "#renderer/store/provider-accounts/fold.js";

/**
 * One brokered sign-in the provider reported finished, as the tail carried it. Derived from the
 * registered notification union so its members are the wire's own.
 */
export type ProviderSignInCompletion = Extract<
  ProviderAccountNotification,
  { kind: "signInCompleted" }
>;

/** What the reading hands over so a frame can reach a view without this module publishing. */
export interface ProviderAccountDeliverySink {
  /** Something moved. Publish. */
  readonly onChanged: () => void;
  /**
   * The hold overflowed and what it held has been applied live. The reply in flight describes an
   * older registry than the fold, so the reading takes a fresh read that supersedes it. Separate
   * from {@link onChanged} because it is a repair, not a render.
   */
  readonly onSupersededRead: () => void;
}

/**
 * One provider-account tail: the frames it carries and the order they reach the fold in. The hold
 * and the once-only high-water diagnostic move only on a delivery, so a
 * reading cannot apply a held frame twice. The fold is a constructor parameter because the reading
 * also loads the registry snapshot into it and draws its accounts and readings from it;
 * `sectionOf` answers an account's provider section, whose name and plan words its label takes.
 */
export class ProviderAccountDeliveries {
  readonly #fold: ProviderAccountFold;
  readonly #sectionOf: (provider: ProviderId) => ProviderSection;
  readonly #sink: ProviderAccountDeliverySink;
  readonly #hold = new ProviderAccountNotificationHold();
  #hasReportedHighWaterDrop = false;
  #newestSignInCompletion: ProviderSignInCompletion | undefined = undefined;

  public constructor(
    fold: ProviderAccountFold,
    sectionOf: (provider: ProviderId) => ProviderSection,
    sink: ProviderAccountDeliverySink,
  ) {
    this.#fold = fold;
    this.#sectionOf = sectionOf;
    this.#sink = sink;
  }

  /**
   * The newest completion the tail has carried, or `undefined` before any. One, not a list: the
   * daemon runs one brokered flow at a time and a set would grow for the tail's life with nothing
   * entitled to prune it.
   */
  public get newestSignInCompletion(): ProviderSignInCompletion | undefined {
    return this.#newestSignInCompletion;
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
   * Delivers one notification off the tail: it moves the fold now, or is held until the opening
   * read lands.
   */
  public deliver(notification: ProviderAccountNotification): void {
    if (this.#hold.isHolding) {
      this.#holdAcrossSeedRead(notification);
      return;
    }
    if (this.#applyNotification(notification)) {
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
      case "accountChanged":
        this.#fold.putAccount(notification.account, this.#sectionOf(notification.account.provider));
        return true;
      case "accountRemoved":
        this.#fold.forgetAccount(notification.accountId);
        return true;
      case "usageWindowUpdated":
        this.mergeUsageWindow(notification.window);
        return true;
      case "signInCodeRequested":
        // A code asked of the person is no reading of an account, and the sign-in is not over.
        return false;
      case "signInCompleted":
        // The fold is untouched: a finished sign-in is not a reading of the account, and the
        // daemon publishes `accountChanged` next for that. It records that the attempt is over and
        // publishes, so a card does not stay up over a flow the service reported finished.
        this.#newestSignInCompletion = notification;
        return true;
    }
  }
}
