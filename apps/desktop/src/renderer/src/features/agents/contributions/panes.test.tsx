// The deck's mount wears the console's one chrome, and the body adds no name of its own.
//
// THIS IS THE CLAIM THE SPLIT WAS MADE FOR. While one component drew its own section and
// head, the deck never wrapped it in `seats/PaneFrame`. Nothing failed: the
// chrome's own suite proves what it renders, and it was right, because the chrome was
// never reached. The gap was in the REGISTRAR, so every case below drives the registrar
// rather than the component.
//
// WHAT IS REAL HERE AND WHAT IS CAST, AND WHY THE LINE IS DRAWN THERE. The bridge is
// real: the roster reads through it on mount, so a cast one would be a column reading
// `undefined` as a function. The deck pane's session store is real for a different
// reason — its id is what the registrar reads off it and hands the chrome, so a cast or
// absent store would leave every case below passing over a registrar that passed no
// session at all. What IS cast is the frame store, the UI-state store, the draft store
// and the session-store registry, which the registrar does not read: standing them up
// would be a fixture built to satisfy a type nothing under test looks at, which is the
// line `PaneFrame.test.tsx` draws for the same reason.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { PaneRegistry } from "@renderer/console/seats/index.js";
import { registerAgentsPane } from "./panes.js";
import { settleReads } from "../pane/agents-pane.test-support.js";

const PLAYED_SESSION_ID = "session-agent-console-mounts";

/** The agent the mount is addressed at, wherever a case addresses one. */
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
  NonNullable<ReturnType<PaneRegistry["descriptorFor"]>>["render"]
>[0];

function fixtureBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: unscriptedScenario("agent-console-mounts") });
}

/**
 * The store the deck's pane is open on.
 *
 * A real store rather than an absent one, because the session id is what the registrar
 * reads OFF it and hands the chrome — a pane mounted with no store would leave the
 * trail's session crumb absent, and every case below would then pass over a registrar
 * that never passed one.
 */
function playedSessionStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: PLAYED_SESSION_ID });
  sessionStore.initialize({ cursor: 0, entities: [] });
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

/** Mount the deck's pane and let its reads settle. */
async function renderDeckPane(agentId: string | undefined): Promise<HTMLElement> {
  const registry = new PaneRegistry();
  registerAgentsPane(registry);
  // The body is loader-backed, so it is fetched before the mount rather than during it —
  // which is what a window does too, through the idle warm after its first frame. Without
  // it every case below would be waiting on a dynamic import inside a bounded wait.
  await registry.preload("agent-console");
  const descriptor = registry.descriptorFor("agent-console");
  if (descriptor === undefined) {
    throw new Error("the agent console registered no pane descriptor");
  }
  const bridge = fixtureBridge();
  const { container } = render(<>{descriptor.render(deckPaneContext(agentId, bridge))}</>);
  // The column's reads are scheduled through the refresh chokepoint, so they land only
  // once the scenario clock has passed its debounce. Without this they settle after the
  // case has ended, which is a state update outside `act`.
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
    // the one element the pane names itself by. The agent is a CRUMB of that name.
    expect(accessibleName(pane)).toContain(PLAYED_SESSION_ID);
    expect(accessibleName(pane)).toContain(ADDRESSED_AGENT_ID);
    expect(accessibleName(pane)).toContain("Agent console");
    expect(pane.querySelectorAll("h1, h2")).toHaveLength(0);
  });
});
