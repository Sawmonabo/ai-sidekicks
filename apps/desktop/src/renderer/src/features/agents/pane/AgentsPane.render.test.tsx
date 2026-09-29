// The Agents pane's column, driven as the body it is.
//
// The body is mounted by the deck inside the shared pane chrome, so the cases here drive
// the COMPONENT and nothing about the frame.
//
// What the body ASKS FOR, and how long a linkage read lives, is
// `agents-pane-models.test.ts` and `../agent-reads.test.ts`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import type { AgentsPaneCalls } from "../agent-reads.js";
import { AgentsPane } from "./AgentsPane.js";
import { settleReads } from "./agents-pane.test-support.js";

/** The session the store is open on, so the roster read is asked rather than skipped. */
const SESSION_ID = "session-agents-pane-body";

/** Calls that answer with nothing to show, so the column settles without a roster. */
const EMPTY_CALLS: AgentsPaneCalls = {
  listAgents: () => Promise.resolve({ agents: [] }),
  readChildRunLinks: () => Promise.resolve({ links: [], rejectedCreates: [] }),
};

function fixtureBridge(): PlatformBridge {
  return createFixtureBridge({ scenario: unscriptedScenario("agents-pane-body") });
}

/** Mount the body over a real store and let its scheduled reads land. */
async function renderBody(agentId: string | undefined): Promise<HTMLElement> {
  const bridge = fixtureBridge();
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ cursor: 0, entities: [] });
  const { container } = render(
    <AgentsPane
      agentId={agentId}
      bridge={bridge}
      sessionStore={sessionStore}
      calls={EMPTY_CALLS}
    />,
  );
  await settleReads(bridge);
  return container;
}

describe("Agents pane — the body draws no head of its own", () => {
  it("draws no heading, no section, and no name for the surface it is inside", async () => {
    // The pane is named by the chrome's whole trail, so a name here would be a second
    // answer to what this surface is called. The column heading stays: it names a part
    // of this body rather than the body itself.
    const container = await renderBody("agent-scout");
    const body = container.querySelector(".meridian-agents");

    expect(body?.tagName).toBe("DIV");
    expect(container.querySelectorAll("h1, h2")).toHaveLength(0);
    expect(container.querySelector("[aria-label='Agent console']")).toBeNull();
  });

  it("negative control: it does still draw the heading that names its column", async () => {
    // Without this, the case above would pass over a body that had lost every heading
    // it has rather than only the one that named the whole surface.
    const container = await renderBody("agent-scout");
    const columnTitles = [...container.querySelectorAll("h3")].map((title) => title.textContent);
    expect(columnTitles).toStrictEqual(["Binding"]);
  });
});

describe("Agents pane — a mount with no session", () => {
  it("says nothing was asked when the mount resolved no session store", () => {
    const { container } = render(
      <AgentsPane agentId="agent-scout" bridge={fixtureBridge()} calls={EMPTY_CALLS} />,
    );

    expect(container.textContent ?? "").toContain("not handed a session");
  });
});
