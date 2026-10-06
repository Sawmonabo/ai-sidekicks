// React bindings for a session store.
//
// - No component subscribes to the bridge; components subscribe to a store, and only the apply
//   chokepoint subscribes to the bridge.
// - No component constructs a store. `SessionStoreRegistry` opens stores and
//   `useOpenSessionStore` only resolves one: it never opens a session while rendering, since a
//   discarded render would leave a store open that nothing closes.
// - Subscriptions are partitioned per entity. `useSessionPartition` selects one kind's map,
//   which changes identity only when that kind does, and `useSessionEntity` narrows to one row.
//
// zustand v5's `useStore` compares with `Object.is` and does no shallow pass. The store merges
// immutably, so an untouched partition keeps its identity. A selector that built a value (a
// `.map`, a `.filter`, an object literal) would re-render every frame, so selectors return
// stored references (`selectPartition`, `selectEntity`) and components derive under `useMemo`.
//
// `useSessionInitialized.ts` holds the readings about a session's projection (whether a base
// state landed, whether it moved, whether it is incomplete, what the newest read said about
// resuming) rather than out of it.

import { useCallback, useSyncExternalStore } from "react";
import { useStore } from "zustand";

import type { StoredEntity } from "../entities/vocabulary.js";
import type { EntityKind, EntityRef } from "#renderer/lib/entity-kinds.js";
import type { SessionStoreRegistry } from "../registry.js";
import { selectEntity, selectPartition } from "../selectors.js";
import type { SessionStoreState } from "../state.js";
import type { SessionStore } from "../store.js";

/**
 * The store for one session, or `undefined` while that session is not open. Subscribed through
 * the registry's change emitter, so a session opened or closed after mount reaches the
 * component with no poll. `undefined` is a real answer, never a reason to open a session.
 */
export function useOpenSessionStore(
  registry: SessionStoreRegistry,
  sessionId: string | undefined,
): SessionStore | undefined {
  const subscribe = useCallback(
    (onStoreChange: () => void) => registry.subscribe(onStoreChange),
    [registry],
  );
  const read = useCallback(
    () => (sessionId === undefined ? undefined : registry.peek(sessionId)),
    [registry, sessionId],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * The sessions this window has open, in open order; the service's own list is
 * `useSessionDirectory`. Subscribed through the registry's change emitter, and the read returns
 * the registry's stable array rather than building one.
 *
 * @consumedBy a view that lists the sessions this window has open
 */
export function useOpenSessionIds(registry: SessionStoreRegistry): readonly string[] {
  const subscribe = useCallback(
    (onStoreChange: () => void) => registry.subscribe(onStoreChange),
    [registry],
  );
  const read = useCallback(() => registry.openSessionIds, [registry]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Select from the session store. The selector must return a stored reference. */
export function useSessionStore<TSelected>(
  store: SessionStore,
  selector: (state: SessionStoreState) => TSelected,
): TSelected {
  return useStore(store.readable, selector);
}

/** One entity kind's map. Identity changes only when that kind changes. */
export function useSessionPartition(
  store: SessionStore,
  kind: EntityKind,
): Readonly<Record<string, StoredEntity>> {
  const select = useCallback((state: SessionStoreState) => selectPartition(state, kind), [kind]);
  return useStore(store.readable, select);
}

/**
 * One entity, or `undefined`; the narrowest subscription the console offers. Keyed on the ref's
 * fields, so a fresh `{ kind, id }` literal each render does not rebuild the selector.
 */
export function useSessionEntity(store: SessionStore, ref: EntityRef): StoredEntity | undefined {
  const { kind, id } = ref;
  const select = useCallback(
    (state: SessionStoreState) => selectEntity(state, { kind, id }),
    [kind, id],
  );
  return useStore(store.readable, select);
}
