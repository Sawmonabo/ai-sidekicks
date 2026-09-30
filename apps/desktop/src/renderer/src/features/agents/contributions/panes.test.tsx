// The pane layout's mount wears the console's one chrome and the body adds no name of its own.
// Cases drive the registrar, since the chrome's own suite passes even if the body is never
// wrapped. The bridge and session store are real (both are read); the frame, UI-state, draft
// and session-registry stores are cast because the registrar reads none of them.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { registerAgentsPane } from "./panes.js";
import { settleReads } from "../pane/agents-pane.test-support.js";

const PLAYED_SESSION_ID = "session-agents-pane-mounts";

/** The agent the mount is addressed at, wherever a case addresses one. */
const ADDRESSED_AGENT_ID = "agent-scout";

/** What the pane layout hands a pane body's render, derived from the registry's signature. */
type RegisteredPaneContext = Parameters<
  NonNullable<ReturnType<PaneRegistry["descriptorFor"]>>["render"]
>[0];

function fixtureBridge(): FixtureBridge {
  return createFixtureBridge({ scenario: unscriptedScenario("agents-pane-mounts") });
}

/**
 * The store the pane is open on. Real, because the registrar reads the session id off it; an
 * absent store would drop the trail's session crumb and every case would pass regardless.
 */
function playedSessionStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: PLAYED_SESSION_ID });
  sessionStore.initialize({ cursor: 0, entities: [] });
  return sessionStore;
}

/** The address the pane layout opens this pane at, over one agent or bare. */
function registeredPaneContext(
  agentId: string | undefined,
  bridge: PlatformBridge,
): RegisteredPaneContext {
  return {
    kind: "agents",
    entity: agentId === undefined ? undefined : { kind: "agent", id: agentId },
    paneId: "pane-1",
    bridge,
    sessionStore: playedSessionStore(),
    linkedSourcePaneId: undefined,
  } as unknown as RegisteredPaneContext;
}

/** Mount the pane layout's pane and let its reads settle. */
async function renderRegisteredAgentsPane(agentId: string | undefined): Promise<HTMLElement> {
  const registry = new PaneRegistry();
  registerAgentsPane(registry);
  // Fetched before the mount, as a window's idle warm does, so no case waits on a dynamic
  // import.
  await registry.preload("agents");
  const descriptor = registry.descriptorFor("agents");
  if (descriptor === undefined) {
    throw new Error("the Agents pane registered no pane descriptor");
  }
  const fixture = fixtureBridge();
  const { container } = render(
    <FixtureBridgeProvider fixture={fixture}>
      {descriptor.render(registeredPaneContext(agentId, fixture.bridge))}
    </FixtureBridgeProvider>,
  );
  // Reads go through the refresh chokepoint and land once the scenario clock passes its
  // debounce; otherwise they settle after the case ends, outside `act`.
  await settleReads(fixture.scenarioEngine);
  return container;
}

/** The element a pane names itself by, resolved the way an assistive reader does. */
function accessibleName(named: HTMLElement): string {
  const labelledBy = named.getAttribute("aria-labelledby");
  if (labelledBy === null) {
    throw new Error("the pane names itself by nothing");
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

describe("the pane layout's mount — the body inside the console's one chrome", () => {
  it("wraps the body in the shared chrome rather than a frame of its own", async () => {
    const container = await renderRegisteredAgentsPane(ADDRESSED_AGENT_ID);

    const pane = requireElement(container, ".meridian-pane.meridian-pane--agents");
    // Inside the chrome's own body box: a body drawing its own section would not be there.
    expect(pane.querySelector(".meridian-pane__body > .meridian-agents")).not.toBeNull();
    expect(pane.querySelector(".meridian-agents__columns")).not.toBeNull();
  });

  it("is named by the chrome's trail, and the body adds no second name", async () => {
    const container = await renderRegisteredAgentsPane(ADDRESSED_AGENT_ID);
    const pane = requireElement(container, ".meridian-pane");

    // The address members the registrar hands the chrome, read back off the element the pane
    // names itself by.
    expect(accessibleName(pane)).toContain(PLAYED_SESSION_ID);
    expect(accessibleName(pane)).toContain(ADDRESSED_AGENT_ID);
    expect(accessibleName(pane)).toContain("Sidekicks");
    expect(pane.querySelectorAll("h1, h2")).toHaveLength(0);
  });
});
