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
// THIS MODULE IS ONE OF A FAMILY, AND THE SPLIT FOLLOWS THE QUEUE READING'S.
// `provider-quota-fold.ts` owns which reading is current for each
// `(accountId, limitId)` and what a surface renders for it — pure, so the
// supersession rules are drivable with no bridge and no React.
// `provider-quota-deliveries.ts` owns what arrives on the tail and the order it
// reaches the fold in, and `provider-quota-refusals.ts` the sentences this subsystem
// says when something could not be read. This module owns the WIRE: opening the
// stream, taking the read, holding the tail across it, and composing what every
// watcher sees. `provider-quota-feed.ts` owns how many readings exist and how long
// each lives.
//
// ONE READ, TWO FOLDS. The readout carries the account LABELS beside the quota
// readings because the accounts arrive on this same reply and this same tail: a
// surface joining a paying-account handle to the operator's word for it reads them
// here rather than issuing a second `providerAccount.list` of its own, which would be
// a second arrival order for one registry with nothing able to say which was right.
//
// THE DECISION THIS FILE MAKES is that the tail opens BEFORE the read. Everything
// arriving across the read is therefore held and replayed rather than silently
// overwritten by a snapshot taken at an instant the tail has already moved past
// (`#seedRead`). What is held, in what order it is applied, and what happens when the
// hold overflows are `provider-quota-deliveries.ts`', which is the module this one
// hands every frame to.

import { ProviderAccountSubscribeRequestSchema } from "@ai-sidekicks/contracts";

import { refuse, type ConsoleRefusal } from "../core/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  RefreshScheduler,
  type ReadTriggerTarget,
  type RefreshReason,
} from "../store/index.js";
import { PROVIDER_ACCOUNT_SUBSCRIBE_STREAM, subscribeNodeDaemon } from "./daemon-streams.js";
import { callDaemon } from "./daemon-reply.js";
import { ProviderQuotaFold, type ProviderQuotaReading } from "./provider-quota-fold.js";
import { ProviderQuotaDeliveries } from "./provider-quota-deliveries.js";
import { PROVIDER_QUOTA_REFUSAL_ORIGIN, streamRefusalFor } from "./provider-quota-refusals.js";
import type { UnreadableDeliveryReading } from "./unreadable-deliveries.js";
import { consoleClockFor, type ConsoleBridge } from "./console-bridge.js";

/** How the registry read has gone. Three answers, and none of them is an empty list. */
export type ProviderQuotaReadPhase = "reading" | "read" | "refused";

/** What the account plane answered, and why it did not where it did not. */
export interface ProviderQuotaReadout extends UnreadableDeliveryReading {
  /** One reading per `(accountId, limitId)`, ordered by account then limit label. */
  readonly readings: readonly ProviderQuotaReading[];
  /**
   * Every account the registry carries, `accountId` to `displayLabel`.
   *
   * The same read and the same tail that feed the readings, folded a second way
   * rather than fetched a second time: any surface that names a paying account holds
   * the daemon-minted handle and needs the operator's word for it, and this window
   * has exactly one reader of the account plane. Empty until the read has served,
   * which is what makes a missing entry mean "not read" rather than "no such
   * account" — a consumer renders nothing for one rather than falling back to the
   * handle.
   */
  readonly accountLabels: ReadonlyMap<string, string>;
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
  readonly #deliveries: ProviderQuotaDeliveries;
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
  #phase: ProviderQuotaReadPhase = "reading";
  #readRefusal: ConsoleRefusal | undefined = undefined;
  #readout: ProviderQuotaReadout;

  public constructor(bridge: ConsoleBridge, onIdle: () => void) {
    this.#bridge = bridge;
    this.#onIdle = onIdle;
    // Publishing through this reading's own `#publish` rather than through listeners
    // of its own: one surface, one publication path. The superseding read is asked
    // for straight rather than through the scheduler — the scheduler exists to
    // coalesce reasons the world outside supplies, and coalescing costs a debounce
    // window; this is the reading repairing ITSELF, and a repair that waited would
    // leave the console holding a readout it has already established is behind.
    this.#deliveries = new ProviderQuotaDeliveries(this.#fold, {
      onChanged: () => {
        this.#publish();
      },
      onSupersededRead: () => {
        void this.#seedRead();
      },
    });
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
          // The open check is here rather than inside the tail: a frame arriving
          // after this reading closed belongs to a registry that is no longer its
          // own, and the tail's job starts at the frame it is given.
          if (this.#isOpen) {
            this.#deliveries.deliver(payload);
          }
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
    this.#deliveries.beginHold();

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
        this.#deliveries.releaseHold();
        this.#settleRefused(reply.refusal);
        return;
      }
      for (const account of reply.value.accounts) {
        this.#fold.seatAccount(account);
      }
      for (const usageWindow of reply.value.usageWindows) {
        this.#deliveries.mergeWindow(usageWindow);
      }
      this.#phase = "read";
      this.#deliveries.releaseHold();
      this.#publish();
    });
  }

  #close(): void {
    this.#isOpen = false;
    this.#refresh.dispose();
    this.#closeStream?.();
    this.#closeStream = undefined;
  }

  #settleRefused(readRefusal: ConsoleRefusal): void {
    this.#phase = "refused";
    this.#readRefusal = readRefusal;
    this.#publish();
  }

  #composeReadout(): ProviderQuotaReadout {
    return {
      ...this.#deliveries.unreadable,
      readings: this.#fold.readings(),
      accountLabels: this.#fold.accountLabels(),
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
