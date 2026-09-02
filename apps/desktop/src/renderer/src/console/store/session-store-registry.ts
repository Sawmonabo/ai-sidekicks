// Who owns a session store's life.
//
// `Spec-023 §Console Design (Meridian)` puts one zustand store behind each OPEN
// session. That sentence needs an owner, and until this class there was none: the
// composition root held a bare `Map` in a ref and constructed a store inside a
// render body, which is the shape the design rules reject — a store created during
// render is created again on any discarded render pass, and every event applied to
// the discarded one is silently gone.
//
// So the lifecycle lives here, in one encapsulated class, and it owns three things
// per session rather than one:
//
//   • the `SessionStore` itself;
//   • the `ApplyQueue` in front of its apply chokepoint, so a burst of wire events
//     is one transition and one render instead of N;
//   • the `RefreshScheduler` behind its re-pull, so every read is coalesced with an
//     absolute deadline and two reads never overlap.
//
// The three are created together and disposed together on purpose. A queue that
// outlived its store would drain into a dead object; a scheduler that outlived its
// store would arm a timer for a pane that is gone. Binding them to one entry makes
// both unrepresentable rather than merely discouraged.
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
  RealClock,
  refuse,
  type ConsoleClock,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../core/index.js";
import type { ConsoleSessionEvent, EntityProjectorRegistry } from "./entities.js";
import { ApplyQueue, RefreshScheduler, type RefreshReason } from "./scheduling.js";
import { SessionStore, type SessionSnapshot } from "./session-store.js";

/** The origin every refusal this module raises names. */
export const SESSION_REGISTRY_ORIGIN = "session-store-registry";

/**
 * The read a refresh performs.
 *
 * Returns the snapshot to establish, or `undefined` for "nothing was read" — the
 * honest answer while a session's wire is unregistered, and deliberately not an
 * empty snapshot, which would tell the store the session is genuinely empty and
 * clear its degraded flag on a read that never happened.
 */
export type SessionSnapshotReader = (
  sessionId: string,
  reasons: readonly RefreshReason[],
) => Promise<SessionSnapshot | undefined>;

/**
 * The `read` a registry takes when NO wire can serve one at all.
 *
 * Deliberately a distinct value rather than a reader that resolves `undefined`,
 * because the two say different things and one caller acts on the difference. A
 * registered reader resolving `undefined` is a read that happened and found
 * nothing — transient, and the next refresh may well succeed. This value is the
 * standing fact that no read exists, which is what lets a caller answer the
 * question a function-shaped placeholder cannot be asked: can a store this
 * registry opens ever be initialised? A stream bound to one that cannot is a
 * stream buffered forever and projected never.
 */
export const SESSION_READ_UNREGISTERED = "session-read-unregistered";

/** What a registry does about reads: perform one, or have none to perform. */
export type SessionSnapshotRead = SessionSnapshotReader | typeof SESSION_READ_UNREGISTERED;

/** What happened to the set of open sessions. */
export interface SessionRegistryChange {
  readonly sessionId: string;
  readonly change: "opened" | "closed";
}

export interface SessionStoreRegistryOptions {
  /**
   * The read every session's refresh scheduler performs. REQUIRED, and required
   * on purpose: a refresh path with no read is a timer that fires into nothing,
   * so a caller with no wire yet passes `SESSION_READ_UNREGISTERED` and says so at
   * the call site rather than getting that behaviour by default.
   */
  readonly read: SessionSnapshotRead;
  /** Defaults to `RealClock`. Every queue and scheduler this registry makes shares it. */
  readonly clock?: ConsoleClock;
  /** Event-kind projectors handed to each store it opens. */
  readonly projectors?: EntityProjectorRegistry;
  /** Timeline rows each store retains. */
  readonly timelineCap?: number;
  /** Apply-queue coalescing window. `0` means one drain per paint. */
  readonly applyCoalesceMs?: number;
  readonly refreshDebounceMs?: number;
  readonly refreshMaxWaitMs?: number;
}

/** One open session: its store and the two schedulers bound to it. */
class OpenSessionEntry {
  public readonly store: SessionStore;
  public readonly applyQueue: ApplyQueue;
  public readonly refreshScheduler: RefreshScheduler;

  public constructor(sessionId: string, options: SessionStoreRegistryOptions) {
    const clock = options.clock ?? new RealClock();
    this.store = new SessionStore({
      sessionId,
      ...(options.projectors === undefined ? {} : { projectors: options.projectors }),
      ...(options.timelineCap === undefined ? {} : { timelineCap: options.timelineCap }),
    });
    this.applyQueue = new ApplyQueue({
      clock,
      // The one place a batch of wire events reaches the store. Nothing else in
      // the console calls `applyBatch`, which is what makes the chokepoint a
      // structural property rather than a convention.
      drain: (events) => {
        this.store.applyBatch(events);
      },
      ...(options.applyCoalesceMs === undefined ? {} : { coalesceMs: options.applyCoalesceMs }),
    });
    this.refreshScheduler = new RefreshScheduler({
      clock,
      perform: async (reasons) => {
        if (options.read === SESSION_READ_UNREGISTERED) {
          return;
        }
        const snapshot = await options.read(sessionId, reasons);
        if (snapshot !== undefined) {
          // A completed re-pull is the ONE thing that clears the sticky degraded
          // flag — `initialise` does that — which is why the read lands here and
          // not on a caller that might forget.
          this.store.initialise(snapshot);
        }
      },
      // A failed read is a real degradation with a named cause, not an unhandled
      // rejection: the surface renders "could not re-read" instead of stale rows
      // that look current.
      onError: () => {
        this.store.markDegraded("read-failed");
      },
      ...(options.refreshDebounceMs === undefined ? {} : { debounceMs: options.refreshDebounceMs }),
      ...(options.refreshMaxWaitMs === undefined ? {} : { maxWaitMs: options.refreshMaxWaitMs }),
    });
  }

  public dispose(): void {
    this.applyQueue.dispose();
    this.refreshScheduler.dispose();
  }
}

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
   * `false` when the caller passed `SESSION_READ_UNREGISTERED`: every refresh
   * reason a session raises — focus, reconnect, a gap re-pull — resolves nothing,
   * so `initialise` is never called and the store buffers what it is given and
   * projects none of it. Read by whatever would otherwise feed it, which is the
   * one decision this fact exists to inform.
   */
  public get canInitialiseSessionStores(): boolean {
    return this.#options.read !== SESSION_READ_UNREGISTERED;
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
