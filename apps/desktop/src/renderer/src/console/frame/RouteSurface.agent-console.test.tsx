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
import { afterEach, describe, expect, it } from "vitest";

import { InvalidAuxiliaryRouteTargetError } from "../../../../shared/auxiliary-routes.js";
import { drainMicrotasks } from "../core/microtask-drain.test-support.js";
import { createRefusingGrowthPort } from "../bridge/growth-port/growth-port.js";
import {
  FrameStore,
  SessionStoreRegistry,
  useFrameStore,
  useLocationHash,
} from "../store/index.js";
import { formatRoute, type ConsoleRoute } from "../routing/index.js";
import { useHashRouteBinding } from "./hash-route-binding.js";
import { RouteSurface } from "./RouteSurface.js";
import { BARE_TIMELINE_ROUTE, settle } from "./RouteSurface.test-support.js";
import { type ConsoleSurfaceContext } from "../seats/index.js";

/** The bare route whose grammar takes an agent WITH its session or not at all. */
const BARE_AGENT_CONSOLE_ROUTE: ConsoleRoute = { kind: "auxiliary", route: "agent-console" };

/** The address that route is opened at, and the one it must still be at after a
 * session is chosen and no agent has been. */
const BARE_AGENT_CONSOLE_HASH = "#/window/agent-console";

const SESSION_WITH_AGENT = "session-with-agent";
const AGENT_ID = "agent-alpha";

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
    await drainMicrotasks();
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
    await drainMicrotasks();
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
