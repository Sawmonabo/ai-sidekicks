// An agent-console window collects both identifiers before it navigates.
//
// The defect this file was written for: choosing a session on `#/window/agent-console`
// built `{ route: "agent-console", sessionId }` and handed it to the route-to-hash
// effect, whose shared producer refuses exactly that shape by THROWING — outside any
// surface boundary, from inside an effect. So the picker has to hold a half-built
// target rather than publish it, and the assertions are both halves: nothing threw,
// and nothing was written.
//
// The window's real hash binding is mounted around the surface, because the binding
// is the half that broke: it reads the route the store holds and publishes it, and
// driving the real one is the only way a case can say "nothing was written" and mean
// it. The registry and its stores are real for the same reason — the agent step reads
// a partition, and a stand-in store would agree with whatever the step did.
//
// The picker on a route whose grammar takes one identifier, and the reserved slot,
// are `RouteSurface.test.tsx`.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { InvalidAuxiliaryRouteTargetError } from "../../../../shared/auxiliary-routes.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { createRefusingGrowthPort } from "../bridge/growth-port/growth-port.js";
import { settle as settleReactWork } from "../core/settle.test-support.js";
import {
  FrameStore,
  SessionStoreRegistry,
  useFrameStore,
  useLocationHash,
  type SessionStore,
} from "../store/index.js";
import { formatRoute, type ConsoleRoute } from "../routing/index.js";
import { useHashRouteBinding } from "./hash-route-binding.js";
import { RouteSurface } from "./RouteSurface.js";
import { BARE_TIMELINE_ROUTE } from "./RouteSurface.test-support.js";
import { consoleSurfaceRegistry, type ConsoleSurfaceContext } from "../seats/index.js";
import { deferredBodyModule } from "../seats/lazy-body.test-support.js";
// The pending marker's reader by its own leaf specifier: the seats door carries no line
// for it, and its own header says why — a door line whose only consumer is a test is a
// specifier no shipped module reaches.
import { pendingPaneKindsIn } from "../seats/pending-pane-body.js";
// The module-scope registration door by its own specifier, on `RouteSurface.test.tsx`'s
// reason: the seats door does not publish it.
import { registerConsoleSurface } from "../seats/surface-registry.js";

/** The bare route whose grammar takes an agent WITH its session or not at all. */
const BARE_AGENT_CONSOLE_ROUTE: ConsoleRoute = { kind: "auxiliary", route: "agent-console" };

/** The address that route is opened at, and the one it must still be at after a
 * session is chosen and no agent has been. */
const BARE_AGENT_CONSOLE_HASH = "#/window/agent-console";

const SESSION_WITH_AGENT = "session-with-agent";
const AGENT_ID = "agent-alpha";
/** A second agent in the same session, so a second choice is a different destination. */
const OTHER_AGENT_ID = "agent-beta";

/**
 * Somewhere else entirely, for the case that navigates away mid-warm.
 *
 * The sessions list rather than another auxiliary route: it needs no registration, mounts
 * no picker of its own, and is the address a person actually reaches when they abandon a
 * window they opened by mistake.
 */
const SESSIONS_ROUTE: ConsoleRoute = { kind: "sessions" };
const SESSIONS_HASH = "#/sessions";

/**
 * A registry holding one open, INITIALISED session with these agents in it.
 *
 * The real store and the real `initialise` the refresh scheduler calls, because
 * the agent step reads a partition and a stand-in store would agree with whatever
 * the step did. `read` answers nothing: the base state is established here, and
 * what the picker is being asked about is what the store then holds.
 */
function registryWithSessionAgents(
  sessionId: string,
  agentIds: readonly string[],
): SessionStoreRegistry {
  const registry = new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });
  registry.open(sessionId).initialise({
    cursor: 0,
    entities: agentIds.map((agentId) => ({ kind: "agent", id: agentId }) as const),
    participantJoinLog: [],
  });
  return registry;
}

