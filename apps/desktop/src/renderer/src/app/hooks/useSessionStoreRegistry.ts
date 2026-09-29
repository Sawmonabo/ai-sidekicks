// Who owns the session stores this window renders from, and what feeds them.
//
// `SessionStoreRegistry` owns a session store's life — its apply queue, its refresh
// scheduler, and the rule that two opens of one session are one store.
// `SessionEventSubscriber` owns the wire subscription in front of that apply queue.
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
// THE READ IS THE CALLER'S. The call that reads a session's base state is taken as an
// argument, so this module keeps only how the registry and its binder are held.
//
// WHY THE PLUMBING IS BUILT DURING RENDER AND NOT IN AN EFFECT.
// `useOpenSessionStore` takes a registry, and a hook cannot be called conditionally,
// so a registry that arrived one commit late would mean a first render with nothing
// to read through at all. A registry that is built and discarded owns nothing: no
// timer, no subscription, no store until something opens one. The construction that
// had to leave the render phase is the STORE's, and it has. The binder is built
// beside it and ATTACHED in the effect, which is the same distinction one level up:
// constructing it costs nothing, and subscribing is the side effect that must not
// happen during render.
//
// AND WHY IT IS HELD BY `useSubjectScopedResource` RATHER THAN BY `useState`.
// The plumbing belongs to the BRIDGE it was built from: the registry's session read
// and the binder's subscription both travel through that transport, and the provider
// replaces it — a reconnect, the fixture's scenario switch — while this window stays
// mounted. A `useState` initializer runs once and never again, so the replacement was
// answered by nothing here: the window went on reading a session through a retired
// transport. The holder re-addresses DURING the render that first sees the new
// bridge, so no committed frame plumbs through the old resolution, and it mints
// exactly once per bridge even under the double-invoked render strict mode performs —
// which a `useState` initializer does not.
//
// A HOLDER DROPS A VALUE; A RESOURCE HAS TO BE DISPOSED, and the resource hook owns
// both moments at which this one can be. The effect's cleanup runs with the retired
// plumbing in its own closure, which is the bridge swap and the unmount; and a
// plumbing dropped by a render React DISCARDS is disposed inside that render, because
// no effect ever closed over it and nothing else would. Keying disposal on anything
// but the plumbing is what made the previous shape accidental — its dependency list
// named `bridge`, which the body did not use, so a bridge change tore the LIVE
// plumbing down and then rebuilt it only because `disposeAll` happens to set
// `isDisposed` before the body reads it.
//
// WHICH IS WHY THE REMOUNT ARM IS ITS OWN EFFECT. It is the one thing here that reads
// the bridge and the projector board, so it is the one thing whose dependency list has
// to name them — and a list that names them may not own a teardown, because a
// projector board rebuilt while the bridge stood would then retire plumbing nothing
// had replaced. The two are split by what they DO: one attaches the binder to the
// plumbing it is keyed on, the other only publishes, and acts on no condition but a
// plumbing that has already disposed itself.

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
import { type SessionSnapshotReader } from "@renderer/store/session/open-session-entry.js";
import { SessionEventSubscriber } from "@renderer/services/session-events/session-event-subscriber.js";

/**
 * This window's session-store registry, rebuilt on a new bridge and disposed with
 * the window.
 *
 * TWO THINGS RETIRE A PLUMBING, and they are answered in two different places
 * because they happen at two different moments.
 *
 *   • **The bridge it was built from was replaced.** The holder compares the subject
 *     during the render that first sees the new one, so the registry a frame reads
 *     through is never the retired transport's. That is the arm this hook had none
 *     of: a replaced bridge left the window opening sessions on a registry whose
 *     read and whose binder both pointed at a transport nothing was serving.
 *   • **The plumbing disposed itself.** The remount arm, for the same component
 *     instance — React's StrictMode double-mount is the one that does it today, and
 *     the opt-in is named in `main.tsx`. The cleanup has already disposed the
 *     registry by then and a disposed registry refuses every open, so the second
 *     mount publishes a fresh plumbing rather than keeping a corpse. It cannot be a
 *     render-phase comparison, because the disposal happens in an effect's cleanup
 *     and is invisible to the render that preceded it — so it is the resource hook's
 *     own `isClosed` arm, read where its lifetime effect runs, and not an effect
 *     written here.
 *
 * The binder is not returned. Nothing above this hook reads it — all it does
 * is own the subscription — and handing it out would invite a second caller to
 * attach or dispose it out from under this window.
 */
