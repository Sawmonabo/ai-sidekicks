// What is left of each provider account's quota, read from the account plane.
//
// WHERE THIS DATA IS NOT. The composer's rate chips used to fold
// `usage.rate_limit_update` rows out of the session timeline. `Spec-006 §Daemon-Scope
// Event Binding And Node-Scope Anchoring` binds that row to the reserved node-scope
// sentinel session, so no live session store ever held one and the chips could appear
// only under a fixture — a surface nothing would have failed on until someone opened
// it against a daemon.
//
// SO THE READING COMES OFF THE REGISTERED ACCOUNT-PLANE WIRE. `providerAccount.list`
// answers with the accounts and the durable quota rows together, and
// `providerAccount.subscribe` is the live tail beside it. The read is what seeds the
// chips — the subscription is a tail rather than a snapshot replay, so a console that
// only subscribed would show nothing until the next probe or run happened to produce
// an update — and the tail is what keeps them current.
//
// THIS MODULE IS ONE OF THREE, AND THE SPLIT FOLLOWS THE QUEUE READING'S.
// `provider-quota-fold.ts` owns which reading is current for each
// `(accountId, limitId)` and what a surface renders for it — pure, so the
// supersession rules are drivable with no bridge and no React. This module owns the
// WIRE: one read, one tail, and what the console says when either could not be read.
// `provider-quota-feed.ts` owns how many readings exist and how long each lives.
//
// THREE DECISIONS THIS FILE MAKES, each argued where it is made rather than twice.
// The tail opens BEFORE the read, so notifications arriving across it are held and
// replayed rather than silently overwritten by the snapshot (`#seedRead`,
// `#holdAcrossSeedRead`). A delivery outside the registered union is COUNTED as a
// partial read rather than dropped, and the count is never cleared by a snapshot
// (`#deliver`). And a same-window reading below the high-water mark is recorded as a
// diagnostic rather than rendered as a regression (`#mergeWindow`).

import {
  ProviderAccountNotificationSchema,
  ProviderAccountSubscribeRequestSchema,
  type ProviderAccountNotification,
  type ProviderAccountUsageWindow,
} from "@ai-sidekicks/contracts";

import {
  normalizeWireRejection,
  refuse,
  refusedMemberPaths,
  type ConsoleRefusal,
} from "../core/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  RefreshScheduler,
  type ReadTriggerTarget,
  type RefreshReason,
} from "../store/index.js";
import { PROVIDER_ACCOUNT_SUBSCRIBE_STREAM, subscribeNodeDaemon } from "./daemon-streams.js";
import { callDaemon } from "./daemon-reply.js";
import { ProviderQuotaFold, type ProviderQuotaReading } from "./provider-quota-fold.js";
import { ProviderQuotaNotificationHold } from "./provider-quota-notification-hold.js";
import { consoleClockFor, type ConsoleBridge } from "./console-bridge.js";

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
  /**
   * Deliveries that parsed as no registered account-plane notification.
   *
   * Named as `queue-reading.ts` names its own, deliberately: one stream vocabulary
   * for two streams, so a surface rendering both is not reading two words for one
   * fact.
   */
  readonly unreadableDeliveryCount: number;
  /**
   * The newest unreadable delivery's own parse refusal, naming the members that
   * failed. Bounded by keeping only the newest — the refusals do not accumulate —
   * and by naming member paths rather than carrying the payload that failed.
   */
  readonly unreadableRefusal: ConsoleRefusal | undefined;
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
export class NodeProviderQuotaReading implements ReadTriggerTarget {
  /**
   * Nothing in any session's timeline says this node's accounts changed.
   *
   * `providerAccount.subscribe` is the tail that carries every registry change, and
   * the reading is addressed at the NODE — so the empty set is a claim: this reading
   * goes stale when the window has been away, and never because one session appended
   * an event.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #bridge: ConsoleBridge;
  readonly #refresh: RefreshScheduler;
  readonly #listeners = new Set<() => void>();
  readonly #onIdle: () => void;
  readonly #fold = new ProviderQuotaFold();
  readonly #notificationHold = new ProviderQuotaNotificationHold();
  #closeStream: (() => void) | undefined = undefined;
  /**
   * Whether this reading has been forgotten by the registry that held it.
   *
   * Terminal for the reason `queue-reading.ts` states at the same field: a reading
   * revived by a watcher that captured it before the last one left would be live and
   * unregistered, and the next surface would mint a second read and a second tail for
   * the one question this node-scoped reading exists to answer once.
   */
  #isRetired = false;
  #isOpen = false;
  // Identifies the read attempt a reply belongs to. A reply whose ordinal has moved
  // on was abandoned by an overflow re-read and seats nothing — without it the
  // abandoned snapshot would land after the fresh one and undo it.
  #seedReadOrdinal = 0;
  #hasReportedHighWaterDrop = false;
  #unreadableDeliveryCount = 0;
  #unreadableRefusal: ConsoleRefusal | undefined = undefined;
  #phase: ProviderQuotaReadPhase = "reading";
  #readRefusal: ConsoleRefusal | undefined = undefined;
  #readout: ProviderQuotaReadout;

