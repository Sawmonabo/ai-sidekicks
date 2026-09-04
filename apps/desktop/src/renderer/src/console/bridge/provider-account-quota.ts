// What is left of each provider account's quota, read from the account plane.
//
// WHERE THIS DATA IS NOT. The composer's rate chips used to fold
// `usage.rate_limit_update` rows out of the session timeline. That row is
// ACCOUNT-PLANE: `Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring`
// binds it to the reserved node-scope sentinel session, so a live session store
// holds none of them and the chips could appear only under a fixture that put one
// in a session's log. The whole surface was therefore fixture-only, and nothing
// about it would have failed until someone opened it against a daemon.
//
// SO THE READING COMES OFF THE REGISTERED ACCOUNT-PLANE WIRE. `providerAccount.list`
// answers with the accounts and the durable quota rows together, and
// `providerAccount.subscribe` is the live tail beside it. The read is what seeds the
// chips — the subscription is a tail rather than a snapshot replay, so a console
// that only subscribed would show nothing until the next probe or run happened to
// produce an update — and the tail is what keeps them current.
//
// NODE-SCOPED, SO ONE READING PER BRIDGE AND NOT ONE PER SESSION. The registry is
// the machine's; two sessions open in one window ask the same question and are
// served the same answer. The reading is held on a `WeakMap` keyed by the bridge, so
// a closed window takes its entry with it, and it is dropped once nobody is watching
// — the stream closes with the last watcher, and a surface that mounts later reads
// afresh rather than being handed a list that stopped being updated.
//
// THIS MODULE IS ONE OF THREE, AND THE SPLIT FOLLOWS THE QUEUE READING'S.
// `provider-quota-fold.ts` owns which reading is current for each
// `(accountId, limitId)` and what a surface renders for it — pure, so the
// supersession rules are drivable with no bridge and no React. This module owns the
// WIRE: one read, one tail, and what the console says when either could not be read.
// `provider-quota-feed.ts` owns how many readings exist and how long each lives.
//
// THE TAIL OPENS BEFORE THE READ, SO NOTIFICATIONS ARE BUFFERED ACROSS IT. The
// registry read answers with the whole registry at ONE instant, and the tail has
// already moved past that instant by the time the reply lands — so an
// `account_removed` or an `account_changed` that arrives in between, applied on
// arrival, was then overwritten by the reply's unconditional writes. That resurrected
// a removed account and regressed a credential generation INDEFINITELY, because the
// tail emits no second notification for a mutation it already reported. Notifications
// arriving while that opening read is in flight are therefore held and replayed once
// the snapshot is seated, on every settlement arm including the refused ones — where
// they are the only truth the console has. Past
// `PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP` the reading stops buffering, applies what
// it holds live, and issues a FRESH read rather than dropping anything; the abandoned
// read's reply is recognised by its ordinal and seats nothing.
//
// A READING HELD BY THE MONOTONICITY GUARD IS RECORDED, NOT RENDERED. A same-window
// reading below the high-water mark is a reading the account plane should not have
// sent, so it earns a diagnostic line — but not a refusal on screen, because the
// figure a person is looking at is CORRECT and is correct precisely because the guard
// dropped the lower one. There is nothing for them to act on. It is not a tripwire
// either: `TRIPWIRE_KINDS` names console-invariant breaches, none of which this is,
// and a development registry throws on report — which would turn a daemon's
// out-of-order tail into a crashed console. The line is emitted ONCE for the life of
// the reading, on the same reasoning `TRIPWIRE_REPORT_CAP` records: a wire that keeps
// sending regressive readings is one condition, not thousands.

import {
  ProviderAccountListResponseSchema,
  ProviderAccountNotificationSchema,
  ProviderAccountSubscribeRequestSchema,
  type ProviderAccountNotification,
  type ProviderAccountUsageWindow,
} from "@ai-sidekicks/contracts";

import { normalizeWireRejection } from "../../../../shared/wire-errors.js";
import {
  PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP,
  isConsoleRefusal,
  refuse,
  type ConsoleRefusal,
} from "../core/index.js";
import {
  PROVIDER_ACCOUNT_LIST_METHOD,
  PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
  callDaemon,
  subscribeNodeDaemon,
} from "./daemon-calls.js";
import { ProviderQuotaFold, type ProviderQuotaReading } from "./provider-quota-fold.js";
import type { ConsoleBridge } from "./console-bridge.js";

/** The subsystem name every refusal this module raises carries. */
export const PROVIDER_QUOTA_REFUSAL_ORIGIN = "provider-account-quota";

/** How the registry read has gone. Three answers, and none of them is an empty list. */
export type ProviderQuotaReadPhase = "reading" | "read" | "refused";

