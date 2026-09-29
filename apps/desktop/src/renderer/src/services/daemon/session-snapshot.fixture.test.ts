// The base state the fixture's session read establishes, driven through the fixture's session read.
//
// Three claims, and each one is a way the arm could look right and be wrong: the read
// answers at the BOTTOM of the stream so the store admits the first beat, it files no
// entity, and it lends nothing to a session the scenario is not playing.
//
// IT CARRIES NO ENTITIES, AND THE CASE THAT SAYS SO IS LOAD-BEARING. Every partition a
// surface reads is projected from the delivered log, so a base state that filed rows of
// its own would be a second source of truth for them.

import { describe, expect, it } from "vitest";
import { ScenarioEngine } from "./engine.fixture.js";
import { fixtureSessionAnswers } from "./session-answers.fixture.js";
import { fixtureSessionSnapshot } from "./session-snapshot.fixture.js";
import { FLAGSHIP_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import type { SessionSnapshot } from "@renderer/store/session/session-store.js";

/** The base state the fixture's session read serves for the flagship's own session. */
async function servedFlagshipSnapshot(): Promise<SessionSnapshot> {
  const engine = new ScenarioEngine({ scenario: FLAGSHIP_SCENARIO });
  return await fixtureSessionAnswers(engine).sessionRead({
    sessionId: FLAGSHIP_SCENARIO.sessionId,
  });
}

describe("the fixture's base state — what a store opens with", () => {
  it("answers at the bottom of the stream, so the store admits the first beat", () => {
    // Zero rather than a position derived from the beats: a base state ahead of the
    // stream would have the store discard every beat below it, and the subscription
    // is replay-then-tail.
    expect(fixtureSessionSnapshot(FLAGSHIP_SCENARIO, FLAGSHIP_SCENARIO.sessionId).cursor).toBe(0);
  });

  it("files no entity of its own, every partition being the log's to project", async () => {
    // A base state that filed rows would stand as a second source of truth for
    // partitions a registered projector owns.
    expect((await servedFlagshipSnapshot()).entities).toStrictEqual([]);
  });

  it("lends nothing to a session this scenario is not playing", () => {
    const snapshot = fixtureSessionSnapshot(FLAGSHIP_SCENARIO, "session-somebody-else");

    expect(snapshot.entities).toStrictEqual([]);
  });
});
