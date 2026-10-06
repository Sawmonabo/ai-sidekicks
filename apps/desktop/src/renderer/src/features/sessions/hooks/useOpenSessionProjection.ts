// What every session this window has open can say about itself.
//
// The all-sessions destination is mounted at an address that names no session, so the frame
// opens no route-scoped store for it. The set it needs is the one `SessionStoreRegistry`
// holds, which has no fixed size. React fixes the number of hooks per render, so the fan-out
// lives in the class below and the component takes one `useSyncExternalStore` over it: the
// registry's emitter says when the set moved, each open store's subscription says when its
// projection moved, and both invalidate one cached array.
//
// A subscription is taken for exactly the sessions the registry reports open and dropped when
// one closes, and the whole fan-out is released when the last React subscriber goes, so the
// projection is safe to hold for the life of a window. It also folds the degradation cause
// over the stores it already subscribes to, by `store/session/degradation.ts`'s rule (the
// worst standing cause wins). It projects and does not merge: `session-directory-rows.ts`
// merges with the daemon's directory, and an empty array here claims nothing about the daemon.

import { useRef, useSyncExternalStore } from "react";

import {
  worstDegradedCause,
  type SessionDegradedCause,
} from "#renderer/store/session/degradation.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import type { SessionStoreRegistry } from "#renderer/store/session/registry.js";
import type { SessionListRow } from "../rows/list-row.js";

/** One shared empty projection, so a change with no rows keeps the array identity React sees. */
const NO_PROJECTED_ROWS: readonly SessionListRow[] = [];

/** What the open stores say about themselves, and about how well they are following. */
export interface OpenSessionProjectionReading {
  readonly rows: readonly SessionListRow[];
  readonly degradedCause: SessionDegradedCause | undefined;
  /**
   * The same cause, asked at dispatch rather than read off this render, because it can land
   * between the render that enabled a control and the click. Stable for the life of the
   * registry, so a caller may hold it.
   */
  readonly readDegradedCause: () => SessionDegradedCause | undefined;
}

/**
 * Every open session's projected row, kept current across the open set. A class because it
 * holds state that outlives a render, and the row cache is load-bearing:
 * `useSyncExternalStore` compares reads with `Object.is`, so rebuilding the array per read
 * would spin.
 */
export class OpenSessionRowProjection {
  readonly #registry: SessionStoreRegistry;
  /** One release per store currently subscribed, keyed by its session id. */
  readonly #storeReleases = new Map<string, () => void>();
  readonly #reactSubscribers = new Set<() => void>();
  #registryRelease: (() => void) | undefined = undefined;
  /** The cache. `undefined` means "invalidated", not "empty". */
  #rows: readonly SessionListRow[] | undefined = undefined;

  /**
   * Follow the open set and every store in it while anyone is listening: attached on the first
   * subscriber, released with the last. An arrow property, because `useSyncExternalStore`
   * re-subscribes when this function's identity moves.
   */
  public readonly subscribe = (onProjectionChange: () => void): (() => void) => {
    this.#reactSubscribers.add(onProjectionChange);
    if (this.#reactSubscribers.size === 1) {
      this.#attach();
    }
    return () => {
      this.#reactSubscribers.delete(onProjectionChange);
      if (this.#reactSubscribers.size === 0) {
        this.#release();
      }
    };
  };

  /**
   * The rows, rebuilt only when something changed. Correct before `subscribe` runs, since the
   * build reads the registry directly and React reads a snapshot ahead of the subscribing
   * effect.
   */
  public readonly readRows = (): readonly SessionListRow[] => {
    this.#rows ??= this.#buildRows();
    return this.#rows;
  };