/** What the account plane answered, and why it did not where it did not. */
export interface ProviderQuotaReadout {
  /** One reading per `(accountId, limitId)`, ordered by account then limit label. */
  readonly readings: readonly ProviderQuotaReading[];
  readonly phase: ProviderQuotaReadPhase;
  /**
   * Why the registry could not be read.
   *
   * Carried rather than swallowed. A chip's absence is not a health reading, so a
   * read that failed and a node whose quotas are all healthy would otherwise look
   * identical — and the one a person needs to act on is the one that says nothing.
   */
  readonly readRefusal: ConsoleRefusal | undefined;
}

/**
 * One bridge's live account-plane reading, and everyone watching it.
 *
 * A class with private fields rather than a hook's state, because every surface in
 * the window asks the same node-scoped question: the first watcher opens the tail
 * and takes the read once, and the second is handed the reading already in hand.
 * How many of these exist and how long each lives is `provider-quota-feed.ts`'s,
 * exactly as `queue-feed.ts` owns that for `queue-reading.ts`.
 */
export class NodeProviderQuotaReading {
  readonly #bridge: ConsoleBridge;
  readonly #listeners = new Set<() => void>();
  readonly #onIdle: () => void;
  readonly #fold = new ProviderQuotaFold();
  #pendingNotifications: ProviderAccountNotification[] = [];
  #closeStream: (() => void) | undefined = undefined;
  #isOpen = false;
  #isSeedReadPending = false;
  // Identifies the read attempt a reply belongs to. A reply whose ordinal has moved
  // on was abandoned by an overflow re-read and seats nothing — without it the
  // abandoned snapshot would land after the fresh one and undo it.
  #seedReadOrdinal = 0;
  #hasReportedHighWaterDrop = false;
  #phase: ProviderQuotaReadPhase = "reading";
  #readRefusal: ConsoleRefusal | undefined = undefined;
  #readout: ProviderQuotaReadout;

  public constructor(bridge: ConsoleBridge, onIdle: () => void) {
    this.#bridge = bridge;
    this.#onIdle = onIdle;
    this.#readout = this.#composeReadout();
  }

  /** The reading as it stands. One object for every watcher, stable between changes. */
  public snapshot = (): ProviderQuotaReadout => this.#readout;