export function useSessionStoreRegistry(
  projectorRegistry: EntityProjectorRegistry,
  readSession: SessionSnapshotReader,
): SessionStoreRegistry {
  // Resolved from context rather than taken as an argument, so every caller of this
  // hook gets the same bridge the rest of the frame renders against and no component
  // has to thread one through. The bridge is provided, never reached for, which is the
  // same rule one layer down.
  const bridge = usePlatformBridge();
  const clock = useBridgeClock();
  // The bridge alone is the subject, and the projector registry and the read call
  // deliberately are not: the plumbing takes a SNAPSHOT of that table at construction,
  // exactly so a later registration cannot make one open store fold two events of one
  // kind two ways, and takes the call once. A value the resource does not read live is
  // not part of what the resource is about.
  const { value: plumbing } = useSubjectScopedResource<WindowSessionPlumbing>(
    bridge,
    undefined,
    () => createWindowSessionPlumbing(bridge, clock, projectorRegistry, readSession),
    WINDOW_SESSION_PLUMBING_DISPOSAL,
  );
  // THE SUBSCRIPTION, KEYED ON THE PLUMBING AND NOTHING ELSE. Anything else in this
  // list is a reason to re-run for something that has nothing to do with the
  // resource: the plumbing is rebuilt by the HOLDER when its bridge moves, so a
  // dependency the body does not read can only ever fire while the plumbing is
  // exactly what it was.
  useEffect(() => {
    if (plumbing.registry.isDisposed) {
      return;
    }
    plumbing.binder.attach();
  }, [plumbing]);
  // WHAT A DRIVER READS ABOUT THE SUBSCRIPTIONS, handed to the composition that built
  // this window's bridge, which puts it on the page. A window reading the preload has no
  // composition and puts nothing up.
  const composition = useBridgeComposition();
  useEffect(
    () => composition?.installSessionDiagnostics(plumbing.binder.diagnostics),
    [composition, plumbing],
  );
  return plumbing.registry;
}

/** This window's session plumbing: the stores, and the one thing that feeds them. */
interface WindowSessionPlumbing {
  readonly registry: SessionStoreRegistry;
  readonly binder: SessionEventSubscriber;
}

/**
 * The registry and its binder, for one window.
 *
 * THE CLOCK COMES FROM THE BRIDGE, and it has to. The registry gives every apply
 * queue and refresh scheduler it opens one clock, and left to its own default that
 * clock is the wall clock — so under the fixture, coalescing windows and refresh
 * deadlines ran on `setTimeout` while the scenario's beats moved on frozen time.
 * A screenshot or an endurance step taken straight after `advance()` could then
 * observe either side of a drain depending on how fast the runner happened to be,
 * which is the one property a frozen clock exists to remove.
 */
function createWindowSessionPlumbing(
  bridge: PlatformBridge,
  clock: Clock,
  projectorRegistry: EntityProjectorRegistry,
  readSession: SessionSnapshotReader,
): WindowSessionPlumbing {
  const registry = new SessionStoreRegistry({
    read: readSession,
    clock,
    // THE PROJECTORS ARE PART OF THE PLUMBING, not an optional extra. The registry
    // has taken them since it was written and this root registered none, so every
    // store it opened admitted its events into the timeline and projected them
    // into no partition at all — a runs view that renders a live session as
    // having no runs, indistinguishable from one that has none. They are supplied
    // HERE and only here, so every store this window opens folds the same events
    // the same way; a view that registered its own would be a second projection
    // of one stream.
    //
    // A SNAPSHOT OF THE REGISTRY, not the frame's own constant. The constant was a
    // table closed at build time by one feature, so every other partition
    // `store/entities/entities.ts` declares had no possible producer — and the features that
    // own those views would have had to read the wire a second time to fill them.
    // Taking the snapshot HERE also fixes the composition order: features register
    // at module scope, before any window renders, and a store opens with whatever
    // that composition claimed. A snapshot rather than the registry itself, because
    // a store folds for as long as its session is open and a table that changed
    // underneath it would fold two events of one kind two ways.
    projectors: projectorRegistry.snapshot(),
  });
  return { registry, binder: new SessionEventSubscriber({ registry, bridge }) };
}

/**
 * Retire one window's plumbing, whichever moment retired it.
 *
 * THE BINDER FIRST, AND THE ORDER IS LOAD-BEARING. It holds the registry's change
 * subscription, and `disposeAll` closes every open session — so a registry disposed
 * first would call back into a binder that is about to be torn down, unbinding
 * subscriptions during a teardown that is already unbinding them.
 *
 * A declared function rather than an arrow at the call site, because the holder is
 * handed it on every render and the render that builds a plumbing is the rare one.
 */
function disposeWindowSessionPlumbing(plumbing: WindowSessionPlumbing): void {
  plumbing.binder.dispose();
  plumbing.registry.disposeAll();
}

/**
 * How a plumbing ends, stated once: it is disposed, and a disposed one is readable.
 *
 * THE TERMINAL ARM, WHICH IS WHAT THE SHAPE OF THIS OBJECT SAYS. `disposeAll` is
 * one-way — a registry that has run it never serves another store — so React's
 * double-mount would re-commit the retired plumbing if the hook had no way to
 * recognize it, and the window would go on addressing a registry that answers
 * nothing. The reading is `isDisposed` because that is the registry's own record of
 * having run it, not a flag this module keeps beside it.
 *
 * A module-level constant rather than a literal at the call site, so the disposal
 * this hands over has one identity for the whole mount and the hook's own dependency
 * lists do not move on renders that have nothing to do with the plumbing.
 */
const WINDOW_SESSION_PLUMBING_DISPOSAL: SubjectScopedDisposal<WindowSessionPlumbing> = {
  dispose: disposeWindowSessionPlumbing,
  isClosed: (plumbing) => plumbing.registry.isDisposed,
};
