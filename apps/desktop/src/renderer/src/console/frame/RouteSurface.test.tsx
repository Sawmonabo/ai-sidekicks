// A bare auxiliary route offers what this window has and what the node reports,
// never a read in flight — and a reserved slot says so rather than painting nothing.
//
// The case this file exists for: `#/window/timeline` with no session id is the one
// route the context picker is FOR, and it is exactly the route on which the picker
// used to read its candidates off `context.sessionStore` — the store for the
// route's own session, which a bare route does not have. The picker therefore sat
// on "loading" forever and could never offer anything. A read in flight is a state
// the picker has again, and legitimately: the directory read is a real one and it
// SETTLES, which is the property the old defect lacked and the property these
// cases assert. The assertions are about the sources, so they drive a real
// `SessionStoreRegistry` with real sessions open in it and a real growth port
// rather than stand-ins that would agree with whatever the code did.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { InvalidAuxiliaryRouteTargetError } from "../../../../shared/auxiliary-routes.js";
import type { GrowthPort } from "../bridge/index.js";
import { createFixtureBridge } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import {
  FrameStore,
  SessionStoreRegistry,
  useFrameStore,
  useLocationHash,
} from "../store/index.js";
import { formatRoute, type ConsoleRoute } from "../routing/index.js";
import { useHashRouteBinding } from "./hash-route-binding.js";
import { RouteSurface } from "./RouteSurface.js";
import {
  consoleSurfaceRegistry,
  registerConsoleSurface,
  type ConsoleSurfaceContext,
} from "./surface-registry.js";

/** The bare auxiliary address a Window-menu open lands on. */
const BARE_TIMELINE_ROUTE: ConsoleRoute = { kind: "auxiliary", route: "timeline" };

/** The bare route whose grammar takes an agent WITH its session or not at all. */
const BARE_AGENT_CONSOLE_ROUTE: ConsoleRoute = { kind: "auxiliary", route: "agent-console" };

/** The address that route is opened at, and the one it must still be at after a
 * session is chosen and no agent has been. */
const BARE_AGENT_CONSOLE_HASH = "#/window/agent-console";

const SESSION_WITH_AGENT = "session-with-agent";
const AGENT_ID = "agent-alpha";

/** The rail's middle destination, whose family (T-023p-1C-6) ships separately. */
const WORKFLOWS_ROUTE: ConsoleRoute = { kind: "workflows" };

/**
 * A registry with real sessions open, and a reader that answers nothing.
 *
 * The picker reads its candidates off the registry's open set and the directory
 * read, never a session snapshot, so a reader that answers `undefined` keeps these
 * cases about the two sources the picker actually consults.
 */
function registryWithOpenSessions(...sessionIds: readonly string[]): SessionStoreRegistry {
  const registry = new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });
  for (const sessionId of sessionIds) {
    registry.open(sessionId);
  }
  return registry;
}

/**
 * The fields the picker branch reads, and nothing else.
 *
 * The frame store and the registry are the real classes, because they are the
 * subject; the two persistence stores are cast away because constructing them
 * opens a database to hand a branch that never touches them — the same reason
 * `legacy-surfaces.test.ts` casts.
 */
function contextFor(
  route: ConsoleRoute,
  registry: SessionStoreRegistry,
  growth: GrowthPort = createRefusingGrowthPort(),
): { context: ConsoleSurfaceContext; frameStore: FrameStore } {
  const frameStore = new FrameStore({ initialRoute: route });
  const context = {
    route,
    // A REAL growth port, defaulting to the refusing one so a case that says
    // nothing about the directory gets the live bridge's answer rather than a
    // convenient one.
    bridge: { growth },
    frameStore,
    sessionStore: undefined,
    sessionStoreRegistry: registry,
  } as unknown as ConsoleSurfaceContext;
  return { context, frameStore };
}

/** The fixture's port, which serves the directory read the live bridge refuses. */
function fixtureGrowthPort(): GrowthPort {
  return createFixtureBridge({ scenario: FLAGSHIP_SCENARIO }).growth;
}

