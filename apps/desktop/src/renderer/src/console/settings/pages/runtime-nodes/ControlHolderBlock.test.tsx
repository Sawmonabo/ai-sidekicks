// The shared-terminal holder, drawn from the roster read the rows beside it came from.
//
// The four arms are covered here rather than through the page, because the two that
// are hardest to reach there are the two that matter: a session whose store this
// window does not hold, and a holder the session's own hue wheel never admitted. Both
// have to render the identity anyway — a person needs to know who has the shell more
// than they need it coloured — and both are one line away from rendering nothing.
//
// THE OBSERVATION IS PUT ON THE SEAM RATHER THAN STUBBED, and it is taken from the
// mount rather than built here: `renderAbsorbedNodeRoster` hands the absorbed roster
// the exact read pair it is mounted with, so driving THAT records what a mounted
// roster records and this block reads a reply a real fixture bridge served. A stub
// would let the block pass over a seam that had changed shape.

import { render, screen } from "@testing-library/react";
import { isValidElement } from "react";
import { describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts";
import type { NodeRosterReads } from "../../../../runtime-node-attach/index.js";

import { createFixtureBridge, type ConsoleBridge } from "../../../bridge/index.js";
import { SETTINGS_SCENARIO } from "../../../bridge/scenarios/settings.js";
import { PARTICIPANT_YOU } from "../../../bridge/scenarios/settings-runtime-nodes.js";
import { unscriptedScenario } from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { ConsoleRefusalError } from "../../../core/index.js";
import { renderAbsorbedNodeRoster } from "../../../seats/index.js";
import { SessionStore } from "../../../store/index.js";
import { ControlHolderBlock } from "./ControlHolderBlock.js";

/** The tick the scenario's lease is held at, and one inside the frame before it. */
const LEASE_HELD_MS = 200;
const LEASE_FREE_MS = 90;

/** A fixture bridge whose scenario clock has been advanced to one roster frame. */
function bridgeAt(atMs: number): ConsoleBridge {
  const bridge = createFixtureBridge({ scenario: SETTINGS_SCENARIO });
  bridge.scenarioEngine?.advance(atMs);
  return bridge;
}

/**
 * Record one roster observation on the seam, exactly as a mounted roster records it.
 *
 * Awaited before the render so the block's first paint reads a settled observation:
 * this suite is about which arm is drawn for which reply, and an assertion racing the
 * read would be asserting the `unread` arm under four different names.
 */
async function readRosterThrough(bridge: ConsoleBridge, sessionId: string): Promise<void> {
  const mount = renderAbsorbedNodeRoster(bridge, sessionId);
  if (!isValidElement<{ reads: NodeRosterReads }>(mount)) {
    throw new Error(`the roster mount produced no element for ${sessionId}`);
  }
  await mount.props.reads.readRoster({ sessionId: sessionId as SessionId });
}

/** A store for this session, with the scenario's one participant on the wheel. */
function initialisedStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SETTINGS_SCENARIO.sessionId });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [PARTICIPANT_YOU] });
  return sessionStore;
}