  /** Watch the reading. The first watcher opens it; the last to leave closes it. */
  public watch(listener: () => void): () => void {
    this.#listeners.add(listener);
    this.#open();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#close();
        this.#onIdle();
      }
    };
  }

  #open(): void {
    if (this.#isOpen) {
      return;
    }
    this.#isOpen = true;

    // The stream's own registered request, parsed rather than assumed. It is empty
    // by design and parsing it is still the claim that this console sends what the
    // registry declares — an extra member would be refused here rather than travel.
    const subscribeRequest = ProviderAccountSubscribeRequestSchema.safeParse({});
    if (!subscribeRequest.success) {
      this.#settleRefused(
        refuse(
          PROVIDER_QUOTA_REFUSAL_ORIGIN,
          "request-unreadable",
          "The provider-account subscription's registered request did not parse, so the console did not open it.",
        ),
      );
      return;
    }

    try {
      this.#closeStream = subscribeNodeDaemon(
        this.#bridge,
        PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
        (payload) => {
          this.#deliver(payload);
        },
      );
    } catch (streamRejection: unknown) {
      // The read is deliberately NOT attempted after this. The tail is what keeps
      // the quotas current, and a list read once off a bridge that could not open a
      // stream is a reading that stops being true the moment it lands.
      this.#settleRefused(streamRefusalFor(streamRejection));
      return;
    }

    this.#seedRead();
  }

  /**
   * Take the registry snapshot, holding the tail's notifications across it.
   *
   * Called again on buffer overflow, which is why the attempt carries an ordinal:
   * whichever read is newest is the only one whose reply may seat anything.
   */
  #seedRead(): void {
    this.#seedReadOrdinal += 1;
    const readOrdinal = this.#seedReadOrdinal;
    this.#isSeedReadPending = true;
    this.#pendingNotifications = [];

    void callDaemon(this.#bridge, PROVIDER_ACCOUNT_LIST_METHOD, {})
      .then((reply) => {
        if (!this.#isOpen || this.#seedReadOrdinal !== readOrdinal) {
          return;
        }
        const parsed = ProviderAccountListResponseSchema.safeParse(reply);
        if (!parsed.success) {
          // The held notifications are replayed even here. They are not waiting on
          // this snapshot for correctness — they were waiting so the snapshot could
          // not overwrite them — and with no snapshot they are the only reading the
          // console has.
          this.#replayHeldNotifications();
          this.#settleRefused(
            refuse(
              PROVIDER_QUOTA_REFUSAL_ORIGIN,
              "reply-unreadable",
              "The provider-account reply did not match the registered list shape, so the console read no quotas from it.",
            ),
          );
          return;
        }
        for (const account of parsed.data.accounts) {
          this.#fold.seatAccount(account);
        }
        for (const usageWindow of parsed.data.usageWindows) {
          this.#mergeWindow(usageWindow);
        }
        this.#phase = "read";
        this.#replayHeldNotifications();
        this.#publish();
      })
      .catch((rejection: unknown) => {
        if (!this.#isOpen || this.#seedReadOrdinal !== readOrdinal) {
          return;
        }
        this.#replayHeldNotifications();
        const wireError = normalizeWireRejection(rejection, { total: true });
        this.#settleRefused(
          refuse(PROVIDER_QUOTA_REFUSAL_ORIGIN, wireError.name, wireError.message),
        );
      });
  }

  /**
   * Apply everything held across the read, in arrival order, and stop holding.
   *
   * Order is what makes this correct: a removal followed by a re-registration and the
   * reverse pair are the same two frames, and only their sequence says which state the
   * registry ended in. Every caller publishes after it, so the replay itself does not.
   */
  #replayHeldNotifications(): void {
    this.#isSeedReadPending = false;
    const held = this.#pendingNotifications;
    this.#pendingNotifications = [];
    for (const notification of held) {
      this.#applyNotification(notification);
    }
  }

  #close(): void {
    this.#isOpen = false;
    this.#closeStream?.();
    this.#closeStream = undefined;
  }

  /**
   * One notification off the tail.
   *
   * A payload the registered union does not admit changes nothing at all: it is a
   * frame this build cannot read, and guessing at it would be worse than ignoring it.
   * A readable one either moves the fold now or is held until the opening read has
   * seated — which is a question of ORDER and never of whether it is applied.
   */
  #deliver(payload: unknown): void {
    if (!this.#isOpen) {
      return;
    }
    const parsed = ProviderAccountNotificationSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    if (this.#isSeedReadPending) {
      this.#holdAcrossSeedRead(parsed.data);
      return;
    }
    if (this.#applyNotification(parsed.data)) {
      this.#publish();
    }
  }

  /**
   * Hold one notification until the opening read has seated, or stop holding.
   *
   * Every kind is held rather than only the state-moving ones, so the rule a reader
   * has to carry is one sentence and not a second list of which kinds may be
   * reordered. Past the cap the reading applies what it holds and re-reads: dropping
   * would be the silent loss this buffer exists to prevent, and each re-read is
   * triggered by a full buffer's worth of traffic, so the re-read rate is the tail's
   * rate divided by the cap and converges as the tail quiets.
   */
  #holdAcrossSeedRead(notification: ProviderAccountNotification): void {
    if (this.#pendingNotifications.length < PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP) {
      this.#pendingNotifications.push(notification);
      return;
    }
    this.#replayHeldNotifications();
    this.#applyNotification(notification);
    this.#publish();
    this.#seedRead();
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
        this.#mergeWindow(notification.window);
        return true;
      case "login_completed":
        // Deliberately nothing. A provider reporting its flow finished is not itself
        // a reading; the daemon observes health next and publishes `account_changed`,
        // which is the notification that moves anything here.
        return false;
    }
  }

  /** Merge one reading, and say so once if the monotonicity guard had to hold it. */
  #mergeWindow(usageWindow: ProviderAccountUsageWindow): void {
    const disposition = this.#fold.mergeWindow(usageWindow);
    if (disposition !== "dropped-below-high-water" || this.#hasReportedHighWaterDrop) {
      return;
    }
    this.#hasReportedHighWaterDrop = true;
    console.warn(
      `${PROVIDER_QUOTA_REFUSAL_ORIGIN}: dropped-below-high-water: account ${usageWindow.accountId} limit "${usageWindow.limitId}" reported ${String(usageWindow.usedPercent)}% used inside a window already observed higher; consumption does not fall inside one window, so the higher reading stands. Further such readings are dropped without another line.`,
    );
  }

  #settleRefused(readRefusal: ConsoleRefusal): void {
    this.#phase = "refused";
    this.#readRefusal = readRefusal;
    this.#publish();
  }

  #composeReadout(): ProviderQuotaReadout {
    return {
      readings: this.#fold.readings(),
      phase: this.#phase,
      readRefusal: this.#readRefusal,
    };
  }

  #publish(): void {
    this.#readout = this.#composeReadout();
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/**
 * The refusal an unopenable stream settles as.
 *
 * A refusal the subscription wrapper already composed carries its own origin and
 * code, and the code is what a person pastes into a search; re-wrapping it would
 * replace both. Anything else is a wire rejection and goes through the one
 * normalizer this file already uses on the read's path.
 */
function streamRefusalFor(rejection: unknown): ConsoleRefusal {
  if (typeof rejection === "object" && rejection !== null) {
    const carried = (rejection as { readonly refusal?: unknown }).refusal;
    if (isConsoleRefusal(carried)) {
      return carried;
    }
  }
  const wireError = normalizeWireRejection(rejection, { total: true });
  return refuse(PROVIDER_QUOTA_REFUSAL_ORIGIN, wireError.name, wireError.message);
}
