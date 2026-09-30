// The fixture's base state, driven through the fixture's session read: it answers at the bottom of
// the stream so the store admits the first beat, files no entity, and lends nothing to a session
// the scenario is not playing. The empty entity list is load-bearing: every partition is projected
// from the delivered log, so a base state with rows would be a second source of truth.

import { describe, expect, it } from "vitest";
import { ScenarioEngine } from "./engine.fixture.js";
import { fixtureSessionAnswers } from "./session-answers.fixture.js";
import { fixtureSessionSnapshot } from "./session-snapshot.fixture.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import type { SessionSnapshot } from "@renderer/store/session/session-store.js";

/** The base state the fixture serves for the concurrent-streaming scenario's own session. */
async function servedConcurrentStreamingSnapshot(): Promise<SessionSnapshot> {
  const engine = new ScenarioEngine({ scenario: CONCURRENT_STREAMING_SCENARIO });
  return await fixtureSessionAnswers(engine).sessionRead({
    sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
  });
}

describe("the fixture's base state — what a store opens with", () => {
  it("answers at the bottom of the stream, so the store admits the first beat", () => {
    // Zero, not a position derived from the beats: a base state ahead of the stream would make the
    // store discard every beat below it.
    expect(
      fixtureSessionSnapshot(CONCURRENT_STREAMING_SCENARIO, CONCURRENT_STREAMING_SCENARIO.sessionId)
        .cursor,
    ).toBe(0);
  });

  it("files no entity of its own, every partition being the log's to project", async () => {
    // A base state with rows would be a second source of truth for the projected partitions.
    expect((await servedConcurrentStreamingSnapshot()).entities).toStrictEqual([]);
  });

  it("lends nothing to a session this scenario is not playing", () => {
    const snapshot = fixtureSessionSnapshot(CONCURRENT_STREAMING_SCENARIO, "session-somebody-else");

    expect(snapshot.entities).toStrictEqual([]);
  });
});