describe("control holder block", () => {
  it("says nothing has been read before the roster answers", () => {
    const { container } = render(
      <ControlHolderBlock
        bridge={bridgeAt(LEASE_HELD_MS)}
        sessionId={SETTINGS_SCENARIO.sessionId}
        sessionStore={undefined}
      />,
    );
    // The absence, and specifically NOT the free-lease sentence: nothing has answered,
    // so "nobody holds it" would be a claim about the session this window never made.
    expect(container.textContent ?? "").not.toContain("Unheld");
    expect(screen.queryByText("Held by")).toBeNull();
  });

  it("renders the holder with the session wheel's own mark", async () => {
    const bridge = bridgeAt(LEASE_HELD_MS);
    await readRosterThrough(bridge, SETTINGS_SCENARIO.sessionId);

    const { container } = render(
      <ControlHolderBlock
        bridge={bridge}
        sessionId={SETTINGS_SCENARIO.sessionId}
        sessionStore={initialisedStore()}
      />,
    );

    expect(screen.getByText("Held by")).not.toBeNull();
    expect(container.textContent ?? "").toContain(PARTICIPANT_YOU);
    // The hue rides a mark and never text — rule 2 — so the assertion is on the mark's
    // treatment class and on the custom property carrying the token.
    const mark = container.querySelector(".meridian-control-holder__mark");
    expect(mark?.className).not.toContain("--unattributed");
    expect(
      (mark as HTMLElement | null)?.style.getPropertyValue("--meridian-control-holder-hue"),
    ).not.toBe("");
  });

  it("still names the holder when this window holds no store for the session", async () => {
    // The colour is the loss, never the identity: a blank line where a holder belongs
    // would be a worse answer than an uncoloured one.
    const bridge = bridgeAt(LEASE_HELD_MS);
    await readRosterThrough(bridge, SETTINGS_SCENARIO.sessionId);

    const { container } = render(
      <ControlHolderBlock
        bridge={bridge}
        sessionId={SETTINGS_SCENARIO.sessionId}
        sessionStore={undefined}
      />,
    );

    expect(container.textContent ?? "").toContain(PARTICIPANT_YOU);
    expect(container.querySelector(".meridian-control-holder__mark")?.className).toContain(
      "--unattributed",
    );
  });

  it("draws the neutral mark for a holder the wheel never admitted", async () => {
    // Fail-closed for an identity: borrowing whichever colour is nearest would put two
    // people on one hue in this window and not in the next.
    const bridge = bridgeAt(LEASE_HELD_MS);
    await readRosterThrough(bridge, SETTINGS_SCENARIO.sessionId);
    const emptyWheelStore = new SessionStore({ sessionId: SETTINGS_SCENARIO.sessionId });
    emptyWheelStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const { container } = render(
      <ControlHolderBlock
        bridge={bridge}
        sessionId={SETTINGS_SCENARIO.sessionId}
        sessionStore={emptyWheelStore}
      />,
    );

    expect(container.textContent ?? "").toContain(PARTICIPANT_YOU);
    expect(container.querySelector(".meridian-control-holder__mark")?.className).toContain(
      "--unattributed",
    );
  });

  it("reads a free lease as unheld, and says why it cannot be decomposed", async () => {
    const bridge = bridgeAt(LEASE_FREE_MS);
    await readRosterThrough(bridge, SETTINGS_SCENARIO.sessionId);

    const { container } = render(
      <ControlHolderBlock
        bridge={bridge}
        sessionId={SETTINGS_SCENARIO.sessionId}
        sessionStore={initialisedStore()}
      />,
    );

    expect(screen.getByText("Unheld")).not.toBeNull();
    expect(container.textContent ?? "").toContain("cannot vouch");
    expect(screen.queryByText("Held by")).toBeNull();
  });

  it("renders the seam's refusal rather than a lease it never read", async () => {
    const scenario = unscriptedScenario("control-holder-no-roster");
    const bridge = createFixtureBridge({ scenario });
    await expect(readRosterThrough(bridge, scenario.sessionId)).rejects.toBeInstanceOf(
      ConsoleRefusalError,
    );

    const { container } = render(
      <ControlHolderBlock
        bridge={bridge}
        sessionId={scenario.sessionId}
        sessionStore={undefined}
      />,
    );

    expect(container.textContent ?? "").toContain("roster-unscripted");
    expect(screen.queryByText("Unheld")).toBeNull();
  });

  it("offers no control over the lease", async () => {
    // Taking and releasing belong to the deck that owns the terminal, against the
    // daemon that owns the lease record. A button here would be a second authority.
    const bridge = bridgeAt(LEASE_HELD_MS);
    await readRosterThrough(bridge, SETTINGS_SCENARIO.sessionId);

    const { container } = render(
      <ControlHolderBlock
        bridge={bridge}
        sessionId={SETTINGS_SCENARIO.sessionId}
        sessionStore={initialisedStore()}
      />,
    );

    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