  public constructor(bridge: ConsoleBridge, onIdle: () => void) {
    this.#bridge = bridge;
    this.#onIdle = onIdle;
    this.#refresh = new RefreshScheduler({
      // The fixture's frozen clock wherever a scenario is playing and the real one
      // otherwise, resolved once per reading.
      clock: consoleClockFor(bridge),
      perform: async () => {
        await this.#seedRead();
      },
      // A read that fails is already recorded as this readout's own `readRefusal`.
      onError: () => undefined,
    });
    this.#readout = this.#composeReadout();
  }

  /**
   * Ask for a fresh registry read.
   *
   * The tail keeps the accounts current while it is up; this is what answers for the
   * time it was not. Coalesced by the scheduler, so the surfaces that mount together
   * in one window still cost one call.
   */
  public requestRead(reason: RefreshReason): void {
    if (reason === "subscribe" && this.#isOpen && this.#phase !== "refused") {
      // THE OPEN IS THIS READING'S `subscribe` READ, so a surface arriving to an
      // already-open reading asks for nothing. Two reasons, and both matter: a joiner
      // needs no read because the tail has been keeping the reading current since the
      // first one landed, and the first read must not wait on a clock — the fixture's
      // is frozen and only a scenario beat moves it, so a first read behind the
      // scheduler's window would never happen at all in fixture mode. A reading
      // settled as REFUSED falls through: the joiner's arrival is exactly the reason
      // to try a failed read again.
      return;
    }
    this.#refresh.request(reason);
  }

  /** The reading as it stands. One object for every watcher, stable between changes. */
  public snapshot = (): ProviderQuotaReadout => this.#readout;

  /** Whether this reading has been retired. A retired one serves nobody again. */
  public get isRetired(): boolean {
    return this.#isRetired;
  }

  /** Watch the reading. The first watcher opens it; the last to leave closes it. */
  public watch(listener: () => void): () => void {
    if (this.#isRetired) {
      throw new Error("A retired quota reading was watched; ask the registry for a live one");
    }
    this.#listeners.add(listener);
    this.#open();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#isRetired = true;
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

    // The open's own read, taken now rather than behind the scheduler's window: the
    // tail is already up and holding its notifications across this read. Every LATER
    // read goes through the scheduler.
    void this.#seedRead();
  }

  /**
   * Take the registry snapshot, holding the tail's notifications across it.
   *
   * Called again on buffer overflow, which is why the attempt carries an ordinal:
   * whichever read is newest is the only one whose reply may seat anything.
   */
  async #seedRead(): Promise<void> {
    if (!this.#isOpen) {
      // Requested before the stream opened or after it closed. The registry it would
      // describe is not this reading's any more, and the notification hold it would
      // begin has nothing to release it.
      return;
    }
    this.#seedReadOrdinal += 1;
    const readOrdinal = this.#seedReadOrdinal;
    this.#notificationHold.begin();

    await callDaemon(this.#bridge, "providerAccount.list", {}).then((reply) => {
      if (!this.#isOpen || this.#seedReadOrdinal !== readOrdinal) {
        return;
      }
      // The held notifications are replayed on BOTH arms, and on the served arm they
      // are replayed LAST. They were never waiting on this snapshot for correctness —
      // they were waiting so the snapshot could not overwrite them — and the snapshot
      // is a reading taken at an instant the tail has already moved past, so seating
      // it over a held removal resurrects an account the node has dropped and seats a
      // superseded credential generation over a newer one. On the refused arm there
      // is no snapshot and they are the only reading the console has.
      if (reply.status === "refused") {
        this.#replayHeldNotifications();
        this.#settleRefused(reply.refusal);
        return;
      }
      for (const account of reply.value.accounts) {
        this.#fold.seatAccount(account);
      }
      for (const usageWindow of reply.value.usageWindows) {
        this.#mergeWindow(usageWindow);
      }
      this.#phase = "read";
      this.#replayHeldNotifications();
      this.#publish();
    });
  }

  /**
   * Apply everything held across the read, in arrival order, and stop holding.
   *
   * Every caller publishes after it, so the replay itself does not.
   */
  #replayHeldNotifications(): void {
    for (const notification of this.#notificationHold.release()) {
      this.#applyNotification(notification);
    }
  }

  #close(): void {
    this.#isOpen = false;
    this.#refresh.dispose();
    this.#closeStream?.();
    this.#closeStream = undefined;
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
  #deliver(payload: unknown): void {
    if (!this.#isOpen) {
      return;
    }
    const parsed = ProviderAccountNotificationSchema.safeParse(payload);
    if (!parsed.success) {
      // EVERY delivery publishes, readable or not. One this build cannot read moves
      // no account and no window — the fold never saw it — but it does change what
      // the chips MEAN, and a count that never reached a render could not say so.
      //
      // NOTHING EVER CLEARS THIS COUNT, which is where this stream deliberately
      // differs from the queue's. That snapshot restates its whole list at one moment
      // and supersedes what preceded it; this read answers for an instant the tail has
      // already moved past — the very reason frames are held across it — so it may not
      // claim to cover a frame that arrived after it. And a payload outside the
      // registered union is a BUILD-level fact rather than a transient one: the same
      // shape keeps arriving unreadable, and a count that reset would report a live
      // gap as closed.
      this.#unreadableDeliveryCount += 1;
      this.#unreadableRefusal = unreadableDeliveryRefusal(parsed.error.issues);
      this.#publish();
      return;
    }
    if (this.#notificationHold.isHolding) {
      this.#holdAcrossSeedRead(parsed.data);
      return;
    }
    if (this.#applyNotification(parsed.data)) {
      this.#publish();
    }
  }

  /** Hold one notification across the opening read, or take the overflow's way out. */
  #holdAcrossSeedRead(notification: ProviderAccountNotification): void {
    if (this.#notificationHold.hold(notification) === "held") {
      return;
    }
    // Overflowed: apply what is held plus the frame that overflowed, and take a FRESH
    // read whose reply supersedes the one now in flight. Nothing is dropped.
    this.#replayHeldNotifications();
    this.#applyNotification(notification);
    this.#publish();
    // Straight to the read and deliberately NOT through the scheduler. The scheduler
    // exists to coalesce reasons the world outside supplies, and coalescing costs a
    // debounce window; this is the reading repairing ITSELF, and a repair that waited
    // would leave the console holding a readout it has already established is behind.
    void this.#seedRead();
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
      unreadableDeliveryCount: this.#unreadableDeliveryCount,
      unreadableRefusal: this.#unreadableRefusal,
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
 * One unreadable delivery as the refusal a surface renders.
 *
 * Names the failing MEMBER PATHS and never the payload: the payload is a frame this
 * build could not read, so quoting it would put an unbounded and unvalidated value on
 * screen to explain why an unvalidated value was refused. The path set is fixed by
 * the registered union, which is what bounds the sentence without a cap to spend.
 */
function unreadableDeliveryRefusal(
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): ConsoleRefusal {
  return refuse(
    PROVIDER_QUOTA_REFUSAL_ORIGIN,
    "delivery-unreadable",
    `A provider-account delivery did not match the registered notification shape, so it moved no account or quota here: ${refusedMemberPaths(issues).join(", ")}.`,
  );
}

/**
 * The refusal an unopenable stream settles as.
 *
 * The console's ONE reading of a rejected promise, consumed rather than re-derived:
 * it unwraps a carried refusal structurally — which keeps the subscription wrapper's
 * own code intact rather than replacing it with this module's — and reads a typed
 * envelope's dotted code off `data.type`, where a `{ code: string }` guard cannot see
 * it. This module supplies only the origin and the sentence for a rejection that said
 * nothing machine-readable.
 */
function streamRefusalFor(rejection: unknown): ConsoleRefusal {
  // No fallback pair, on the queue reading's rule next door: a stream that would not
  // open failed for a transport reason the transport itself states, and a house
  // sentence would displace the one diagnosis a person can act on.
  return normalizeWireRejection(PROVIDER_QUOTA_REFUSAL_ORIGIN, rejection);
}
