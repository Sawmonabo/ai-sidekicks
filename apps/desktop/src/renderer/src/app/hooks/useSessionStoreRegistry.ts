// Who owns the session stores this window renders from, and what feeds them: one registry and
// one event subscriber per window, minted and disposed together.
//
// The registry owns each session store's life; the subscriber owns the wire subscription in
// front of it. A registry with no subscriber is stores nothing writes to, and a subscriber
// with no registry has nowhere to deliver, so one piece of state holds both. The call that
// reads a session's base state is the caller's.
//
// The pair is built during render, not in an effect: `useOpenSessionStore` takes a registry and
// a hook cannot be conditional, and a built-and-discarded registry owns nothing until a session
// opens. Subscribing is the side effect, so the subscriber attaches in the effect.
//
// `useSubjectScopedResource` holds it rather than `useState`, because the pair belongs to the
// bridge it was built from and the provider replaces the bridge (a reconnect, the fixture's
// scenario switch) while the window stays mounted. The holder re-mints during the render that
// first sees the new bridge, exactly once even under strict mode's double render, and disposes a
// pair dropped by a discarded render, which no effect closed over.

import { useEffect } from "react";
import { type Clock } from "@renderer/lib/clock.js";
import { useBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import { useBridgeComposition } from "@renderer/services/platform/hooks/useBridgeComposition.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { type EntityProjectorRegistry } from "@renderer/registries/entity-projectors/entity-projector-registry.js";
import { type SessionBaseStateReader } from "@renderer/store/session/open-session-entry.js";
import { SessionEventSubscriber } from "@renderer/services/session-events/session-event-subscriber.js";

/**
 * This window's session-store registry, rebuilt on a new bridge and disposed with the window.
 *
 * Two things retire the pair. A replaced bridge is caught by the holder in the render that first
 * sees it. A remount of the same component instance (React's StrictMode double-mount, should it
 * be enabled) finds the cleanup already disposed the registry, which refuses every open, so the
 * resource hook's `isClosed` arm publishes a fresh pair; that cannot be a render-phase
 * comparison because the disposal happens in an effect's cleanup. The subscriber is not
 * returned, so no second caller can attach or dispose it.
 */
export function useSessionStoreRegistry(
  projectorRegistry: EntityProjectorRegistry,
  readSession: SessionBaseStateReader,
): SessionStoreRegistry {
  // Resolved from context so every caller gets the bridge the rest of the frame renders against.
  const bridge = usePlatformBridge();
  const clock = useBridgeClock();
  // The bridge alone is the subject: the projector table is snapshotted at construction and
  // the read call is taken once, so neither is read live.
  const { value: plumbing } = useSubjectScopedResource<WindowSessionPlumbing>(
    bridge,
    undefined,
    () => createWindowSessionPlumbing(bridge, clock, projectorRegistry, readSession),
    WINDOW_SESSION_PLUMBING_DISPOSAL,
  );
  // Keyed on the plumbing alone: the holder rebuilds it when the bridge moves.
  useEffect(() => {
    if (plumbing.registry.isDisposed) {
      return;
    }
    plumbing.subscriber.attach();
  }, [plumbing]);
  // The subscription diagnostics go to the composition that built this window's bridge, which
  // puts them on the page for a test driver; a window on the preload has no composition.
  const composition = useBridgeComposition();
  useEffect(
    () => composition?.installSessionDiagnostics(plumbing.subscriber.diagnostics),
    [composition, plumbing],
  );
  return plumbing.registry;
}

/** This window's session plumbing: the stores, and the one thing that feeds them. */
interface WindowSessionPlumbing {
  readonly registry: SessionStoreRegistry;
  readonly subscriber: SessionEventSubscriber;
}

/**
 * The registry and its subscriber, for one window.
 *
 * The clock comes from the bridge: the registry's default is the wall clock, so under the
 * fixture coalescing windows and refresh deadlines would run on `setTimeout` while the
 * scenario's beats move on frozen time, and a step taken right after `advance()` could see
 * either side of a drain.
 */
function createWindowSessionPlumbing(
  bridge: PlatformBridge,
  clock: Clock,
  projectorRegistry: EntityProjectorRegistry,
  readSession: SessionBaseStateReader,
): WindowSessionPlumbing {
  const registry = new SessionStoreRegistry({
    read: readSession,
    clock,
    // Supplied here only, so every store folds the same events the same way; without them a
    // live session projects into no partition and reads as having no runs. A snapshot, because
    // features register at module scope before any window renders and a table that changed under
    // an open store would fold two events of one kind two ways.
    projectors: projectorRegistry.snapshot(),
  });
  return { registry, subscriber: new SessionEventSubscriber({ registry, bridge }) };
}

/**
 * Retire one window's plumbing, whichever moment retired it.
 *
 * The subscriber goes first: it holds the registry's change subscription, and disposing the
 * registry first would call back into a subscriber that is already tearing down.
 */
function disposeWindowSessionPlumbing(plumbing: WindowSessionPlumbing): void {
  plumbing.subscriber.dispose();
  plumbing.registry.disposeAll();
}

/**
 * How a plumbing ends: it is disposed, and a disposed one reads as closed.
 *
 * `disposeAll` is one-way, so a remount would re-commit the retired plumbing unless the hook can
 * recognize it by the registry's own `isDisposed`. A module-level constant keeps one identity
 * across renders.
 */
const WINDOW_SESSION_PLUMBING_DISPOSAL: SubjectScopedDisposal<WindowSessionPlumbing> = {
  dispose: disposeWindowSessionPlumbing,
  isClosed: (plumbing) => plumbing.registry.isDisposed,
};
