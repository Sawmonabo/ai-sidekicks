// The two mounts wear two frames, and only one of them is the deck's.
//
// THIS IS THE CLAIM THE SPLIT WAS MADE FOR. While one component was both mounts it drew
// a section and a head of its own, and the deck never wrapped it in
// `seats/ConsolePaneChrome` — so `agent-console`, one of exactly two kinds
// `isDetachablePaneKind` admits, was the one whose deck pane could not show the control
// that opens it in a window. Nothing failed: the chrome's own suite proves that control
// renders for every detachable kind, and it was right, because the chrome was never
// reached. The gap was in the REGISTRAR, so every case below drives a registrar rather
// than either component.
//
// WHAT IS REAL HERE AND WHAT IS CAST, AND WHY THE LINE IS DRAWN THERE. The bridge is
// real: the machines column dispatches through it on mount, so a cast one would be a
// column reading `undefined` as a function, and that column is exactly what a
// frame-shaped case would not notice. The deck pane's session store is real for a
// different reason — its id is what the registrar reads off it and hands the chrome, so
// a cast or absent store would leave every case below passing over a registrar that
// passed no session at all. What IS cast is the frame store, the UI-state store, the
// draft store and the session-store registry, which neither registrar reads: standing
// them up would be a fixture built to satisfy a type nothing under test looks at, which
// is the line `ConsolePaneChrome.test.tsx` draws for the same reason.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { SETTINGS_SCENARIO } from "../../bridge/scenarios/settings.js";
import { ConsoleSurfaceRegistry, type ConsoleSurfaceContext } from "../../seats/index.js";
import { SessionStore } from "../../store/index.js";
import { ConsolePaneRegistry, PaneControlsContext } from "../../seats/index.js";
import { registerAgentConsolePane, registerAgentConsoleSurface } from "./agent-console-mounts.js";
import { settleReads } from "./agent-console.test-support.js";

/** The tick this scenario's two machines are both attached at. */
const BOTH_MACHINES_ONLINE_MS = 200;

/** The session the fixture plays, so the roster read is answered rather than refused. */
const PLAYED_SESSION_ID = SETTINGS_SCENARIO.sessionId;

/** The agent both mounts are addressed at, wherever a case addresses one. */
const ADDRESSED_AGENT_ID = "agent-scout";

/**
 * What the deck hands a pane body's render — derived, never imported by name.
 *
 * The door's own context type still carries a `@consumedBy` exemption for the five pane
 * bodies that have not landed, and knip counts a co-located test as a consumer: naming
 * the type here would retire an exemption four other tasks are still relying on. The
 * registry's method signature is the same contract with no tag on it.
 */
type DeckPaneContext = Parameters<
  NonNullable<ReturnType<ConsolePaneRegistry["descriptorFor"]>>["render"]
>[0];

function fixtureBridge(): ConsoleBridge {
  const bridge = createFixtureBridge({ scenario: SETTINGS_SCENARIO });
  bridge.scenarioEngine?.advance(BOTH_MACHINES_ONLINE_MS);
  return bridge;
}

/**
 * The store the deck's pane is open on: the session the fixture actually plays.
 *
 * A real store rather than an absent one, because the session id is what the registrar
 * reads OFF it and hands the chrome — a pane mounted with no store would leave the
 * trail's session crumb absent, and every case below would then pass over a registrar
 * that never passed one.
 */
function playedSessionStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: PLAYED_SESSION_ID });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return sessionStore;
}

/** The address the deck opens this pane at, over one agent or bare. */
function deckPaneContext(agentId: string | undefined, bridge: ConsoleBridge): DeckPaneContext {
  return {
    kind: "agent-console",
    entity: agentId === undefined ? undefined : { kind: "agent", id: agentId },
    paneId: "pane-1",
    bridge,
    sessionStore: playedSessionStore(),
    linkedSourcePaneId: undefined,
    focusHue: undefined,
  } as unknown as DeckPaneContext;
}

/** The address the Window menu opens the auxiliary window at. */
function windowSurfaceContext(
  agentId: string | undefined,
  bridge: ConsoleBridge,
): ConsoleSurfaceContext {
  return {
    route: { kind: "auxiliary", route: "agent-console", sessionId: PLAYED_SESSION_ID, agentId },
    bridge,
    sessionStore: undefined,
  } as unknown as ConsoleSurfaceContext;
}

/** Mount the deck's pane and let both of the columns that read settle. */
async function renderDeckPane(
  agentId: string | undefined,
  hostControls?: { readonly onClose: () => void; readonly onOpenInWindow: () => void },
): Promise<HTMLElement> {
  const registry = new ConsolePaneRegistry();
  registerAgentConsolePane(registry);
  // The body is loader-backed, so it is fetched before the mount rather than during it —
  // which is what a window does too, through the idle warm after its first frame. Without
  // it every case below would be waiting on a dynamic import inside a bounded `findBy`,
  // and would report the roster as never arriving whenever the import took longer than
  // the wait.
  await registry.preload("agent-console");
  const descriptor = registry.descriptorFor("agent-console");
  if (descriptor === undefined) {
    throw new Error("the agent console registered no pane descriptor");
  }
  const bridge = fixtureBridge();
  const pane = descriptor.render(deckPaneContext(agentId, bridge));
  const { container } = render(
    hostControls === undefined ? (
      <>{pane}</>
    ) : (
      <PaneControlsContext.Provider value={hostControls}>{pane}</PaneControlsContext.Provider>
    ),
  );
  await screen.findByLabelText("node-roster-loaded");
  // The binding column's own reads are scheduled through the refresh chokepoint, so
  // they land only once the scenario clock has passed its debounce. Without this they
  // settle after the case has ended, which is a state update outside `act`.
  await settleReads(bridge);
  return container;
}

