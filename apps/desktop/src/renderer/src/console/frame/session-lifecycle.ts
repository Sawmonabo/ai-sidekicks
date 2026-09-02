// Who owns the session stores this window renders from, and what feeds them.
//
// `SessionStoreRegistry` owns a session store's life — its apply queue, its refresh
// scheduler, and the rule that two opens of one session are one store.
// `SessionEventBinder` owns the wire subscription in front of that apply queue.
// This module owns BOTH their lives, which is the composition root's question and
// nobody else's: one registry and one binder per window, sessions kept open for as
// long as the window is up, everything disposed when it goes away.
//
// The two are minted and disposed together rather than separately, because neither
// is correct alone. A registry with no binder is a set of stores nothing ever
// writes to — which is exactly what this window had before the binder existed, and
// it renders as a live session that never changes. A binder with no registry has
// nowhere to deliver. Holding them in one piece of state makes "one without the
// other" unrepresentable rather than merely unlikely.
//
// Two rules from `Spec-023 §Console Design (Meridian)` decide the shape here, and
// both are about the render phase:
//
//   • **No component constructs a store.** A component RESOLVES one through
//     `useOpenSessionStore`, which is a read. Nothing here calls `open` during
//     render: the open rides an effect keyed on the session the route names, so a
//     render pass React discards cannot leave a session open that nothing closes.
//     This replaced a `Map` held in a ref whose misses constructed a store inside
//     the render body, where a discarded pass took every event applied to it too.
//   • **`undefined` is an answer, not a cue.** Between the render that first names
//     a session and the effect that opens it there is one frame with no store. The
//     honest render of that frame is the `not-loaded` kind of nothing — a read is
//     in flight — and `RouteSurface` renders exactly that. Opening the session from
//     inside render to skip the frame is the defect, not the fix.
//
// WHY THE REGISTRY IS BUILT BY A `useState` INITIALIZER AND NOT IN AN EFFECT.
// `useOpenSessionStore` takes a registry, and a hook cannot be called conditionally,
// so a registry that arrived one commit late would mean a first render with nothing
// to read through at all. The initializer runs once per mounted component and its
// result is never recomputed — unlike `useMemo`, which may be — and a registry that
// is built and discarded owns nothing: no timer, no subscription, no store until
// something opens one. The construction that had to leave the render phase is the
// STORE's, and it has. The binder is built beside it and ATTACHED in the effect,
// which is the same distinction one level up: constructing it costs nothing, and
// subscribing is the side effect that must not happen during render.

import { useEffect, useState } from "react";

import { useConsoleBridge, type ConsoleBridge } from "../bridge/index.js";
import {
  SessionStoreRegistry,
  useOpenSessionStore,
  type SessionSnapshotReader,
  type SessionStore,
} from "../store/index.js";
import { SessionEventBinder } from "./session-event-binder.js";

/**
 * The read every open session's refresh scheduler performs.
 *
 * The console has no session-read wire yet — `Plan-023 §Console growth slate` names
 * the row and the bridge's growth port refuses it — so this resolves `undefined`,
 * which the registry reads as "nothing was read". Deliberately not an empty
 * snapshot: that would tell the store the session is genuinely empty and clear its
 * degraded flag on a read that never happened.
 */
const READS_NOTHING_YET: SessionSnapshotReader = () => Promise.resolve(undefined);

/** This window's session plumbing: the stores, and the one thing that feeds them. */
interface WindowSessionPlumbing {
  readonly registry: SessionStoreRegistry;
  readonly binder: SessionEventBinder;
}

/**
 * This window's session-store registry, disposed when the console unmounts.
 *
 * The re-mint arm is for a remount of the same component instance — React's
 * StrictMode double-mount is the one that does it today, and the Tier-8 opt-in is
 * named in `main.tsx`. The cleanup has already disposed the registry by then, and a
 * disposed registry refuses every open, so the second mount takes a fresh one
 * rather than a corpse. The binder is re-minted with it for the same reason: it is
 * disposed in the same cleanup, and a disposed binder subscribes to nothing.
 *
 * The binder is not returned. Nothing above this hook reads it — its whole surface
 * is the subscription it owns — and handing it out would invite a second caller to
 * attach or dispose it out from under this window.
 */
export function useSessionStoreRegistry(): SessionStoreRegistry {
  // Resolved from context rather than taken as an argument, so every caller of this
  // hook gets the same bridge the rest of the frame renders against and no surface
  // has to thread one through. `Spec-023`'s "the bridge is provided, never reached
  // for" is the same rule one layer down.
  const bridge = useConsoleBridge();
  const [plumbing, setPlumbing] = useState<WindowSessionPlumbing>(() =>
    createWindowSessionPlumbing(bridge),
  );
  useEffect(() => {
    if (plumbing.registry.isDisposed) {
      setPlumbing(createWindowSessionPlumbing(bridge));
      return;
    }
    plumbing.binder.attach();
    return () => {
      // The binder first, and the order is load-bearing. It holds the registry's
      // change subscription, and `disposeAll` closes every open session — so a
      // registry disposed first would call back into a binder that is about to be
      // torn down, unbinding subscriptions during a teardown that is already
      // unbinding them.
      plumbing.binder.dispose();
      plumbing.registry.disposeAll();
    };
  }, [plumbing, bridge]);
  return plumbing.registry;
}

/**
 * The store for the session the route names, or `undefined` while it is opening.
 *
 * Opened, never closed on navigation: a person who leaves a session and comes back
 * finds the events it accumulated while they were away, which is what the
 * never-evicting map this replaced also gave them. Everything closes together when
 * the window does.
 */
export function useActiveSessionStore(
  registry: SessionStoreRegistry,
  activeSessionId: string | undefined,
): SessionStore | undefined {
  useEffect(() => {
    // The disposed check is the same remount window the hook above re-mints in:
    // this effect can run once with the registry that cleanup just disposed, and
    // `open` is the one registry call that raises rather than returning a refusal.
    if (activeSessionId === undefined || registry.isDisposed) {
      return;
    }
    registry.open(activeSessionId);
  }, [registry, activeSessionId]);
  return useOpenSessionStore(registry, activeSessionId);
}

function createWindowSessionPlumbing(bridge: ConsoleBridge): WindowSessionPlumbing {
  const registry = new SessionStoreRegistry({ read: READS_NOTHING_YET });
  return { registry, binder: new SessionEventBinder({ registry, bridge }) };
}