/**
 * The surface with the window's real hash binding around it.
 *
 * The binding is the half that broke: it reads the route the store holds and
 * publishes it, so a route the shared producer refuses throws from inside its
 * effect. Driving the real one is the only way a case can say "nothing was
 * written" and mean it.
 */
function BoundRouteSurface(props: {
  readonly frameStore: FrameStore;
  readonly registry: SessionStoreRegistry;
  /**
   * The store the surface arm reads, for the one case that navigates all the way.
   *
   * Absent everywhere else, because every other case in this file asserts on what the
   * PICKER did and stops at the bare route. `RouteSurface`'s third arm — a route naming a
   * session whose store is not open — stands between the commit and the registry, so a
   * case that wants to see the surface mount has to hand the frame the store the window's
   * own session lifecycle would have opened.
   *
   * `| undefined` beside the `?`, because this prop is a pass-through into
   * `ConsoleSurfaceContext.sessionStore`, which the seam declares required-and-nullable —
   * absent and explicitly-absent are the same fact to every reader downstream. Under
   * `exactOptionalPropertyTypes` an exact-optional prop would refuse the forwarded
   * `SessionStore | undefined` and buy nothing: the distinction it enforces does not
   * survive into the context this component builds.
   */
  readonly sessionStore?: SessionStore | undefined;
}): React.JSX.Element {
  const hash = useLocationHash();
  useHashRouteBinding(props.frameStore, hash);
  const route = useFrameStore(props.frameStore, (state) => state.route);
  const context = {
    route,
    bridge: { growth: createRefusingGrowthPort() },
    frameStore: props.frameStore,
    sessionStore: props.sessionStore,
    sessionStoreRegistry: props.registry,
  } as unknown as ConsoleSurfaceContext;
  return <RouteSurface context={context} />;
}

/**
 * Open the window AT the route its store starts on, then mount the binding.
 *
 * The address and the store have to agree at mount or the hash-to-route direction
 * adopts whatever the address happens to hold and the window is somewhere else
 * before the first click — which is the same fact `ConsoleRoot` records about a
 * store born on the opening hash.
 */
function renderBoundSurface(
  frameStore: FrameStore,
  registry: SessionStoreRegistry,
  sessionStore?: SessionStore,
): ReturnType<typeof render> {
  window.location.hash = formatRoute(frameStore.getState().route);
  return render(
    <BoundRouteSurface frameStore={frameStore} registry={registry} sessionStore={sessionStore} />,
  );
}

/** Click one offered identifier by the accessible name its row carries. */
async function clickChoice(value: string): Promise<void> {
  const choice = screen.getByRole("button", { name: value });
  await act(async () => {
    fireEvent.click(choice);
    await crossMacrotaskBoundary();
  });
}