/** Mount the auxiliary window's surface and let the same column settle. */
async function renderWindowSurface(agentId: string | undefined): Promise<HTMLElement> {
  const registry = new ConsoleSurfaceRegistry();
  registerAgentConsoleSurface(registry);
  // Fetched before the mount, for the pane's reason above.
  await registry.preload("agent-console");
  const descriptor = registry.descriptorFor("agent-console");
  if (descriptor === undefined) {
    throw new Error("the agent console registered no surface descriptor");
  }
  const bridge = fixtureBridge();
  const { container } = render(<>{descriptor.render(windowSurfaceContext(agentId, bridge))}</>);
  await screen.findByLabelText("node-roster-loaded");
  await settleReads(bridge);
  return container;
}

/** The element a pane names itself by, resolved the way an assistive reader does. */
function accessibleName(named: HTMLElement): string {
  const labelledBy = named.getAttribute("aria-labelledby");
  if (labelledBy === null) {
    throw new Error("the surface names itself by nothing");
  }
  const naming = named.ownerDocument.getElementById(labelledBy);
  if (naming === null) {
    throw new Error(`it names itself by "${labelledBy}", which is on no element`);
  }
  return naming.textContent ?? "";
}

/** The one element a mount is expected to have drawn, or a failure that says which. */
function requireElement(container: HTMLElement, selector: string): HTMLElement {
  const found = container.querySelector(selector);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`this mount drew no ${selector}`);
  }
  return found;
}

describe("the deck's mount — the body inside the console's one chrome", () => {
  it("wraps the body in the shared chrome rather than a frame of its own", async () => {
    const container = await renderDeckPane(ADDRESSED_AGENT_ID);

    const pane = requireElement(container, ".meridian-pane.meridian-pane--agent-console");
    // Inside the chrome's own body box, which is the whole difference: a body that
    // drew its own section would render this element as a sibling of nothing.
    expect(pane.querySelector(".meridian-pane__body > .meridian-agent-console")).not.toBeNull();
    expect(pane.querySelector(".meridian-agent-console__columns")).not.toBeNull();
  });

  it("is named by the chrome's trail, and the body adds no second name", async () => {
    const container = await renderDeckPane(ADDRESSED_AGENT_ID);
    const pane = requireElement(container, ".meridian-pane");

    // All three of the address members the registrar hands the chrome, read back off
    // the one element the pane names itself by. The agent is a CRUMB of that name,
    // which is why the subject sentence the body used to draw is the window mount's
    // and not this one's: here it would repeat the id one element from the trail.
    expect(accessibleName(pane)).toContain(PLAYED_SESSION_ID);
    expect(accessibleName(pane)).toContain(ADDRESSED_AGENT_ID);
    expect(accessibleName(pane)).toContain("Agent console");
    expect(pane.querySelectorAll("h1, h2")).toHaveLength(0);
  });

  it("offers the detach control once the deck provides one", async () => {
    // The reason this lane exists. `agent-console` is one of the two kinds the window
    // model can open, and the deck hands every pane it lays out the same two handlers
    // — so reaching the chrome at all is what decides whether the control is drawn.
    const container = await renderDeckPane(ADDRESSED_AGENT_ID, {
      onClose: () => undefined,
      onOpenInWindow: () => undefined,
    });

    const labels = [...container.querySelectorAll(".meridian-pane__control")].map((control) =>
      control.getAttribute("aria-label"),
    );
    expect(labels).toStrictEqual(["Open this agent console in its own window", "Close this pane"]);
  });

  it("negative control: no host, no controls — absent rather than disabled", async () => {
    // Without this the case above would pass over a chrome that drew both buttons
    // whatever the host offered, which is the disabled-looking strip the rule forbids.
    const container = await renderDeckPane(ADDRESSED_AGENT_ID);
    expect(container.querySelectorAll(".meridian-pane__control")).toHaveLength(0);
  });
});

describe("the auxiliary window's mount — the same body under its own heading", () => {
  it("draws no deck chrome, because a window does not detach from itself", async () => {
    const container = await renderWindowSurface(ADDRESSED_AGENT_ID);

    expect(container.querySelector(".meridian-pane")).toBeNull();
    expect(container.querySelector(".meridian-pane__control")).toBeNull();
    expect(container.querySelector(".meridian-agent-console__columns")).not.toBeNull();
  });

  it("names itself by the heading it shows, and says which agent it holds", async () => {
    const container = await renderWindowSurface(ADDRESSED_AGENT_ID);
    const surface = requireElement(container, ".meridian-agent-console-window");

    expect(accessibleName(surface)).toBe("Agent console");
    const subject = requireElement(surface, ".meridian-agent-console-window__subject");
    expect(subject.querySelector(".meridian-figure--wire")?.textContent).toBe(ADDRESSED_AGENT_ID);
  });

  it("says so when the address named a session and no agent", async () => {
    // Reachable: the frame's context picker resolves a bare auxiliary address by
    // choosing a session, and the agent-console grammar carries its agent with its
    // session — so a picked session arrives here with no agent named.
    const container = await renderWindowSurface(undefined);
    expect(container.textContent ?? "").toContain("not yet on one of its agents");
  });

  it("negative control: the subject line is not the same in both cases", async () => {
    // Without this, the two cases above would pass over a window that drew one fixed
    // sentence and never the id.
    const container = await renderWindowSurface(ADDRESSED_AGENT_ID);
    expect(container.textContent ?? "").not.toContain("not yet on one of its agents");
  });
});
