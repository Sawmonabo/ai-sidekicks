// The runtime-node roster read, and the push that says when to re-read it.
//
// A sibling of `fixture-bridge.test.ts` rather than a block inside it: that file
// owns the two arms that deliver a beat's own envelope, and this one holds a seam
// with a different shape — a READ whose answer is a function of the frozen clock,
// beside a subscription that carries no payload at all and only says "ask again".
//
// The discipline the cases below hold the fixture to is the one the registered wire
// has: `runtimenode.roster` is the truth for the rendered set and a `runtime_node.*`
// beat only says WHEN to re-read. So a fixture whose roster could not move would
// answer every re-read with the same rows and make that discipline untestable, and a
// fixture that answered a scenario naming no roster with an empty set would render
// "no machine is attached" for a question nobody asked.
//
// Every case drives the REAL fixture bridge over a real scenario and the real
// engine, through the same `createFixture` its siblings use.

import { describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts";

import { createFixture } from "./fixture-bridge.test-support.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import { SETTINGS_SCENARIO } from "./scenarios/settings.js";

describe("fixture bridge — the runtime-node roster and the signal that refreshes it", () => {
  /** Past the settings script's last node beat, which is the degrade at 320 ms. */
  const PAST_THE_DEGRADE_MS = 340;

  it("serves the roster from the scenario, not from a scripted reply", async () => {
    // The settings scenario scripts exactly one reply (`agent.list`) and carries
    // the roster as data, so a fixture that routed this read through the reply
    // table would refuse it as unscripted. The read is answered because the
    // scenario NAMES a roster — which is the seam this case exists to hold.
    const fixture = createFixture(SETTINGS_SCENARIO);
    fixture.engine.advance(200);

    const outcome = await fixture.bridge.runtimeNodeRosterRead({
      sessionId: SETTINGS_SCENARIO.sessionId as SessionId,
    });

    expect(outcome.status).toBe("served");
    expect(
      outcome.status === "served" ? outcome.value.nodes.map((node) => node.nodeId) : [],
    ).toStrictEqual(["node-workstation", "node-builder"]);
  });

  it("signals the subscriber when a registered transition beat falls due", () => {
    const fixture = createFixture(SETTINGS_SCENARIO);
    let signals = 0;
    const subscription = fixture.bridge.runtimeNodePresenceSubscribe(
      SETTINGS_SCENARIO.sessionId as SessionId,
      () => {
        signals += 1;
      },
    );

    expect(subscription.status).toBe("subscribed");
    fixture.engine.advance(PAST_THE_DEGRADE_MS);

    // Two registrations, two arrivals, one degrade — the five state-transition
    // beats this script plays. The two `capability_declared` beats are NOT among
    // them, which is what makes the count an assertion rather than a tally.
    expect(signals).toBe(5);
  });

  it("negative control: the same subscription is silent before its beats fall due", () => {
    // Without this, a fixture that signalled on every advance — or on none, with
    // the count above coming from somewhere else — would pass the case above.
    const fixture = createFixture(SETTINGS_SCENARIO);
    let signals = 0;
    fixture.bridge.runtimeNodePresenceSubscribe(SETTINGS_SCENARIO.sessionId as SessionId, () => {
      signals += 1;
    });

    // The session's own creation beat is at tick zero and is not a node transition.
    fixture.engine.advance(0);

    expect(signals).toBe(0);
  });

  it("answers the re-read a signal asks for with a changed roster", async () => {
    // The whole discipline in one case: the read is the truth, the push says WHEN
    // to re-read, and re-reading after the beat returns different rows. A fixture
    // whose roster could not move would satisfy every other case in this block.
    const fixture = createFixture(SETTINGS_SCENARIO);
    const sessionId = SETTINGS_SCENARIO.sessionId as SessionId;
    fixture.engine.advance(200);
    const before = await fixture.bridge.runtimeNodeRosterRead({ sessionId });

    fixture.engine.advance(PAST_THE_DEGRADE_MS - 200);
    const after = await fixture.bridge.runtimeNodeRosterRead({ sessionId });

    expect(before).not.toStrictEqual(after);
  });

  it("refuses the read for a scenario that names no roster", async () => {
    // The honest absence. The flagship script is about agents and says nothing
    // about machines, so the read renders "not checked" rather than an empty table
    // that would claim this session has no runtime nodes.
    const fixture = createFixture();

    const outcome = await fixture.bridge.runtimeNodeRosterRead({
      sessionId: FLAGSHIP_SCENARIO.sessionId as SessionId,
    });

    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" ? outcome.origin : "").toBe("runtime-node-roster");
  });
});
