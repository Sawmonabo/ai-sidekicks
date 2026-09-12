// The base state the fixture's session read establishes, driven over the shipped port.
//
// Three claims, and each one is a way the arm could look right and be wrong: the read
// answers at the BOTTOM of the stream so the store admits the first beat, it carries
// the whole join log at that position so hue allocation is settled before a row draws,
// and it lends neither of those to a session the scenario is not playing.
//
// IT CARRIES NO ENTITIES, AND THE CASE THAT SAYS SO IS LOAD-BEARING. Every partition a
// surface reads is projected from the delivered log, so a base state that filed rows of
// its own would be a second source of truth for them.

import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../call-plane/bridge.js";
import { fixtureSessionSnapshot } from "./session-snapshot.js";
import { FLAGSHIP_SCENARIO } from "../../scenario/flagship/flagship.js";
import type { SessionSnapshot } from "../../../store/session/session-store.js";

/** The base state the shipped fixture port serves for the flagship's own session. */
async function servedFlagshipSnapshot(): Promise<SessionSnapshot> {
  const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
  const outcome = await bridge.growth.sessionRead({ sessionId: FLAGSHIP_SCENARIO.sessionId });
  if (outcome.status !== "served") {
    throw new Error(`the fixture refused the session read: ${outcome.code}`);
  }
  return outcome.value;
}

describe("the fixture's base state — what a store opens with", () => {
  it("answers at the bottom of the stream, so the store admits the first beat", () => {
    // Zero rather than a position derived from the beats: a base state ahead of the
    // stream would have the store discard every beat below it, and the subscription
    // is replay-then-tail.
    expect(fixtureSessionSnapshot(FLAGSHIP_SCENARIO, FLAGSHIP_SCENARIO.sessionId).cursor).toBe(0);
  });

  it("establishes the whole join order at that position, agents included", async () => {
    // The one fact no beat can supply. Hue allocation keys on join order, so a wheel
    // filled one entry at a time would recolour the session as it loaded — and this
    // scenario's agents are most of the order, which is why they are in it.
    const served = await servedFlagshipSnapshot();

    expect(served.userJoinLog).toStrictEqual(FLAGSHIP_SCENARIO.userIdsInJoinOrder);
    expect(served.userJoinLog.length).toBeGreaterThan(0);
  });

  it("files no entity of its own, every partition being the log's to project", async () => {
    // The negative control for the case above: a base state that filed rows would
    // satisfy the join-log assertion while standing as a second source of truth for
    // partitions a registered projector owns.
    expect((await servedFlagshipSnapshot()).entities).toStrictEqual([]);
  });

  it("lends nothing to a session this scenario is not playing", () => {
    const snapshot = fixtureSessionSnapshot(FLAGSHIP_SCENARIO, "session-somebody-else");

    expect(snapshot.entities).toStrictEqual([]);
    expect(snapshot.userJoinLog).toStrictEqual([]);
  });
});
