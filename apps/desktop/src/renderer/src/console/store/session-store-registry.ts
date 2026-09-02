// Who owns a session store's life.
//
// `Spec-023 §Console Design (Meridian)` puts one zustand store behind each OPEN
// session. That sentence needs an owner, and until this class there was none: the
// composition root held a bare `Map` in a ref and constructed a store inside a
// render body, which is the shape the design rules reject — a store created during
// render is created again on any discarded render pass, and every event applied to
// the discarded one is silently gone.
//
// So the lifecycle lives here, in one encapsulated class. What ONE open session is
// made of — its store, its apply queue, its refresh scheduler, and the repair loop
// that binds them — lives beside it in `open-session-entry.ts`; this module owns
// only the set: which sessions are open, who is told when that set changes, and
// which entry a delivery is routed to.
//
// TWO OPENS OF ONE SESSION ARE ONE STORE. `open` is idempotent by session id — a
// second call returns the store the first made, because two stores for one session
// would each hold half the event stream and every surface would render whichever
// half it happened to be handed.
//
// It reads no wire itself. The `read` performer is supplied by the composition
// root, which is what keeps this family below `bridge/` in the console's DAG.

import {
  ConsoleRefusalError,
  Emitter,
  refuse,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../core/index.js";
import type { ConsoleSessionEvent } from "./entities.js";
import { OpenSessionEntry, type OpenSessionEntryOptions } from "./open-session-entry.js";
import type { RefreshReason } from "./scheduling.js";
import type { SessionStore } from "./session-store.js";

/** The origin every refusal this module raises names. */
export const SESSION_REGISTRY_ORIGIN = "session-store-registry";

/** What happened to the set of open sessions. */
export interface SessionRegistryChange {
  readonly sessionId: string;
  readonly change: "opened" | "closed";
}

/**
 * Construction inputs.
 *
 * An alias rather than a second declaration: the registry hands its options
 * straight through to every entry it opens, so the two shapes are one shape and
 * this name exists to keep the public one a caller reaches for. Declaring the
 * fields again here would be a copy that can drift.
 */
export type SessionStoreRegistryOptions = OpenSessionEntryOptions;

export class SessionStoreRegistry {
  readonly #options: SessionStoreRegistryOptions;
  readonly #entriesBySessionId = new Map<string, OpenSessionEntry>();
  readonly #changes = new Emitter<SessionRegistryChange>("session registry change");
  // The open set as an array, rebuilt only when the set itself changes.
  //
  // Load-bearing rather than a micro-optimisation: `useSyncExternalStore` compares
  // consecutive reads with `Object.is` and re-renders while they differ, so a getter
  // that spread the map on every call would hand React a fresh array every pass and
  // spin forever. Every mutation below is paired with `#forgetOpenSessionIds`, so the
  // cache cannot outlive the set it describes.
  #openSessionIdsSnapshot: readonly string[] | undefined = undefined;
  #disposed = false;

  public constructor(options: SessionStoreRegistryOptions) {
    this.#options = options;
  }

  /**
   * Open a session, or return the store it already has.
   *
   * Idempotent by design, so a second surface opening the same session joins the
   * first one's store rather than starting a rival projection of the same stream.
   */
  public open(sessionId: string): SessionStore {
    const existing = this.#entriesBySessionId.get(sessionId);
    if (existing !== undefined) {
      return existing.store;
    }
    if (this.#disposed) {
      // The one seam here where a refusal travels as an exception rather than as a
      // value: `open` owes the caller a store and there is none, so there is no
      // return channel for a refusal to ride.
      throw new ConsoleRefusalError(
        refuse(
          SESSION_REGISTRY_ORIGIN,
          "registry-disposed",
          `cannot open session ${sessionId}: this window's session registry has been disposed.`,
        ),
      );
    }
    const entry = new OpenSessionEntry(sessionId, this.#options);
    this.#entriesBySessionId.set(sessionId, entry);
    this.#forgetOpenSessionIds();
    this.#changes.emit({ sessionId, change: "opened" });
    return entry.store;
  }

  /** The store for an open session, or `undefined`. Never opens one as a side effect. */
  public peek(sessionId: string): SessionStore | undefined {
    return this.#entriesBySessionId.get(sessionId)?.store;
  }

  public has(sessionId: string): boolean {
    return this.#entriesBySessionId.has(sessionId);
  }

  public get openCount(): number {
    return this.#entriesBySessionId.size;
  }

  /**
   * Open sessions in the order they were opened.
   *
   * A STABLE reference between changes: the same array comes back until a session
   * opens or closes, which is what lets a React subscription read this directly.
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
   * Hand wire events to a session's apply queue.
   *
   * Returns a refusal rather than throwing when the session is not open: a late
   * delivery for a session a person just closed is ordinary, and a throw would
   * make the bridge's own subscription the thing that breaks.
   */
  public enqueue(
    sessionId: string,
    events: readonly ConsoleSessionEvent[],
  ): ConsoleRefusal | undefined {
    const entry = this.#entriesBySessionId.get(sessionId);
    if (entry === undefined) {
      return this.#sessionNotOpen(sessionId, "apply events to");
    }
    entry.applyQueue.enqueueAll(events);
    return undefined;
  }

  /** Drain a session's queue now, without waiting for its coalescing window. */
  public flush(sessionId: string): ConsoleRefusal | undefined {
    const entry = this.#entriesBySessionId.get(sessionId);
    if (entry === undefined) {
      return this.#sessionNotOpen(sessionId, "flush");
    }
    entry.applyQueue.flush();
    return undefined;
  }

  /** Ask for a re-read of one session, through its scheduler. Never a direct read. */
  public requestRefresh(sessionId: string, reason: RefreshReason): ConsoleRefusal | undefined {
    const entry = this.#entriesBySessionId.get(sessionId);
    if (entry === undefined) {
      return this.#sessionNotOpen(sessionId, "refresh");
    }
    entry.refreshScheduler.request(reason);
    return undefined;
  }

  /** Ask for a re-read of every open session — the window-focus and reconnect path. */
  public requestRefreshOfEverySession(reason: RefreshReason): void {
    for (const entry of this.#entriesBySessionId.values()) {
      entry.refreshScheduler.request(reason);
    }
  }

  /** How many reads a session's scheduler has performed. The coalescing assertion. */
  public refreshCountFor(sessionId: string): number {
    return this.#entriesBySessionId.get(sessionId)?.refreshScheduler.performCount ?? 0;
  }

  /** How many drains a session's queue has performed. The coalescing assertion. */
  public applyDrainCountFor(sessionId: string): number {
    return this.#entriesBySessionId.get(sessionId)?.applyQueue.drainCount ?? 0;
  }

  /**
   * Subscribe to opens and closes.
   *
   * Through `core`'s one emitter rather than a hand-rolled listener set, so a
   * listener that unsubscribes another during delivery cannot make that other one
   * miss the event it was still subscribed for, and one throwing listener does not
   * silence the rest.
   */
  public subscribe(listener: (change: SessionRegistryChange) => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /** Listeners attached. Read by tests and by the diagnostics surface. */
  public get listenerCount(): number {
    return this.#changes.sinkCount;
  }

  /** True once `disposeAll` has run. A disposed registry opens nothing. */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Whether a store this registry opens can ever reach a base state.
   *
   * `false` when the caller passed a refusal instead of a reader: every refresh
   * reason a session raises — focus, reconnect, a gap re-pull — resolves nothing,
   * so `initialise` is never called and the store buffers what it is given and
   * projects none of it. Read by whatever would otherwise feed it, which is the
   * one decision this fact exists to inform.
   */
  public get canInitialiseSessionStores(): boolean {
    return typeof this.#options.read === "function";
  }

  /**
   * Why no store here can be initialised, or `undefined` when one can.
   *
   * The other half of the boolean above, and the half a surface renders. Kept as a
   * read on the registry rather than left with the composition root, so the one
   * object that knows a store cannot reach a base state is also the one that can
   * say why — a caller holding the boolean and hunting for the reason elsewhere is
   * how two answers to one question get out of step.
   */
  public get readRefusal(): ConsoleRefusal | undefined {
    return typeof this.#options.read === "function" ? undefined : this.#options.read;
  }

  /** Close every session and drop every listener. The window is going away. */
  public disposeAll(): void {
    for (const sessionId of [...this.#entriesBySessionId.keys()]) {
      this.close(sessionId);
    }
    this.#changes.clear();
    this.#disposed = true;
  }

  /** Drop the cached open set. Called from the two places that change it. */
  #forgetOpenSessionIds(): void {
    this.#openSessionIdsSnapshot = undefined;
  }

  #sessionNotOpen(sessionId: string, attempted: string): ConsoleRefusal {
    return refuse(
      SESSION_REGISTRY_ORIGIN,
      "session-not-open",
      `cannot ${attempted} session ${sessionId}: it is not open in this window. Open it before delivering to it, or drop the delivery.`,
    );
  }
}
