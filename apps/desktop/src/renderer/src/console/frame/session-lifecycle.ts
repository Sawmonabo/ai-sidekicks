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
// WHAT THE BINDER BINDS is a separate question from whether it exists, and the
// answer now depends on the bridge: a build whose bridge serves the growth port's
// session read gets a registry that can reach a base state and a binder that feeds
// it; a build whose bridge refuses gets the refusal itself as the registry's read,
// and no stream is bound at all. `createWindowSessionPlumbing` below carries that
// reasoning.
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

import { ConsoleRefusalError } from "../core/index.js";
import {
  consoleClockFor,
  growthUnavailable,
  useConsoleBridge,
  type ConsoleBridge,
} from "../bridge/index.js";
import {
  SessionStoreRegistry,
  useOpenSessionStore,
  useSubjectScopedResource,
  type ConsoleEntityProjectorRegistry,
  type RefreshReason,
  type SessionSnapshot,
  type SessionSnapshotRead,
  type SessionStore,
  type SubjectScopedDisposal,
} from "../store/index.js";
import { SessionEventBinder } from "./session-event-binder.js";

/** This window's session plumbing: the stores, and the one thing that feeds them. */
interface WindowSessionPlumbing {
  readonly registry: SessionStoreRegistry;
  readonly binder: SessionEventBinder;
}

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
 *     the Tier-8 opt-in is named in `main.tsx`. The cleanup has already disposed the
 *     registry by then and a disposed registry refuses every open, so the second
 *     mount publishes a fresh plumbing rather than keeping a corpse. It cannot be a
 *     render-phase comparison, because the disposal happens in an effect's cleanup
 *     and is invisible to the render that preceded it — so it is the resource hook's
 *     own `isClosed` arm, read where its lifetime effect runs, and not an effect
 *     written here.
 *
 * The binder is not returned. Nothing above this hook reads it — its whole surface
 * is the subscription it owns — and handing it out would invite a second caller to
 * attach or dispose it out from under this window.
 */
