// What every session THIS WINDOW has open can say about itself.
//
// WHY THIS IS NOT ONE STORE. The all-sessions destination is mounted at
// `kind: "sessions"`, an address that names no session — so the frame opens no
// route-scoped store and hands the surface `undefined` for it, permanently. A list
// built from that one store was therefore built from nothing, and every locally open
// session was reduced to its identifier: no projected touched time, so the recency
// ordering the design opens with had nothing to order by, and no participants, so a
// row carrying people rendered as a bare id. The set the surface needs is the one
// `SessionStoreRegistry` holds, and that set has no fixed size.
//
// WHICH IS WHY IT IS A SUBSCRIPTION AND NOT N HOOKS. A hook per open store cannot be
// written: React fixes the number of hooks a render performs, and this number changes
// whenever a session opens or closes. So the fan-out lives in the class below and the
// component takes ONE `useSyncExternalStore` over it — the registry's own change
// emitter says when the SET moved, each open store's own subscription says when its
// projection moved, and both invalidate one cached array.
//
// BOUNDED, AND RELEASED WITH THE SESSION. A subscription is taken for exactly the
// sessions the registry reports open and dropped the moment one closes, so a closed
// session leaves no listener behind on a store nothing else holds. The whole fan-out
// is released when the last React subscriber goes, which is what makes the projection
// safe to hold for the life of a window rather than of a mount.
//
// IT ALSO CARRIES THE DEGRADATION FOLD, and that is a consequence of the fan-out
// rather than a second job: the set of stores whose degradation the destination has
// to report is exactly the set already subscribed here, and a second class walking
// the same registry would take a second subscription per open session to answer a
// question this one is already awake for. The RULE it folds by is
// `store/degradation.ts`' own — the worst standing cause wins, so a milder later
// fact never reads as a repair — and this module reimplements none of it.
//
// IT PROJECTS AND DOES NOT MERGE. `session-directory-rows.ts` owns the merge with the
// node's directory and owns which kind of nothing an empty list is; this module
// answers only "what do the open stores say", and answers with an empty array when
// they say nothing — which is a projection with no rows, never a claim about the node.

import { useRef, useSyncExternalStore } from "react";

import { worstDegradedCause, type SessionDegradedCause } from "../../store/index.js";
import type { SessionStore, SessionStoreRegistry } from "../../store/index.js";
import type { SessionListRow } from "./session-rows.js";

/**
 * One frozen empty projection, so a change that produces no rows does not hand React
 * a new array identity and re-render the list for nothing.
 */
const NO_PROJECTED_ROWS: readonly SessionListRow[] = [];

/**
 * Every open session's projected row, kept current across the open set.
 *
 * A class rather than a hook body because it holds four pieces of state that outlive
 * a render — the registry subscription, one subscription per open store, the React
 * subscribers, and the cached rows — and because the cache is the load-bearing part:
 * `useSyncExternalStore` compares consecutive reads with `Object.is` and re-renders
 * while they differ, so a read that rebuilt the array on every call would spin.
 */
export class OpenSessionRowProjection {
  readonly #registry: SessionStoreRegistry;
  /** One release per store currently subscribed, keyed by its session id. */
  readonly #storeReleases = new Map<string, () => void>();
  readonly #reactSubscribers = new Set<() => void>();
  #registryRelease: (() => void) | undefined = undefined;
  /** The cache. `undefined` means "invalidated", not "empty". */
  #rows: readonly SessionListRow[] | undefined = undefined;

  public constructor(registry: SessionStoreRegistry) {
    this.#registry = registry;
  }

  /**
   * Follow the open set and every store in it, for as long as anyone is listening.
   *
   * The fan-out is attached on the FIRST subscriber and released with the last, so a
   * projection whose surface has unmounted holds no listener anywhere. An arrow
   * property rather than a prototype method because `useSyncExternalStore` compares
   * this function's identity and re-subscribes when it moves.
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
   * The rows, rebuilt only when something has actually changed.
   *
   * Correct before `subscribe` runs — React reads a snapshot on the first render,
   * ahead of the effect that subscribes — because the build reads the registry
   * directly rather than anything the subscription set up.
   */
  public readonly readRows = (): readonly SessionListRow[] => {
    this.#rows ??= this.#buildRows();
    return this.#rows;
  };

  /**
   * The worst degraded cause standing across every open store, or `undefined`.
   *
   * A primitive rather than a cached object, so `useSyncExternalStore`'s `Object.is`
   * comparison is satisfied by the VALUE and this read needs no cache of its own.
   */
  public readonly readDegradedCause = (): SessionDegradedCause | undefined => {
    return worstDegradedCause(
      ...this.#registry.openSessionIds.map(
        (sessionId) => this.#registry.peek(sessionId)?.snapshot().degradedCause,
      ),
    );
  };

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
   * Bring the subscribed set in line with the open set: drop what closed, take what
   * opened, and leave what was already there alone.
   *
   * Leaving the survivors alone is the point rather than an optimisation — tearing
   * every subscription down and re-taking it on each registry change would drop a
   * store's notification for the window between the two calls.
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
   * Listen to one store, and wake only for the two partitions this projection reads.
   *
   * The partitioned store replaces the identity of exactly the partition a mutation
   * touched, so a burst of run events leaves both of these references untouched and
   * the list does not re-render — which is the whole reason the store is partitioned
   * by kind, held here rather than given up at the one place that fans out over N of
   * them.
   */
  #subscribeToStore(store: SessionStore): () => void {
    return store.readable.subscribe((state, previousState) => {
      if (
        state.partitions.session === previousState.partitions.session &&
        state.partitions.participant === previousState.partitions.participant &&
        state.degradedCause === previousState.degradedCause
      ) {
        return;
      }
      this.#invalidate();
    });
  }

  #invalidate(): void {
    this.#rows = undefined;
    // Copied before iterating: a subscriber React removes during notification would
    // otherwise change the set being walked.
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
 * What one open session's store can say, as list rows.
 *
 * The participants are attached only to the store's OWN session. A store projects the
 * people it has seen in the session it is for, so lending that roster to a row for
 * some session it merely heard about would attribute the wrong people to it.
 */
function projectOneStore(store: SessionStore): readonly SessionListRow[] {
  const { partitions } = store.snapshot();
  const participantIds = Object.keys(partitions.participant);
  return Object.values(partitions.session).map((entity) => ({
    sessionId: entity.id,
    state: entity.state,
    touchedAtIso: entity.touchedAt,
    participantIds: entity.id === store.sessionId ? participantIds : [],
    // Attention is one projection for the whole destination and is stamped over the
    // merged list by the surface. Reading it per source would give one session two
    // severities and let the merge decide which a person saw.
    attentionSeverity: undefined,
  }));
}

/** What the open stores say about themselves, and about how well they are following. */
export interface OpenSessionProjectionReading {
  readonly rows: readonly SessionListRow[];
  readonly degradedCause: SessionDegradedCause | undefined;
}

/**
 * What every session this window has open can describe, as a subscription.
 *
 * The projection is built once per registry and held in a ref: a fresh one per render
 * would re-subscribe every pass, and a fresh one per registry is what makes a window
 * that replaces its registry follow the new one rather than the object it dropped.
 *
 * TWO SNAPSHOTS OVER ONE SUBSCRIPTION, deliberately, rather than one snapshot over a
 * composed object: `useSyncExternalStore` compares consecutive reads with `Object.is`
 * and re-renders while they differ, so a read that composed `{ rows, degradedCause }`
 * would hand React a new identity on every call and spin. The returned object is
 * composed AFTER both reads settle, where nothing compares it.
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
  return { rows, degradedCause };
}