describe("RouteSurface — an agent-console window collects both identifiers before it navigates", () => {
  afterEach(async () => {
    cleanup();
    // The reset queues a `hashchange` of its own, and happy-dom delivers queued
    // ones on a debounced timer. Landing it here, with no binding mounted, keeps
    // it out of the next case's flush — `hash-route-binding.test.tsx` records the
    // same reason for the same shape.
    window.location.hash = "";
    await crossMacrotaskBoundary();
  });

  it("writes no hash when a session is chosen, because the target is not complete yet", async () => {
    // The defect: choosing a session here built `{ route: "agent-console",
    // sessionId }` and handed it to the route-to-hash effect, whose shared
    // producer refuses exactly that shape by throwing — outside any surface
    // boundary, from inside an effect. So the assertion is BOTH halves: nothing
    // threw, and nothing was published.
    const registry = registryWithSessionAgents(SESSION_WITH_AGENT, [AGENT_ID]);
    const frameStore = new FrameStore({ initialRoute: BARE_AGENT_CONSOLE_ROUTE });

    const { container } = renderBoundSurface(frameStore, registry);
    await settleReactWork();
    await clickChoice(SESSION_WITH_AGENT);

    expect(frameStore.getState().route).toStrictEqual(BARE_AGENT_CONSOLE_ROUTE);
    // Still the bare address the window opened at: nothing was published, and in
    // particular no half-built one was attempted.
    expect(window.location.hash).toBe(BARE_AGENT_CONSOLE_HASH);
    // The window stays on the picker, and it names the session already chosen so
    // the second question is about something.
    expect(container.textContent).toContain("Which agent should this agent console follow?");
    expect(container.textContent).toContain(SESSION_WITH_AGENT);
  });

  it("writes exactly the full fragment once the agent is chosen", async () => {
    const registry = registryWithSessionAgents(SESSION_WITH_AGENT, [AGENT_ID]);
    const frameStore = new FrameStore({ initialRoute: BARE_AGENT_CONSOLE_ROUTE });

    renderBoundSurface(frameStore, registry);
    await settleReactWork();
    await clickChoice(SESSION_WITH_AGENT);
    await clickChoice(AGENT_ID);
    await settleReactWork();

    expect(frameStore.getState().route).toStrictEqual({
      kind: "auxiliary",
      route: "agent-console",
      sessionId: SESSION_WITH_AGENT,
      agentId: AGENT_ID,
    });
    expect(window.location.hash).toBe(`#/window/agent-console/${SESSION_WITH_AGENT}/${AGENT_ID}`);
  });

  it("warms the chosen surface before it commits, so no reserved frame is ever drawn", async () => {
    // WHAT THIS PATH HAS THAT THE RAIL'S DOES NOT: nothing underneath. A rail press
    // happens on a painted surface, so its warm rides beside the commit and the reserved
    // frame is the honest thing to show for the frames the chunk is still in flight. Here
    // the picker IS the surface, and committing first replaced a working control with a
    // reserved region — after an explicit act, on the one path where the console knew the
    // destination before the person let go of the mouse. So the choice waits, and the
    // route commits onto a module that has already landed.
    //
    // The arrival is the CASE's, through the shared deferred loader: a loader built over
    // `Promise.resolve` lands inside the first settle, so a choose that waited for
    // nothing at all would satisfy every assertion below just as well.
    const deferred = deferredBodyModule<ConsoleSurfaceContext>();
    const owner = "route-surface-warm-test";
    try {
      registerConsoleSurface({ slot: "agent-console", owner, body: deferred.load });
      const registry = registryWithSessionAgents(SESSION_WITH_AGENT, [AGENT_ID]);
      const frameStore = new FrameStore({ initialRoute: BARE_AGENT_CONSOLE_ROUTE });

      // Handed the store the window's own session lifecycle would have opened, so the
      // commit reaches the registry rather than stopping at the opening arm — this is the
      // one case in the file that navigates all the way to a surface.
      const { container } = renderBoundSurface(
        frameStore,
        registry,
        registry.open(SESSION_WITH_AGENT),
      );
      await settleReactWork();
      await clickChoice(SESSION_WITH_AGENT);
      await clickChoice(AGENT_ID);
      await settleReactWork();

      // The body has not arrived, so the route has not moved and the picker is still on
      // screen. Without the warm the route would already be here — and the window would
      // be showing the reserved frame the next assertion says it never shows.
      expect(frameStore.getState().route).toStrictEqual(BARE_AGENT_CONSOLE_ROUTE);
      expect(pendingPaneKindsIn(container)).toStrictEqual([]);

      await act(async () => {
        deferred.arrive(() => createElement("p", null, "the agent console body"));
        await crossMacrotaskBoundary();
      });
      await settleReactWork();

      expect(frameStore.getState().route).toStrictEqual({
        kind: "auxiliary",
        route: "agent-console",
        sessionId: SESSION_WITH_AGENT,
        agentId: AGENT_ID,
      });
      expect(container.textContent).toContain("the agent console body");
      // The commit landed on a settled module, so the surface never suspended and the
      // reserved frame was never committed — which is the whole claim.
      expect(pendingPaneKindsIn(container)).toStrictEqual([]);
    } finally {
      consoleSurfaceRegistry.unregister("agent-console");
    }
  });

  it("leaves a route reached during the warm alone when the load lands behind it", async () => {
    // THE COST OF WAITING. The case above buys "no reserved frame" by holding the picker
    // up until the chunk lands, and what that buys is a window — as long as the fetch
    // takes — in which the window can be somewhere else by the time the continuation
    // runs. Unguarded it navigated anyway, so a person who chose a subject, changed their
    // mind and went to the sessions list was dragged into the agent console a moment
    // later, by a press they had already abandoned.
    //
    // The arrival is the case's for the reason the warm case states: a loader over
    // `Promise.resolve` settles inside the first drain, before there is any interval in
    // which to navigate at all.
    const deferred = deferredBodyModule<ConsoleSurfaceContext>();
    const owner = "route-surface-stale-commit-test";
    try {
      registerConsoleSurface({ slot: "agent-console", owner, body: deferred.load });
      const registry = registryWithSessionAgents(SESSION_WITH_AGENT, [AGENT_ID]);
      const frameStore = new FrameStore({ initialRoute: BARE_AGENT_CONSOLE_ROUTE });

      renderBoundSurface(frameStore, registry, registry.open(SESSION_WITH_AGENT));
      await settleReactWork();
      await clickChoice(SESSION_WITH_AGENT);
      await clickChoice(AGENT_ID);
      await settleReactWork();
      expect(frameStore.getState().route).toStrictEqual(BARE_AGENT_CONSOLE_ROUTE);

      // Away, while the chunk is still in flight. Through the store rather than the
      // address, because this is the direction a rail press takes and the binding
      // publishes it either way.
      await act(async () => {
        frameStore.navigate(SESSIONS_ROUTE);
        await crossMacrotaskBoundary();
      });
      await settleReactWork();

      await act(async () => {
        deferred.arrive(() => createElement("p", null, "the agent console body"));
        await crossMacrotaskBoundary();
      });
      await settleReactWork();

      // The newer address stands, and the address bar agrees with it — the second
      // assertion is what says the settled continuation wrote nothing anywhere, rather
      // than writing a route the store then happened to overwrite.
      expect(frameStore.getState().route).toStrictEqual(SESSIONS_ROUTE);
      expect(window.location.hash).toBe(SESSIONS_HASH);
    } finally {
      consoleSurfaceRegistry.unregister("agent-console");
    }
  });

  it("commits the second choice even when the first choice's chunk lands first", async () => {
    // The other way the wait is overtaken, and the one the ROUTE comparison cannot answer:
    // the person chose, waited, and chose again without leaving. Both choices were made at
    // the same bare address, so both continuations find the address unchanged and both are
    // entitled to commit — and the one that lands first wins. Nothing behind a chunk fetch
    // is cancellable, and chunk arrival order is not choice order, so the person who chose
    // beta got alpha because alpha's chunk was smaller.
    //
    // THE ABANDONED LOAD LANDS FIRST HERE, DELIBERATELY. That is the only ordering in which
    // the latch is the thing deciding: with the newest arriving first, the stale one is
    // already refused by the address it was chosen at, and the case would be green over a
    // console that had no latch at all.
    //
    // TWO LOADERS, NOT ONE RE-REGISTERED PROMISE. `LoadedLazyBody` memoises on the promise,
    // so a second choice against one registration joins the first load and both
    // continuations settle in the same drain, at which point the ordering rather than the
    // latch picks the winner. Re-registering between the choices gives each one a load of
    // its own to settle at its own moment.
    const firstLoad = deferredBodyModule<ConsoleSurfaceContext>();
    const secondLoad = deferredBodyModule<ConsoleSurfaceContext>();
    const owner = "route-surface-superseded-choice-test";
    try {
      registerConsoleSurface({ slot: "agent-console", owner, body: firstLoad.load });
      const registry = registryWithSessionAgents(SESSION_WITH_AGENT, [AGENT_ID, OTHER_AGENT_ID]);
      const frameStore = new FrameStore({ initialRoute: BARE_AGENT_CONSOLE_ROUTE });

      renderBoundSurface(frameStore, registry, registry.open(SESSION_WITH_AGENT));
      await settleReactWork();
      await clickChoice(SESSION_WITH_AGENT);
      await clickChoice(AGENT_ID);
      await settleReactWork();

      registerConsoleSurface({ slot: "agent-console", owner, body: secondLoad.load });
      await clickChoice(OTHER_AGENT_ID);
      await settleReactWork();

      // The ABANDONED choice's chunk lands first, onto a superseded round, and installs
      // nothing — the assertion the whole case exists for. The address is still bare, so
      // nothing but the latch is refusing it.
      await act(async () => {
        firstLoad.arrive(() => createElement("p", null, "the agent console body"));
        await crossMacrotaskBoundary();
      });
      await settleReactWork();
      expect(frameStore.getState().route).toStrictEqual(BARE_AGENT_CONSOLE_ROUTE);

      // And the choice the person actually made commits when its own chunk lands.
      await act(async () => {
        secondLoad.arrive(() => createElement("p", null, "the agent console body"));
        await crossMacrotaskBoundary();
      });
      await settleReactWork();
      expect(frameStore.getState().route).toStrictEqual({
        kind: "auxiliary",
        route: "agent-console",
        sessionId: SESSION_WITH_AGENT,
        agentId: OTHER_AGENT_ID,
      });
    } finally {
      consoleSurfaceRegistry.unregister("agent-console");
    }
  });

  it("says the session has no agents rather than offering an incomplete one", async () => {
    // A session whose store is initialised and holds none. Not "reading", not a
    // list with nothing in it, and above all not a navigation: the honest answer
    // is that there is nothing here to follow.
    const registry = registryWithSessionAgents(SESSION_WITH_AGENT, []);
    const frameStore = new FrameStore({ initialRoute: BARE_AGENT_CONSOLE_ROUTE });

    const { container } = renderBoundSurface(frameStore, registry);
    await settleReactWork();
    await clickChoice(SESSION_WITH_AGENT);

    expect(container.textContent).toContain("This session has no agents yet.");
    expect(frameStore.getState().route).toStrictEqual(BARE_AGENT_CONSOLE_ROUTE);
    expect(window.location.hash).toBe(BARE_AGENT_CONSOLE_HASH);
  });

  it("negative control: the timeline route, whose grammar wants only a session, navigates on the first choice", async () => {
    // Without this, a picker that had simply stopped navigating at all would
    // satisfy the first case. The difference between the two routes is the
    // grammar's, and this is the arm where one choice is genuinely enough.
    const registry = registryWithSessionAgents(SESSION_WITH_AGENT, [AGENT_ID]);
    const frameStore = new FrameStore({ initialRoute: BARE_TIMELINE_ROUTE });

    renderBoundSurface(frameStore, registry);
    await settleReactWork();
    await clickChoice(SESSION_WITH_AGENT);
    await settleReactWork();

    expect(frameStore.getState().route).toStrictEqual({
      kind: "auxiliary",
      route: "timeline",
      sessionId: SESSION_WITH_AGENT,
    });
    expect(window.location.hash).toBe(`#/window/timeline/${SESSION_WITH_AGENT}`);
  });

  it("negative control: the shared grammar still refuses a hand-built partial target", async () => {
    // The fix is at the source of the partial target, NOT a relaxation of the
    // producer — so the throw that used to escape the hash writer is still there
    // for anyone who builds one another way. A picker that had been fixed by
    // loosening the grammar would fail here.
    expect(() =>
      formatRoute({
        kind: "auxiliary",
        route: "agent-console",
        sessionId: SESSION_WITH_AGENT,
      } as ConsoleRoute),
    ).toThrow(InvalidAuxiliaryRouteTargetError);
  });
});