/** Let the directory read settle, so an assertion is about the answer. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

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
}): React.JSX.Element {
  const hash = useLocationHash();
  useHashRouteBinding(props.frameStore, hash);
  const route = useFrameStore(props.frameStore, (state) => state.route);
  const context = {
    route,
    bridge: { growth: createRefusingGrowthPort() },
    frameStore: props.frameStore,
    sessionStore: undefined,
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
): ReturnType<typeof render> {
  window.location.hash = formatRoute(frameStore.getState().route);
  return render(<BoundRouteSurface frameStore={frameStore} registry={registry} />);
}

/** Click one offered identifier by the accessible name its row carries. */
async function clickChoice(value: string): Promise<void> {
  const choice = screen.getByRole("button", { name: value });
  await act(async () => {
    fireEvent.click(choice);
    await Promise.resolve();
  });
}

describe("RouteSurface — the picker on a bare auxiliary route", () => {
  afterEach(() => {
    cleanup();
  });

  it("offers the sessions this window has open", () => {
    const registry = registryWithOpenSessions("session-alpha", "session-beta");
    const { context } = contextFor(BARE_TIMELINE_ROUTE, registry);

    render(<RouteSurface context={context} />);

    expect(screen.getByRole("button", { name: "session-alpha" })).toBeDefined();
    expect(screen.getByRole("button", { name: "session-beta" })).toBeDefined();
  });

  it("never leaves a read in flight on screen, because the read it makes settles", async () => {
    // The defect this file was written for renders as the `not-loaded` kind of
    // nothing, whose block form is the only thing on this surface that carries
    // `aria-busy`, and it never went away. Asserting its absence AFTER the
    // directory read settles names that failure rather than forbidding a loading
    // state the surface is now entitled to show for one frame.
    const registry = registryWithOpenSessions();
    const { context } = contextFor(BARE_TIMELINE_ROUTE, registry);

    const { container } = render(<RouteSurface context={context} />);
    await settle();

    expect(container.querySelector("[aria-busy='true']")).toBeNull();
  });

  it("offers the node's sessions when the bridge serves the directory read", async () => {
    // The window has none open, so every row on screen came from the directory —
    // which is what the picker could not do at all before the read had a producer.
    const registry = registryWithOpenSessions();
    const { context } = contextFor(BARE_TIMELINE_ROUTE, registry, fixtureGrowthPort());

    render(<RouteSurface context={context} />);
    await settle();

    expect(screen.getByRole("button", { name: FLAGSHIP_SCENARIO.sessionId })).toBeDefined();
  });

  it("navigates the window to the session that was chosen", () => {
    const registry = registryWithOpenSessions("session-alpha");
    const { context, frameStore } = contextFor(BARE_TIMELINE_ROUTE, registry);

    render(<RouteSurface context={context} />);
    screen.getByRole("button", { name: "session-alpha" }).click();

    expect(frameStore.getState().route).toStrictEqual({
      kind: "auxiliary",
      route: "timeline",
      sessionId: "session-alpha",
    });
  });

  it("negative control: with nothing open and a refused directory it says so, and offers no session", async () => {
    // Without this, a picker that rendered every id it was ever handed — or one
    // that rendered a row per nothing — would satisfy the cases above. The wording
    // is the `not-checked` one on purpose: the console did not ask the node, and
    // reporting an empty node for a question never put is the conflation the five
    // kinds of nothing exist to prevent.
    const registry = registryWithOpenSessions();
    const { context } = contextFor(BARE_TIMELINE_ROUTE, registry);

    const { container } = render(<RouteSurface context={context} />);
    await settle();

    expect(screen.queryAllByRole("button")).toStrictEqual([]);
    expect(container.textContent).toContain("This window has no session open.");
    // The picker's absence renders as a badge, whose second line can only travel as
    // a tooltip — so the refusal is read off the attribute that actually carries it
    // rather than off text that was never going to be in the tree.
    expect(
      container.querySelector(".meridian-nothing__badge-label")?.getAttribute("title"),
    ).toContain("has not asked the node for the rest");
    expect(container.querySelector("[aria-busy='true']")).toBeNull();
  });

  it("negative control: a route that names a session takes the opening arm instead", () => {
    // The picker branch is guarded on the route having no session, and a guard
    // that had stopped guarding would show the picker on every auxiliary route.
    const registry = registryWithOpenSessions("session-alpha");
    const { context } = contextFor(
      { kind: "auxiliary", route: "timeline", sessionId: "session-alpha" },
      registry,
    );

    const { container } = render(<RouteSurface context={context} />);

    expect(container.textContent).not.toContain("Which session should this timeline follow?");
  });
});

