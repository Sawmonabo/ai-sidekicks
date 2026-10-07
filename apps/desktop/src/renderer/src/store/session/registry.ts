// Who owns a session store's life. A store needs an owner outside React: one created during render
// is created again on a discarded pass, and every event applied to the discarded one is gone. What
// one open session is made of lives in `store/session/open/entry.ts`; this module owns the set:
// which sessions are open, who is told when it changes, and which entry a delivery reaches.
//
// Two opens of one session are one store: `open` is idempotent by session id, since two stores
// would each hold half the stream. It reads no wire; the composition root supplies `read`, which
// keeps `store/` below `services/` in the import direction.

import type { EventCursor } from "@ai-sidekicks/contracts/session/id";

import { RefusalError, refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import type { ProjectedSessionEvent } from "./entities/vocabulary.js";
import {
  OpenSessionEntry,
  type OpenSessionEntryOptions,
  type SessionStreamPosition,
} from "./open/entry.js";
import type { RefreshReason } from "#renderer/lib/reads/refresh/scheduler.js";
import type { SessionDegradedCause } from "./degradation.js";
import type { SessionStore } from "./store.js";

/** The origin every refusal this module raises names. */
export const SESSION_REGISTRY_ORIGIN = "session-store-registry";

/** What happened to the set of open sessions. */
export interface SessionRegistryChange {
  readonly sessionId: string;
  readonly change: "opened" | "closed";
}

/** Where one open session's stream opens, named each time a read moves its window. */
export interface SessionStreamOpening extends SessionStreamPosition {
  readonly sessionId: string;
}

/** The set of open sessions in one window; owns each session's entry and routes deliveries. */
export class SessionStoreRegistry {
  readonly #options: OpenSessionEntryOptions;
  readonly #entriesBySessionId = new Map<string, OpenSessionEntry>();
  readonly #changes = new Emitter<SessionRegistryChange>("session registry change");
  // Apart from `#changes`, whose listeners re-render on any change of the open set.
  readonly #streamOpenings = new Emitter<SessionStreamOpening>("session stream opening");
  // The open set as an array, rebuilt only when the set changes. Load-bearing:
  // `useSyncExternalStore` re-renders while consecutive reads differ by `Object.is`, so a getter
  // spreading the map per call would spin forever. Every mutation pairs with
  // `#forgetOpenSessionIds`.
  #openSessionIdsSnapshot: readonly string[] | undefined = undefined;
  #disposed = false;

  public constructor(options: OpenSessionEntryOptions) {
    this.#options = options;
  }

  /**
   * Open a session, or return the store it already has, so a second view joins the first one's
   * store rather than starting a rival projection. Throws a `RefusalError` once disposed.
   */
  public open(sessionId: string): SessionStore {
    const existing = this.#entriesBySessionId.get(sessionId);
    if (existing !== undefined) {
      return existing.store;
    }
    if (this.#disposed) {
      // `open` owes the caller a store, so a refusal has no return channel and travels as a throw.
      throw new RefusalError(
        refuse(
          SESSION_REGISTRY_ORIGIN,
          "registry-disposed",
          `cannot open session ${sessionId}: this window's session registry has been disposed.`,
        ),
      );
    }
    const entry = new OpenSessionEntry(sessionId, this.#options);
    // Released by `entry.dispose`, which drops every position listener.
    entry.subscribeToStreamPosition((position) => {
      this.#streamOpenings.emit({ sessionId, ...position });
    });
    this.#entriesBySessionId.set(sessionId, entry);
    this.#forgetOpenSessionIds();
    this.#changes.emit({ sessionId, change: "opened" });
    return entry.store;
  }

  /** The store for an open session, or `undefined`. Never opens one as a side effect. */
  public peek(sessionId: string): SessionStore | undefined {
    return this.#entriesBySessionId.get(sessionId)?.store;
  }

  /** Whether a session is open. */
  public has(sessionId: string): boolean {
    return this.#entriesBySessionId.has(sessionId);
  }

  /** How many sessions are open. An assertion seam for tests; views read `openSessionIds`. */
  public get openCount(): number {
    return this.#entriesBySessionId.size;
  }

  /**
   * Open sessions in the order they were opened. The same array comes back until a session opens
   * or closes, so a React subscription can read it directly.
   */
  public get openSessionIds(): readonly string[] {
    this.#openSessionIdsSnapshot ??= [...this.#entriesBySessionId.keys()];
    return this.#openSessionIdsSnapshot;
  }

  /**
   * Close a session: drop its queued events, disarm its scheduler, forget its
   * store. Returns whether anything was open. Idempotent.
   */
  public close(sessionId: string): boolean {
    const entry = this.#entriesBySessionId.get(sessionId);
    if (entry === undefined) {
      return false;
    }
    entry.dispose();
    this.#entriesBySessionId.delete(sessionId);
    this.#forgetOpenSessionIds();
    this.#changes.emit({ sessionId, change: "closed" });
    return true;
  }

  /**
   * Hand wire events to a session's apply queue. Returns a refusal rather than throwing when the
   * session is not open: a late delivery for a just-closed session is ordinary, and a throw
   * would break the bridge's own subscription.
   */
  public enqueue(sessionId: string, events: readonly ProjectedSessionEvent[]): Refusal | undefined {
    const entry = this.#entriesBySessionId.get(sessionId);
    if (entry === undefined) {
      return this.#sessionNotOpen(sessionId, "apply events to");
    }
    entry.applyQueue.enqueueAll(events);
    return undefined;
  }

  /** Drain a session's queue now, without waiting for its coalescing window. */
  public flush(sessionId: string): Refusal | undefined {
    const entry = this.#entriesBySessionId.get(sessionId);
    if (entry === undefined) {
      return this.#sessionNotOpen(sessionId, "flush");
    }
    entry.applyQueue.flush();
    return undefined;
  }

  /**
   * Raise a degraded cause on one session's store, from outside the apply path (a read that
   * failed, a subscription that never opened). The subscriber that observes those
   * (`services/session-events/subscriber.ts`) holds no store by design, so the
   * cause travels through the registry like an event does. Answers with a refusal, not a throw,
   * when the session is not open, for `enqueue`'s reason.
   */
  public markDegraded(sessionId: string, cause: SessionDegradedCause): Refusal | undefined {
    const entry = this.#entriesBySessionId.get(sessionId);
    if (entry === undefined) {
      return this.#sessionNotOpen(sessionId, "mark degraded");
    }
    entry.store.markDegraded(cause);
    return undefined;
  }

  /**
   * Where an open session's stream opens, as its last read that moved the window named it, or
   * `undefined` when no read has, or the session is not open.
   */
  public streamPositionFor(sessionId: string): SessionStreamPosition | undefined {
    return this.#entriesBySessionId.get(sessionId)?.streamPosition;
  }

  /** Ask for a re-read of one session, through its scheduler. Never a direct read. */
  public requestRefresh(sessionId: string, reason: RefreshReason): Refusal | undefined {
    const entry = this.#entriesBySessionId.get(sessionId);
    if (entry === undefined) {
      return this.#sessionNotOpen(sessionId, "refresh");
    }
    entry.refreshScheduler.request(reason);
    return undefined;
  }

  /**
   * Tell a session its stream dropped a hole too wide to fill, so its next read skips past it.
   * Answers with a refusal, not a throw, when the session is not open.
   */
  public skipPastStream(sessionId: string): Refusal | undefined {
    const entry = this.#entriesBySessionId.get(sessionId);
    if (entry === undefined) {
      return this.#sessionNotOpen(sessionId, "skip the stream of");
    }
    entry.skipPastStream();
    return undefined;
  }

  /**
   * Tell a session the stream refused the position it was opened after, so its next read opens
   * the window elsewhere. Answers with a refusal, not a throw, when the session is not open.
   */
  public refuseStreamCursor(sessionId: string, cursor: EventCursor): Refusal | undefined {
    const entry = this.#entriesBySessionId.get(sessionId);
    if (entry === undefined) {
      return this.#sessionNotOpen(sessionId, "refuse a stream position of");
    }
    entry.refuseStreamCursor(cursor);
    return undefined;
  }

  /** Ask for a re-read of every open session — the window-focus and reconnect path. */
  public requestRefreshOfEverySession(reason: RefreshReason): void {
    for (const entry of this.#entriesBySessionId.values()) {
      entry.refreshScheduler.request(reason);
    }
  }

  /** How many reads a session's scheduler has performed; an assertion seam for tests. */
  public refreshCountFor(sessionId: string): number {
    return this.#entriesBySessionId.get(sessionId)?.refreshScheduler.performCount ?? 0;
  }

  /** How many drains a session's queue has performed; an assertion seam for tests. */
  public applyDrainCountFor(sessionId: string): number {
    return this.#entriesBySessionId.get(sessionId)?.applyQueue.drainCount ?? 0;
  }

  /**
   * Subscribe to opens and closes, through the shared emitter so a listener unsubscribing another
   * during delivery cannot make it miss the event, and one throwing listener does not silence
   * the rest.
   */
  public subscribe(listener: (change: SessionRegistryChange) => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /**
   * Subscribe to where each session's stream opens: once its first read places the window, and
   * again whenever a read moves it. Through the shared emitter, for `subscribe`'s reasons.
   */
  public subscribeToStreamOpenings(listener: (opening: SessionStreamOpening) => void): Unsubscribe {
    return this.#streamOpenings.subscribe(listener);
  }

  /** True once `disposeAll` has run. A disposed registry opens nothing. */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /** Close every session and drop every listener. The window is going away. */
  public disposeAll(): void {
    for (const sessionId of [...this.#entriesBySessionId.keys()]) {
      this.close(sessionId);
    }
    this.#changes.clear();
    this.#streamOpenings.clear();
    this.#disposed = true;
  }

  /** Drop the cached open set. Called from the two places that change it. */
  #forgetOpenSessionIds(): void {
    this.#openSessionIdsSnapshot = undefined;
  }

  #sessionNotOpen(sessionId: string, attempted: string): Refusal {
    return refuse(
      SESSION_REGISTRY_ORIGIN,
      "session-not-open",
      `cannot ${attempted} session ${sessionId}: it is not open in this ` +
        `window. Open it before delivering to it, or drop the delivery.`,
    );
  }
}
