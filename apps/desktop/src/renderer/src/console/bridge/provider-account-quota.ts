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
// THE FOLD IS THE ONE THE TIMELINE VERSION HAD, MOVED RATHER THAN REWRITTEN: newest
// `observedAt` per `(accountId, limitId)`, with arrival order breaking an exact tie.
// The key is the pair and not the window's duration, because a pinned provider
// surface publishes three distinct windows of the same length and a duration key
// silently collapses them into whichever arrived last.
//
// AND SUPERSESSION IS NOW A COMPARISON THE WIRE ACTUALLY SUPPORTS. The timeline fold
// could only call a reading stale relative to other readings the same session had
// seen. Every quota row carries the `credentialGeneration` it was observed under and
// every account carries the generation it is on now, so a reading behind its own
// account's current generation is stale as a fact rather than as an inference — which
// is what the account plane's own contract asks a renderer to do, because a
// credential-home rebuild does not clear stored readings.

import { useCallback, useSyncExternalStore } from "react";
import {
  ProviderAccountListResponseSchema,
  ProviderAccountNotificationSchema,
  ProviderAccountSubscribeRequestSchema,
  type ProviderAccount,
  type ProviderAccountUsageWindow,
} from "@ai-sidekicks/contracts";

import { normalizeWireRejection } from "../../../../shared/wire-errors.js";
import { isConsoleRefusal, refuse, type ConsoleRefusal } from "../core/index.js";
import {
  PROVIDER_ACCOUNT_LIST_METHOD,
  PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
  callDaemon,
  subscribeNodeDaemon,
} from "./daemon-calls.js";
import type { ConsoleBridge } from "./console-bridge.js";

/** The subsystem name every refusal this module raises carries. */
export const PROVIDER_QUOTA_REFUSAL_ORIGIN = "provider-account-quota";

/** How the registry read has gone. Three answers, and none of them is an empty list. */
export type ProviderQuotaReadPhase = "reading" | "read" | "refused";

/** One provider account's quota in one limit window, as a surface renders it. */
export interface ProviderQuotaReading {
  readonly accountId: string;
  readonly limitId: string;
  /** The account's operator-chosen label. A chip that named no account names nothing. */
  readonly accountLabel: string;
  /**
   * The window's own label where the provider publishes one, and its `limitId`
   * verbatim where it does not.
   *
   * The fallback is the wire's own identifier rather than composed prose: the id is
   * what the provider calls this window, so it is the most specific true thing the
   * console holds, and inventing a name would put a word on screen no provider used.
   */
  readonly limitLabel: string;
  /** Utilization as sent. NOT clamped: a soft limit can genuinely be over-consumed. */
  readonly usedPercent: number;
  /** RFC 3339 where the provider supplied one. A countdown renders only if it did. */
  readonly resetsAt: string | undefined;
  /** RFC 3339 observation instant — the merge key. */
  readonly observedAt: string;
  /**
   * True when this reading was observed under an older credential generation than
   * its own account is on now.
   *
   * A credential-home rebuild does not clear stored readings — the provider-side
   * allowance keeps running while the home is empty — so the reading stays the best
   * figure available and is presented as one taken before the current credential.
   */
  readonly isStale: boolean;
}

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

/** Remaining quota, from the consumed figure the wire supplies. Never sent as such. */
export function remainingPercentOf(reading: ProviderQuotaReading): number {
  // Floored at zero for the same reason the used figure is NOT clamped: the wire may
  // report over-consumption against a soft limit, which is a true reading to show,
  // while a negative remainder is an arithmetic artefact rather than a quota.
  return Math.max(0, 100 - reading.usedPercent);
}

const NO_READINGS: readonly ProviderQuotaReading[] = Object.freeze([]);

/** One quota row with the arrival ordinal that breaks an exact `observedAt` tie. */
interface HeldQuotaWindow {
  readonly usageWindow: ProviderAccountUsageWindow;
  readonly arrivalOrdinal: number;
}

