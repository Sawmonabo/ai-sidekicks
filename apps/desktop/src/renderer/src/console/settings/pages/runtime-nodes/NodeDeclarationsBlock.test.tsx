// What each machine declares, drawn from the read the roster beside it already made.
//
// Every case renders the WHOLE page rather than the block alone, because the claim
// this block exists to make is about the two surfaces together: the declarations and
// the rows are one answer, they arrive on one call, and the block never says "no
// machine is attached" while the roster is still reading.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RuntimeNodeRosterRequest } from "@ai-sidekicks/contracts";

import { RuntimeNodesPage } from "./RuntimeNodesPage.js";
import type { SettingsPageContext } from "../../settings-page-registry.js";
import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { unscriptedScenario } from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { SETTINGS_SCENARIO } from "../../../bridge/scenarios/settings.js";
import { consoleTestUiStateStore } from "../../settings-page-mount.test-support.js";
import { settle } from "../../../core/settle.test-support.js";

/** The tick this scenario's roster names two machines at, one of them below floor. */
const BOTH_MACHINES_ONLINE_MS = 200;

/** The tick the scenario's roster is answered and empty. */
const NO_MACHINE_ATTACHED_YET_MS = 0;

function contextFor(
  bridge: ConsoleBridge,
  retainedSessionId: string | undefined,
): SettingsPageContext {
  return {
    bridge,
    openSection: () => undefined,
    retainedSessionId,
    retainedSessionStore: undefined,
    uiStateStore: consoleTestUiStateStore(),
  };
}

/** The real fixture bridge, advanced to a tick whose roster this case is about. */
function bridgeAt(tickMs: number): ConsoleBridge {
  const bridge = createFixtureBridge({ scenario: SETTINGS_SCENARIO });
  if (tickMs > 0) {
    bridge.scenarioEngine?.advance(tickMs);
  }
  return bridge;
}

/** The same bridge with every roster read counted, and nothing else changed. */
function countingRosterReads(bridge: ConsoleBridge): {
  readonly bridge: ConsoleBridge;
  readonly readCount: () => number;
} {
  let readCount = 0;
  const readRoster = bridge.runtimeNodeRosterRead;
  return {
    readCount: () => readCount,
    bridge: {
      ...bridge,
      runtimeNodeRosterRead: async (request: RuntimeNodeRosterRequest) => {
        readCount += 1;
        return readRoster(request);
      },
    },
  };
}

describe("what each node declares", () => {
  it("renders one declaration per attached machine", async () => {
    render(
      <RuntimeNodesPage
        context={contextFor(bridgeAt(BOTH_MACHINES_ONLINE_MS), SETTINGS_SCENARIO.sessionId)}
      />,
    );

    const declarations = await screen.findAllByLabelText("capability-declaration");
    expect(declarations).toHaveLength(2);
    expect(declarations[0]?.textContent).toContain("provider-driver");
  });

  it("costs no second roster read — the declarations ride the roster's own", async () => {
    // The whole reason this block reads an OBSERVATION rather than the wire: two reads
    // can answer differently, and a person looking at a roster and a declaration list
    // built from different answers cannot tell which one is current.
    const counted = countingRosterReads(bridgeAt(BOTH_MACHINES_ONLINE_MS));
    render(<RuntimeNodesPage context={contextFor(counted.bridge, SETTINGS_SCENARIO.sessionId)} />);

    await screen.findAllByLabelText("capability-declaration");
    expect(counted.readCount()).toBe(1);
  });

  it("negative control: nothing is declared before the roster has answered", async () => {
    // Rendered synchronously, before the read settles. A block that drew its empty or
    // its populated arm here would be reporting a reading nobody has taken.
    render(
      <RuntimeNodesPage
        context={contextFor(bridgeAt(BOTH_MACHINES_ONLINE_MS), SETTINGS_SCENARIO.sessionId)}
      />,
    );

    expect(screen.queryByLabelText("capability-declaration")).toBeNull();
    expect(screen.queryByText(/No machine is attached/)).toBeNull();
    // The assertions above are the case and they are taken first; this is what happens
    // AFTER them. The read this mount put on the wire settles whether or not the case
    // waits for it, and a case that ends first leaves that arrival to land on an
    // unmounting tree outside React's scope — reported as an `act` warning on stderr,
    // charged to whichever file vitest was running at the time. Awaiting the boundary
    // brings the arrival inside the case that caused it and changes no claim it makes.
    await settle();
  });
});

describe("a session with no machine on it", () => {
  it("says so, in words about the session rather than about the read", async () => {
    render(
      <RuntimeNodesPage
        context={contextFor(bridgeAt(NO_MACHINE_ATTACHED_YET_MS), SETTINGS_SCENARIO.sessionId)}
      />,
    );

    expect(await screen.findByText(/No machine is attached to this session/)).toBeTruthy();
  });

  it("negative control: a read that refused says something else entirely", async () => {
    // "Nobody has attached a machine" and "the console could not find out" are
    // different facts, and a block that drew the empty state for both would be
    // reporting an answer the control plane never gave.
    const scenario = unscriptedScenario("declarations-no-roster");
    render(
      <RuntimeNodesPage
        context={contextFor(createFixtureBridge({ scenario }), scenario.sessionId)}
      />,
    );

    const block = await screen.findByLabelText("What each node declares");
    await settle();
    expect(block.textContent).toContain("roster-unscripted");
    expect(block.textContent).not.toContain("No machine is attached");
  });
});

describe("a machine below the version floor", () => {
  it("renders the declared version and the verdict beside its declaration", async () => {
    render(
      <RuntimeNodesPage
        context={contextFor(bridgeAt(BOTH_MACHINES_ONLINE_MS), SETTINGS_SCENARIO.sessionId)}
      />,
    );

    const verdicts = await screen.findAllByLabelText("mixed-version-status");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.getAttribute("data-read-only")).toBe("true");
    expect(verdicts[0]?.textContent).toContain("declared client version");
  });

  it("negative control: the machine at the floor gets no verdict block at all", async () => {
    // Both machines are on the roster at this tick and exactly one is below the floor,
    // so a block rendered unconditionally would put "no refused write attempt to
    // surface" under every row and bury the one reading that matters.
    render(
      <RuntimeNodesPage
        context={contextFor(bridgeAt(BOTH_MACHINES_ONLINE_MS), SETTINGS_SCENARIO.sessionId)}
      />,
    );

    const roster = await screen.findByLabelText("node-roster-loaded");
    expect(roster.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getAllByLabelText("mixed-version-status")).toHaveLength(1);
  });
});
