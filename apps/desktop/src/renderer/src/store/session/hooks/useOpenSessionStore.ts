// React bindings for a session store.
//
// Three of the console's own rules shape every hook here:
//
//   • **No component subscribes to the bridge.** Components subscribe to a STORE,
//     and exactly one thing subscribes to the bridge — the apply chokepoint. That is
//     why there is no `useBridgeEvent` hook and why adding one is a review rejection.
//   • **No component constructs a store.** A store is opened by
//     `SessionStoreRegistry` and RESOLVED here. `useOpenSessionStore` is the only
//     way a component gets one, and it is a read: it never opens a session as a
//     side effect of rendering, because a render pass React discards would leave a
//     store open that nothing will ever close.
//   • **Subscriptions are partitioned per entity.** `useSessionPartition` selects
//     one kind's map, whose identity only changes when that kind changes, so a
//     `run.*` burst re-renders the runs list and nothing else. `useSessionEntity`
//     narrows further to one row, so a row re-renders when its own entity changes
//     and not when its neighbor does.
//
// zustand v5's `useStore` compares with `Object.is` and does no shallow-equality
// pass, which is exactly what these selectors want: the store merges immutably, so
// an untouched partition keeps its identity and the comparison is a pointer check.
// A selector that BUILT a value (a `.map`, a `.filter`, an object literal) would
// defeat that and re-render every frame — so selectors here return stored
// references (`selectPartition` / `selectEntity`, which this sub-module owns and
// these hooks are the callers of), and derivation happens in the component under
// `useMemo`.
//
// WHAT IS NOT HERE. `session-projection-hooks.ts` holds the readings that answer a
// question ABOUT a session's projection rather than out of it — whether a base state
// landed, whether the projection moved, whether it is known incomplete, and what the
// newest read said about resuming the stream. This file resolves stores and selects
// content; that one reports on the read behind the content, and it is the half whose
// inputs stop being "a store and a selector".
//
// WHAT IS DELIBERATELY NOT HERE. The frame store's hooks are `shell/frame-hooks.ts`'s,
// and the door publishes each hook from the module that declares it.

import { useCallback, useSyncExternalStore } from "react";
import { useStore } from "zustand";

import type { StoredEntity } from "../entities/entities.js";
import type { EntityKind, EntityRef } from "@renderer/lib/entity-kinds.js";
import type { SessionStoreRegistry } from "../session-store-registry.js";
import {
  selectEntity,
  selectPartition,
  type SessionStore,
  type SessionStoreState,
} from "../session-store.js";

/**
 * The store for one session, or `undefined` while that session is not open.
 *
 * Subscribed rather than read once: a session opened or closed after this
 * component mounted has to reach it, and the registry's own change emitter is the
 * event that says so — there is no poll and no interval anywhere in this path.
 * `undefined` is a real answer a caller renders as "no session", never a reason to
 * open one from inside a render.
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
 * The sessions this window has open, in open order.
 *
 * The console has no session-DIRECTORY read — no `PlatformBridge` member lists the
 * sessions on a node — so this registry is the only session set the renderer can name,
 * and a surface that needs one reads it here rather than inventing a source.
 *
 * Subscribed through the registry's own change emitter, so it costs no timer and no
 * poll, and the read returns the registry's stable array rather than building one.
 *
 * @consumedBy a surface that lists the sessions this window has open
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
 * One entity, or `undefined`. The narrowest subscription the console offers.
 *
 * Keyed on the ref's FIELDS rather than on the ref object, so a caller writing the
 * ordinary `useSessionEntity(store, { kind: "run", id })` — a fresh literal every
 * render — does not rebuild the selector on every pass.
 */
export function useSessionEntity(store: SessionStore, ref: EntityRef): StoredEntity | undefined {
  const { kind, id } = ref;
  const select = useCallback(
    (state: SessionStoreState) => selectEntity(state, { kind, id }),
    [kind, id],
  );
  return useStore(store.readable, select);
}