/**
 * One bridge's live account-plane reading, and everyone watching it.
 *
 * A class with private fields rather than a hook's state, because every surface in
 * the window asks the same node-scoped question: the first watcher opens the tail
 * and takes the read once, and the second is handed the reading already in hand.
 */
class NodeProviderQuotaReading {
  readonly #bridge: ConsoleBridge;
  readonly #listeners = new Set<() => void>();
  readonly #onIdle: () => void;
  readonly #accountsById = new Map<string, ProviderAccount>();
  readonly #windowsByKey = new Map<string, HeldQuotaWindow>();
  #closeStream: (() => void) | undefined = undefined;
  #isOpen = false;
  #nextArrivalOrdinal = 0;
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

    void callDaemon(this.#bridge, PROVIDER_ACCOUNT_LIST_METHOD, {})
      .then((reply) => {
        if (!this.#isOpen) {
          return;
        }
        const parsed = ProviderAccountListResponseSchema.safeParse(reply);
        if (!parsed.success) {
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
          this.#accountsById.set(account.accountId, account);
        }
        for (const usageWindow of parsed.data.usageWindows) {
          this.#mergeWindow(usageWindow);
        }
        this.#phase = "read";
        this.#publish();
      })
      .catch((rejection: unknown) => {
        if (!this.#isOpen) {
          return;
        }
        const wireError = normalizeWireRejection(rejection, { total: true });
        this.#settleRefused(
          refuse(PROVIDER_QUOTA_REFUSAL_ORIGIN, wireError.name, wireError.message),
        );
      });
  }

  #close(): void {
    this.#isOpen = false;
    this.#closeStream?.();
    this.#closeStream = undefined;
  }

  /**
   * One notification off the tail.
   *
   * Every kind is a re-entrant state update rather than a delta, so an account that
   * changed is written whole and a removed one takes its readings with it — a quota
   * row whose account has left the registry names an account nothing can label.
   * A payload the registered union does not admit changes nothing at all: it is a
   * frame this build cannot read, and guessing at it would be worse than ignoring it.
   */
  #deliver(payload: unknown): void {
    if (!this.#isOpen) {
      return;
    }
    const parsed = ProviderAccountNotificationSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const notification = parsed.data;
    switch (notification.kind) {
      case "account_changed":
        this.#accountsById.set(notification.account.accountId, notification.account);
        break;
      case "account_removed":
        this.#forgetAccount(notification.accountId);
        break;
      case "usage_window_updated":
        this.#mergeWindow(notification.window);
        break;
      case "login_completed":
        // Deliberately nothing. A provider reporting its flow finished is not itself
        // a reading; the daemon observes health next and publishes `account_changed`,
        // which is the notification that moves anything here.
        return;
    }
    this.#publish();
  }

  /**
   * Drop an account and every reading filed under it.
   *
   * The readings go with the account rather than being left keyed to an id nothing
   * can label: `accountId` is daemon-minted and immutable, so a re-registration
   * mints a NEW one and these rows could never be claimed again — they would sit in
   * the fold for the life of the window describing an account that has left.
   */
  #forgetAccount(accountId: string): void {
    this.#accountsById.delete(accountId);
    for (const [key, held] of this.#windowsByKey) {
      if (held.usageWindow.accountId === accountId) {
        this.#windowsByKey.delete(key);
      }
    }
  }

  /** Newest `observedAt` per `(accountId, limitId)`, arrival order breaking a tie. */
  #mergeWindow(usageWindow: ProviderAccountUsageWindow): void {
    const key = quotaKey(usageWindow.accountId, usageWindow.limitId);
    const held = this.#windowsByKey.get(key);
    const arrival = { usageWindow, arrivalOrdinal: this.#nextArrivalOrdinal };
    this.#nextArrivalOrdinal += 1;
    if (held === undefined || supersedes(arrival, held)) {
      this.#windowsByKey.set(key, arrival);
    }
  }

  #settleRefused(readRefusal: ConsoleRefusal): void {
    this.#phase = "refused";
    this.#readRefusal = readRefusal;
    this.#publish();
  }

  #composeReadout(): ProviderQuotaReadout {
    const readings: ProviderQuotaReading[] = [];
    for (const held of this.#windowsByKey.values()) {
      const account = this.#accountsById.get(held.usageWindow.accountId);
      if (account === undefined) {
        // A reading whose account the registry does not carry is dropped rather than
        // rendered under its opaque id: the chip's first word is whose quota this is,
        // and an id nobody chose answers that question with a value nobody recognises.
        continue;
      }
      readings.push(readingFor(held.usageWindow, account));
    }
    return {
      readings: readings.length === 0 ? NO_READINGS : readings.sort(compareByLabels),
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

/** One window and its account, as a surface renders the pair. */
function readingFor(
  usageWindow: ProviderAccountUsageWindow,
  account: ProviderAccount,
): ProviderQuotaReading {
  return {
    accountId: usageWindow.accountId,
    limitId: usageWindow.limitId,
    accountLabel: account.displayLabel,
    limitLabel: usageWindow.label ?? usageWindow.limitId,
    usedPercent: usageWindow.usedPercent,
    resetsAt: usageWindow.resetsAt,
    observedAt: usageWindow.observedAt,
    isStale: usageWindow.observedCredentialGeneration < account.credentialGeneration,
  };
}

/** The `(accountId, limitId)` pair, spelled once. */
function quotaKey(accountId: string, limitId: string): string {
  return `${accountId} ${limitId}`;
}

function supersedes(candidate: HeldQuotaWindow, held: HeldQuotaWindow): boolean {
  if (candidate.usageWindow.observedAt === held.usageWindow.observedAt) {
    return candidate.arrivalOrdinal > held.arrivalOrdinal;
  }
  return candidate.usageWindow.observedAt > held.usageWindow.observedAt;
}

/**
 * Ordered by label so two renders of one reading place a chip in the same position.
 *
 * Deliberately NOT by urgency: a chip that moves when its own number moves is a chip
 * a person has to re-find at the moment they most need to read it.
 */
function compareByLabels(left: ProviderQuotaReading, right: ProviderQuotaReading): number {
  const byAccount = left.accountLabel.localeCompare(right.accountLabel);
  return byAccount === 0 ? left.limitLabel.localeCompare(right.limitLabel) : byAccount;
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

/**
 * The window's readings, one per bridge.
 *
 * A `WeakMap` on the bridge so a closed window takes its reading with it, and the
 * entry is dropped once nobody is watching.
 */
class NodeProviderQuotaReadings {
  readonly #byBridge = new WeakMap<ConsoleBridge, NodeProviderQuotaReading>();

  public reading(bridge: ConsoleBridge): NodeProviderQuotaReading {
    const held = this.#byBridge.get(bridge);
    if (held !== undefined) {
      return held;
    }
    const created = new NodeProviderQuotaReading(bridge, () => {
      this.#byBridge.delete(bridge);
    });
    this.#byBridge.set(bridge, created);
    return created;
  }
}

const nodeProviderQuotaReadings = new NodeProviderQuotaReadings();

/**
 * Read this node's provider-account quotas.
 *
 * Every consumer on one bridge is served by one read and one subscription. No timer
 * and no poll: the tail is what makes a reading current, and a surface that polled
 * would be asking a registry that already tells it when something moved.
 */
export function useProviderQuotas(bridge: ConsoleBridge): ProviderQuotaReadout {
  const reading = nodeProviderQuotaReadings.reading(bridge);
  const subscribe = useCallback(
    (onReadoutChanged: () => void) => reading.watch(onReadoutChanged),
    [reading],
  );
  return useSyncExternalStore(subscribe, reading.snapshot, reading.snapshot);
}