  /**
   * The worst degraded cause standing across every open store, or `undefined`. A primitive,
   * so `Object.is` compares it by value and it needs no cache.
   */
  public readonly readDegradedCause = (): SessionDegradedCause | undefined => {
    return worstDegradedCause(
      ...this.#registry.openSessionIds.map(
        (sessionId) => this.#registry.peek(sessionId)?.snapshot().degradedCause,
      ),
    );
  };

  public constructor(registry: SessionStoreRegistry) {
    this.#registry = registry;
  }

  /** Stores this projection currently holds a subscription on. The bound, observable. */
  public get subscribedSessionIds(): readonly string[] {
    return [...this.#storeReleases.keys()];
  }

  #attach(): void {
    this.#registryRelease = this.#registry.subscribe(() => {
      this.#followOpenSessions();
      this.#invalidate();
    });
    this.#followOpenSessions();
  }

  #release(): void {
    this.#registryRelease?.();
    this.#registryRelease = undefined;
    for (const releaseStore of this.#storeReleases.values()) {
      releaseStore();
    }
    this.#storeReleases.clear();
  }

  /**
   * Bring the subscribed set in line with the open set: drop what closed, take what opened.
   * Survivors are left alone, since re-taking every subscription would drop a notification
   * between the two calls.
   */
  #followOpenSessions(): void {
    const openSessionIds = new Set(this.#registry.openSessionIds);
    for (const [sessionId, releaseStore] of [...this.#storeReleases]) {
      if (openSessionIds.has(sessionId)) {
        continue;
      }
      releaseStore();
      this.#storeReleases.delete(sessionId);
    }
    for (const sessionId of openSessionIds) {
      if (this.#storeReleases.has(sessionId)) {
        continue;
      }
      const store = this.#registry.peek(sessionId);
      if (store === undefined) {
        continue;
      }
      this.#storeReleases.set(sessionId, this.#subscribeToStore(store));
    }
  }

  /**
   * Listen to one store, waking only for the two partitions this projection reads and the
   * degraded cause. The store replaces only the partition a mutation touched, so a burst of
   * run events leaves these references alone and the list does not re-render.
   */
  #subscribeToStore(store: SessionStore): () => void {
    return store.readable.subscribe((state, previousState) => {
      if (
        state.partitions.session === previousState.partitions.session &&
        state.partitions.user === previousState.partitions.user &&
        state.degradedCause === previousState.degradedCause
      ) {
        return;
      }
      this.#invalidate();
    });
  }

  #invalidate(): void {
    this.#rows = undefined;
    // Copied first: a subscriber React removes during notification would change the set.
    for (const notifySubscriber of [...this.#reactSubscribers]) {
      notifySubscriber();
    }
  }

  #buildRows(): readonly SessionListRow[] {
    const rows: SessionListRow[] = [];
    for (const sessionId of this.#registry.openSessionIds) {
      const store = this.#registry.peek(sessionId);
      if (store === undefined) {
        continue;
      }
      rows.push(...projectOneStore(store));
    }
    return rows.length === 0 ? NO_PROJECTED_ROWS : rows;
  }
}

/**
 * What every session this window has open can describe, as a subscription. The projection is
 * built once per registry and held in a ref, so a replaced registry is followed and a render
 * does not re-subscribe.
 *
 * Two snapshots over one subscription, because a read composing `{ rows, degradedCause }`
 * would hand `Object.is` a new identity every call and spin; the returned object is composed
 * after both reads.
 */
export function useOpenSessionProjection(
  registry: SessionStoreRegistry,
): OpenSessionProjectionReading {
  const heldProjection = useRef<{
    readonly registry: SessionStoreRegistry;
    readonly projection: OpenSessionRowProjection;
  }>(undefined);
  if (heldProjection.current === undefined || heldProjection.current.registry !== registry) {
    heldProjection.current = { registry, projection: new OpenSessionRowProjection(registry) };
  }
  const { projection } = heldProjection.current;
  const rows = useSyncExternalStore(projection.subscribe, projection.readRows, projection.readRows);
  const degradedCause = useSyncExternalStore(
    projection.subscribe,
    projection.readDegradedCause,
    projection.readDegradedCause,
  );
  return { rows, degradedCause, readDegradedCause: projection.readDegradedCause };
}

/**
 * What one open session's store can say, as list rows. The users attach only to the store's
 * own session, since its user list would misattribute people to a session it merely heard about.
 */
function projectOneStore(store: SessionStore): readonly SessionListRow[] {
  const { partitions } = store.snapshot();
  const userIds = Object.keys(partitions.user);
  return Object.values(partitions.session).map((entity) => ({
    sessionId: entity.id,
    state: entity.state,
    touchedAtIso: entity.touchedAt,
    userIds: entity.id === store.sessionId ? userIds : [],
  }));
}
