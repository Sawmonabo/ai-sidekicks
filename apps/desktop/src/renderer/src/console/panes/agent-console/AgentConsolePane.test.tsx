// The agent console says which agent it is about, or says it does not know.
//
// One body mounted twice — by the deck as a pane and by the frame as an auxiliary
// window — so the cases drive the COMPONENT rather than either mount, and the two
// registrars are covered where they are composed. What is checked here is the pair
// of absences a mount cannot rule out: an address that named a session and no
// agent, and a definition editor whose body belongs to another plan.
//
// Every case mounts against a REAL fixture bridge rather than a cast literal. The
// machines column hands the absorbed roster the reads that bridge serves, so a cast
// bridge would be a column reading `undefined` as a function — and the column's own
// case below is exactly the one that would not notice.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentConsolePane } from "./AgentConsolePane.js";
import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { SETTINGS_SCENARIO } from "../../bridge/scenarios/settings.js";

/** The tick this scenario's two machines are both attached at. */
const BOTH_MACHINES_ONLINE_MS = 200;

/** The session the fixture plays, so the roster read is answered rather than refused. */
const PLAYED_SESSION_ID = SETTINGS_SCENARIO.sessionId;

function fixtureBridge(): ConsoleBridge {
  const bridge = createFixtureBridge({ scenario: SETTINGS_SCENARIO });
  bridge.scenarioEngine?.advance(BOTH_MACHINES_ONLINE_MS);
  return bridge;
}

/**
 * Mount the pane and let its machines column settle.
 *
 * The roster reads on mount, so a case that asserted before it settled would leave
 * a state update landing outside `act` — a warning rather than the failure it
 * usually is, and one that would make every case here quietly unreliable.
 */
async function renderPane(agentId: string | undefined): Promise<HTMLElement> {
  const { container } = render(
    <AgentConsolePane sessionId={PLAYED_SESSION_ID} agentId={agentId} bridge={fixtureBridge()} />,
  );
  await screen.findByLabelText("node-roster-loaded");
  return container;
}

describe("agent console — the agent it is about", () => {
  it("renders the agent id as a wire figure, verbatim", async () => {
    // A wire string wears the provenance signature. Rendered as prose it would be
    // indistinguishable from a name the console composed.
    const container = await renderPane("agent-scout");
    const figure = container.querySelector(".meridian-figure--wire");
    expect(figure?.textContent).toBe("agent-scout");
  });

  it("says so when the address named a session and no agent", async () => {
    // Reachable: the frame's context picker resolves a bare auxiliary address by
    // choosing a session, and the agent-console grammar carries its agent with its
    // session — so a picked session arrives here with no agent named.
    const container = await renderPane(undefined);
    expect(container.textContent ?? "").toContain("not yet on one of its agents");
  });

  it("negative control: the subject line is not the same in both cases", async () => {
    // Without this, the two cases above would pass over a pane that rendered one
    // fixed sentence and never the id.
    const container = await renderPane("agent-scout");
    expect(container.textContent ?? "").not.toContain("not yet on one of its agents");
  });
});

describe("agent console — the machines column", () => {
  it("renders the roster the pane's own bridge serves", async () => {
    // Under the fixture this column used to say the question was not put. It asks
    // now, through the bridge this mount already holds, and both health axes render
    // side by side because the absorbed view was kept rather than rewritten.
    await renderPane("agent-scout");

    const roster = screen.getByLabelText("node-roster-loaded");
    expect(roster.querySelectorAll("li")).toHaveLength(2);
    expect(
      roster.querySelector('li[data-node-state="online"][data-health-state="degraded"]'),
    ).not.toBeNull();
  });

  it("says nothing was asked when the mount resolved no bridge", async () => {
    // The negative control for the case above, and a reachable state: this pane
    // types its bridge as possibly absent because a mount may resolve none.
    const { container } = render(
      <AgentConsolePane sessionId={PLAYED_SESSION_ID} agentId="agent-scout" bridge={undefined} />,
    );

    expect(screen.queryByLabelText("node-roster-loaded")).toBeNull();
    expect(container.textContent ?? "").toContain("not handed a bridge");
  });
});

describe("agent console — the definition editor's seat", () => {
  it("states the absence rather than drawing an empty region", async () => {
    const container = await renderPane("agent-scout");
    expect(container.textContent ?? "").toContain("definition editor has not been built here yet");
  });

  it("names no governance work anywhere a person can read", async () => {
    // The slot's contract is developer-facing and reaches no screen. The rule is
    // repository-wide: governance identifiers live in comments, never in a string
    // a participant reads.
    const container = await renderPane("agent-scout");
    expect(container.textContent ?? "").not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP)-\d/u);
  });

  it("negative control: the pane does render text that could have carried one", async () => {
    // Without this, the case above would pass over a pane that rendered nothing at
    // all, which is the failure it is meant to exclude.
    const container = await renderPane("agent-scout");
    expect((container.textContent ?? "").length).toBeGreaterThan(80);
  });
});