export function useSessionStoreRegistry(
  projectorRegistry: ConsoleEntityProjectorRegistry,
): SessionStoreRegistry {
  // Resolved from context rather than taken as an argument, so every caller of this
  // hook gets the same bridge the rest of the frame renders against and no surface
  // has to thread one through. `Spec-023`'s "the bridge is provided, never reached
  // for" is the same rule one layer down.
  const bridge = useConsoleBridge();
  // The bridge alone is the subject, and the projector registry deliberately is not:
  // the plumbing takes a SNAPSHOT of that table at construction, exactly so a later
  // registration cannot make one open store fold two events of one kind two ways. A
  // value the resource does not read live is not part of what the resource is about.
  const { value: plumbing } = useSubjectScopedResource<WindowSessionPlumbing>(
    bridge,
    undefined,
    () => createWindowSessionPlumbing(bridge, projectorRegistry),
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

/**
 * The registry and its binder, for one window.
 *
 * THE READ IS THE BRIDGE'S ANSWER, NOT A PLACEHOLDER EITHER WAY. A bridge that
 * serves the growth port's `sessionRead` gets the adapter below; one that refuses
 * gets the refusal itself, which names the operation, the slate row, and the
 * document that owes the wire — the same value a surface renders as the
 * `not-checked` kind of nothing. Neither arm is a reader resolving `undefined`,
 * which says something different: that one read happened and found nothing, and
 * the next may not.
 *
 * The binder acts on the difference. A store admits nothing until a read gives it
 * a base state, so a stream bound to a registry that can perform no read fills a
 * buffer nothing will ever drain: every event retained, none projected, for as
 * long as the window is open. `attach` reads
 * `SessionStoreRegistry.canInitialiseSessionStores` and takes no subscription at
 * all on that arm. The binder is still MINTED and attached on it — it is what
 * installs the window's session diagnostics.
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
  bridge: ConsoleBridge,
  projectorRegistry: ConsoleEntityProjectorRegistry,
): WindowSessionPlumbing {
  const registry = new SessionStoreRegistry({
    read: createSessionSnapshotRead(bridge),
    clock: consoleClockFor(bridge),
    // THE PROJECTORS ARE PART OF THE PLUMBING, not an optional extra. The registry
    // has taken them since it was written and this root registered none, so every
    // store it opened admitted its events into the timeline and projected them
    // into no partition at all — a runs surface that renders a live session as
    // having no runs, indistinguishable from one that has none. They are supplied
    // HERE and only here, so every store this window opens folds the same events
    // the same way; a surface that registered its own would be a second projection
    // of one stream.
    //
    // A SNAPSHOT OF THE REGISTRY, not the frame's own constant. The constant was a
    // table closed at build time by one family, so every other partition
    // `store/entities.ts` declares had no possible producer — and the families that
    // own those surfaces would have had to read the wire a second time to fill them.
    // Taking the snapshot HERE also fixes the composition order: families register
    // at module scope, before any window renders, and a store opens with whatever
    // that composition claimed. A snapshot rather than the registry itself, because
    // a store folds for as long as its session is open and a table that changed
    // underneath it would fold two events of one kind two ways.
    projectors: projectorRegistry.snapshot(),
  });
  return { registry, binder: new SessionEventBinder({ registry, bridge }) };
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
 * recognise it, and the window would go on addressing a registry that answers
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

/**
 * The read a window performs, resolved from what its bridge actually serves.
 *
 * The availability question is answered SYNCHRONOUSLY, off the bridge's served
 * set, and it has to be: the registry is built before any call can be awaited, and
 * a registry built optimistically would bind a stream under a live bridge whose
 * `daemon.subscribe` throws — a crash inside a mount effect rather than a refusal
 * a surface can render.
 *
 * A refusal from a bridge that DID claim to serve the read is a different fact and
 * takes a different path: it is raised, so the refresh scheduler's error arm marks
 * the store degraded rather than the adapter reporting "read nothing", which would
 * clear no degraded flag and look like a quiet success.
 *
 * AND THE RESUME POSITION IS FORWARDED, which is the half this adapter was missing.
 * `open-session-entry.ts` decides where the next read starts and hands the position
 * over as the reader's third argument; an adapter that named one parameter took the
 * decision and dropped it on the floor, and every read went on opening wherever it
 * opened before. TypeScript does not report that — a function of fewer parameters is
 * assignable to a function type with more — so the whole signature is written out here
 * and the behavioural gate in `session-lifecycle.resume-forwarding.test.tsx` is what holds
 * the forwarding, not the arity.
 *
 * `reasons` is deliberately UNREAD rather than absent: it is why this read was asked
 * for, which is the scheduler's own bookkeeping and no part of what the daemon is
 * being asked. Naming it is what makes the third parameter reachable at all, and
 * naming it without using it is the honest record that this seam has nothing to say
 * about it.
 *
 * The member is spread conditionally because `exactOptionalPropertyTypes` makes an
 * explicit `undefined` a different value from an absent member — and the absence IS
 * the meaning: no acknowledged position, so the read starts at the window's beginning.
 */
function createSessionSnapshotRead(bridge: ConsoleBridge): SessionSnapshotRead {
  if (!bridge.growthServedOperations.has("sessionRead")) {
    return growthUnavailable("sessionRead");
  }
  return async (
    sessionId: string,
    _reasons: readonly RefreshReason[],
    resumeFromCursor: string | undefined,
  ): Promise<SessionSnapshot> => {
    const outcome = await bridge.growth.sessionRead({
      sessionId,
      ...(resumeFromCursor === undefined ? {} : { fromCursor: resumeFromCursor }),
    });
    if (outcome.status === "served") {
      return outcome.value;
    }
    throw new ConsoleRefusalError(outcome);
  };
}
