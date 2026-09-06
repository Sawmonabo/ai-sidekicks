// The agent console's columns, driven as the body they are.
//
// One body mounted twice — by the deck inside the shared pane chrome and by the frame
// inside the auxiliary window's own frame — so the cases here drive the COMPONENT and
// nothing about either frame. Which frame each mount wears, and what each of them names
// this surface, is `agent-console-mounts.test.tsx`; the subject sentence that used to be
// asserted here moved with it, because the body no longer draws one.
//
// What is checked here is what a mount cannot rule out from outside: a machines column
// whose bridge may be absent, and a definition editor whose body belongs to another plan.
//
// Every case mounts against a REAL fixture bridge rather than a cast literal. The
// machines column hands the absorbed roster the reads that bridge serves, so a cast
// bridge would be a column reading `undefined` as a function — and the column's own
// case below is exactly the one that would not notice.
//
// What the body ASKS FOR is two other files: the grant re-read and the run its
// linkage is keyed by are `AgentConsoleBody.reads.test.tsx`, and how long a linkage
// read lives is `AgentConsoleBody.linkage-lifetime.test.tsx`.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { SETTINGS_SCENARIO } from "../../bridge/scenarios/settings.js";
import { AgentConsoleBody } from "./AgentConsoleBody.js";

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
 * Mount the body and let its machines column settle.
 *
 * The roster reads on mount, so a case that asserted before it settled would leave
 * a state update landing outside `act` — a warning rather than the failure it
 * usually is, and one that would make every case here quietly unreliable.
 */
async function renderBody(agentId: string | undefined): Promise<HTMLElement> {
  const { container } = render(
    <AgentConsoleBody sessionId={PLAYED_SESSION_ID} agentId={agentId} bridge={fixtureBridge()} />,
  );
  await screen.findByLabelText("node-roster-loaded");
  return container;
}

describe("agent console — the body draws no head of its own", () => {
  it("draws no heading, no section, and no name for the surface it is inside", async () => {
    // The pane is named by the chrome's whole trail and the window by its own heading,
    // so a third name here would be a second answer to what this surface is called —
    // which is exactly the drift six families each drawing a head produced. The column
    // headings stay: they name parts of this body rather than the body itself.
    const container = await renderBody("agent-scout");
    const body = container.querySelector(".meridian-agent-console");

    expect(body?.tagName).toBe("DIV");
    expect(container.querySelectorAll("h1, h2")).toHaveLength(0);
    expect(container.querySelector("[aria-label='Agent console']")).toBeNull();
    expect(container.textContent ?? "").not.toContain("not yet on one of its agents");
  });

  it("negative control: it does still draw the headings that name its columns", async () => {
    // Without this, the case above would pass over a body that had lost every heading
    // it has rather than only the one that named the whole surface.
    const container = await renderBody("agent-scout");
    const columnTitles = [...container.querySelectorAll("h3")].map((title) => title.textContent);
    expect(columnTitles).toStrictEqual(["Binding", "Machines", "Definition", "Peers and linkage"]);
  });
});

describe("agent console — the machines column", () => {
  it("renders the roster the body's own bridge serves", async () => {
    // Under the fixture this column used to say the question was not put. It asks
    // now, through the bridge this mount already holds, and both health axes render
    // side by side because the absorbed view was kept rather than rewritten.
    await renderBody("agent-scout");

    const roster = screen.getByLabelText("node-roster-loaded");
    expect(roster.querySelectorAll("li")).toHaveLength(2);
    expect(
      roster.querySelector('li[data-node-state="online"][data-health-state="degraded"]'),
    ).not.toBeNull();
  });

  it("says nothing was asked when the mount resolved no bridge", async () => {
    // The negative control for the case above, and a reachable state: this body
    // types its bridge as possibly absent because a mount may resolve none.
    const { container } = render(
      <AgentConsoleBody sessionId={PLAYED_SESSION_ID} agentId="agent-scout" bridge={undefined} />,
    );

    expect(screen.queryByLabelText("node-roster-loaded")).toBeNull();
    expect(container.textContent ?? "").toContain("not handed a bridge");
  });
});

describe("agent console — the definition editor's seat", () => {
  it("states the absence rather than drawing an empty region", async () => {
    const container = await renderBody("agent-scout");
    expect(container.textContent ?? "").toContain("definition editor has not been built here yet");
  });

  it("names no governance work anywhere a person can read", async () => {
    // The slot's contract is developer-facing and reaches no screen. The rule is
    // repository-wide: governance identifiers live in comments, never in a string
    // a participant reads.
    const container = await renderBody("agent-scout");
    expect(container.textContent ?? "").not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP)-\d/u);
  });

  it("negative control: the body does render text that could have carried one", async () => {
    // Without this, the case above would pass over a body that rendered nothing at
    // all, which is the failure it is meant to exclude.
    const container = await renderBody("agent-scout");
    expect((container.textContent ?? "").length).toBeGreaterThan(80);
  });
});