describe("RouteSurface — a declared slot with no registrant", () => {
  afterEach(() => {
    cleanup();
  });

  it("says the workflows surface is reserved rather than rendering nothing", () => {
    // The rail's middle destination is reachable before the family that fills it
    // has shipped, which is exactly the state "reserved, not stubbed" is for: the
    // frame names the slot and says nobody has built it, and the alternative — an
    // empty pane — reads as a feature that is broken rather than absent.
    const { context } = contextFor(WORKFLOWS_ROUTE, registryWithOpenSessions());

    const { container } = render(<RouteSurface context={context} />);

    expect(container.querySelector(".meridian-frame__absence")).not.toBeNull();
    expect(container.textContent).toContain("This surface has not been built yet.");
    expect(container.textContent).toContain("workflows");
    expect(container.querySelector("[aria-busy='true']")).toBeNull();
  });

  it("negative control: the same route mounts the family once one claims the slot", () => {
    // Without this, a frame that had stopped resolving the registry at all would
    // satisfy the case above by rendering the absence for every route forever.
    const owner = "route-surface-test";
    try {
      registerConsoleSurface({
        slot: "workflows",
        owner,
        render: () => <p>the workflow builder rendered</p>,
      });
      const { context } = contextFor(WORKFLOWS_ROUTE, registryWithOpenSessions());

      const { container } = render(<RouteSurface context={context} />);

      expect(container.textContent).toContain("the workflow builder rendered");
      expect(container.querySelector(".meridian-frame__absence")).toBeNull();
    } finally {
      consoleSurfaceRegistry.unregister("workflows");
    }
  });
});

describe("RouteSurface — an agent-console window collects both identifiers before it navigates", () => {
  afterEach(async () => {
    cleanup();
    // The reset queues a `hashchange` of its own, and happy-dom delivers queued
    // ones on a debounced timer. Landing it here, with no binding mounted, keeps
    // it out of the next case's flush — `hash-route-binding.test.tsx` records the
    // same reason for the same shape.
    window.location.hash = "";
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
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
    await settle();
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
    await settle();
    await clickChoice(SESSION_WITH_AGENT);
    await clickChoice(AGENT_ID);
    await settle();

    expect(frameStore.getState().route).toStrictEqual({
      kind: "auxiliary",
      route: "agent-console",
      sessionId: SESSION_WITH_AGENT,
      agentId: AGENT_ID,
    });
    expect(window.location.hash).toBe(`#/window/agent-console/${SESSION_WITH_AGENT}/${AGENT_ID}`);
  });

  it("says the session has no agents rather than offering an incomplete one", async () => {
    // A session whose store is initialised and holds none. Not "reading", not a
    // list with nothing in it, and above all not a navigation: the honest answer
    // is that there is nothing here to follow.
    const registry = registryWithSessionAgents(SESSION_WITH_AGENT, []);
    const frameStore = new FrameStore({ initialRoute: BARE_AGENT_CONSOLE_ROUTE });

    const { container } = renderBoundSurface(frameStore, registry);
    await settle();
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
    await settle();
    await clickChoice(SESSION_WITH_AGENT);
    await settle();

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
