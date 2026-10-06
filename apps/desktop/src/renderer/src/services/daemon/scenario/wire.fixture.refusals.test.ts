// A scenario can script a call that refuses, in the wire's shape. Without this arm, no typed
// daemon refusal the app renders is reachable through the fixture, and a fixture-scoped
// wrapper would train renderings against a code no person reads. Drives the real fixture bridge
// and engine.

import { describe, expect, it } from "vitest";

import { callThroughBridge, createFixture } from "#test/helpers/fixture/bridge.js";
import { type WireErrorEnvelope } from "#renderer/lib/wire/errors.js";
import type { Scenario } from "#fixtures/scenarios/script.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";

/** The call the refusal case scripts. */
const REFUSED_CALL = "session.read";

/** The refusal a scripted rejection carries: a real registered code, not an invented one. */
const SCRIPTED_REFUSAL: WireErrorEnvelope = {
  code: "ratelimit.exceeded",
  message: "Too many session reads from this user. Retry after 30 seconds.",
};

describe("fixture bridge — a scenario can script a call that refuses", () => {
  /** The concurrent-streaming script, re-scripted so one call refuses. */
  function scenarioWithRefusal(): Scenario {
    return {
      ...CONCURRENT_STREAMING_SCENARIO,
      id: "concurrent-streaming-refusal-probe",
      replies: [{ call: REFUSED_CALL, refusal: SCRIPTED_REFUSAL }],
    };
  }

  it("rejects with the scripted wire error, verbatim and unwrapped", async () => {
    const fixture = createFixture(scenarioWithRefusal());

    // Strict equality against the envelope: a fixture that wrapped it would hand every
    // rendering a fixture-scoped code.
    await expect(callThroughBridge(fixture, REFUSED_CALL)).rejects.toStrictEqual(SCRIPTED_REFUSAL);
  });
});
