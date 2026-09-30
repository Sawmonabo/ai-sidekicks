// A scenario can script a call that refuses, in the wire's shape. Without this arm, no typed
// daemon refusal the console renders is reachable through the fixture. The caller must catch the
// daemon's envelope itself, recognized by the shared wire vocabulary, since a fixture-scoped
// wrapper would train renderings against a code no person reads. A refusal is a loading state
// before it is an error, so scripted latency binds this arm as it binds the resolving one. Every
// case drives the real fixture bridge and engine.

import { describe, expect, it } from "vitest";

import { FixtureBridgeError } from "./refusal.fixture.js";
import {
  DELAYED_CALL,
  DELAYED_RESULT,
  SCRIPTED_LATENCY_MS,
  callThroughBridge,
  createFixture,
} from "@test/helpers/fixture-bridge.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { readWireErrorEnvelope, type WireErrorEnvelope } from "@renderer/lib/wire-errors.js";
import type { Scenario } from "../../../../../fixtures/scenario.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";

import { normalizeWireRejection } from "@renderer/lib/wire-rejection.js";

/** The call the refusal cases script, so a scenario can carry both arms at once. */
const REFUSED_CALL = "session.read";

/** The refusal a scripted rejection carries: a real registered code, not an invented one. */
const SCRIPTED_REFUSAL: WireErrorEnvelope = {
  code: "ratelimit.exceeded",
  message: "Too many session reads from this user. Retry after 30 seconds.",
};

describe("fixture bridge — a scenario can script a call that refuses", () => {
  /** The concurrent-streaming script, re-scripted so one call refuses and one still answers. */
  function scenarioWithRefusal(afterMs?: number): Scenario {
    return {
      ...CONCURRENT_STREAMING_SCENARIO,
      id: "concurrent-streaming-refusal-probe",
      replies: [
        {
          call: REFUSED_CALL,
          refusal: SCRIPTED_REFUSAL,
          ...(afterMs === undefined ? {} : { afterMs }),
        },
        { call: DELAYED_CALL, result: DELAYED_RESULT },
      ],
    };
  }

  it("rejects with the scripted wire error, verbatim and unwrapped", async () => {
    const fixture = createFixture(scenarioWithRefusal());

    // Strict equality against the envelope: a fixture that wrapped it would hand every
    // rendering a fixture-scoped code.
    await expect(callThroughBridge(fixture, REFUSED_CALL)).rejects.toStrictEqual(SCRIPTED_REFUSAL);
  });

  it("refuses in the shape the console's shared normalizer already understands", async () => {
    const fixture = createFixture(scenarioWithRefusal());
    const caught: unknown = await callThroughBridge(fixture, REFUSED_CALL).catch(
      (rejection: unknown) => rejection,
    );

    // The console's wire vocabulary must recognize it, as every renderer catch arm does; a
    // second refusal shape would pass a `rejects` assertion and fail here.
    expect(readWireErrorEnvelope(caught)).toStrictEqual({
      code: SCRIPTED_REFUSAL.code,
      message: SCRIPTED_REFUSAL.message,
    });
    // Through `lib/wire-rejection.ts`, the normalizer a console catch arm calls. The daemon's
    // code must survive as the refusal's code, since a person pastes it into an issue.
    const rendered = normalizeWireRejection("fixture-bridge", caught);
    expect(rendered.code).toBe(SCRIPTED_REFUSAL.code);
    expect(rendered.detail).toBe(SCRIPTED_REFUSAL.message);
    // Negative control: a normalizer with no envelope arm would answer its own synthesized code.
    expect(rendered.code).not.toBe("fixture-bridge-call-failed");
  });

  it("holds a delayed refusal pending until the caller advances past it", async () => {
    const fixture = createFixture(scenarioWithRefusal(SCRIPTED_LATENCY_MS));
    let settled = false;
    const pending = callThroughBridge(fixture, REFUSED_CALL).catch((rejection: unknown) => {
      settled = true;
      throw rejection;
    });

    await crossMacrotaskBoundary();
    // A refusal a real transport takes time to deliver is a loading state first.
    expect(settled).toBe(false);
    expect(fixture.engine.pendingReplyCount).toBe(1);

    fixture.engine.advance(SCRIPTED_LATENCY_MS);

    await expect(pending).rejects.toStrictEqual(SCRIPTED_REFUSAL);
    expect(fixture.engine.pendingReplyCount).toBe(0);
  });

  it("settles a pending refusal as abandoned when the engine is torn down", async () => {
    const fixture = createFixture(scenarioWithRefusal(SCRIPTED_LATENCY_MS));
    const pending = callThroughBridge(fixture, REFUSED_CALL);

    fixture.engine.dispose();

    // The fixture's refusal, not the scenario's: the engine was torn down before the clock
    // reached the scripted answer, and reporting that refusal would claim the daemon spoke.
    await expect(pending).rejects.toBeInstanceOf(FixtureBridgeError);
    await expect(pending).rejects.toMatchObject({
      refusal: { code: "reply-abandoned", origin: "fixture-bridge" },
    });
    expect(fixture.engine.pendingReplyCount).toBe(0);
  });

  it("negative control: a resolving reply in the same scenario still resolves", async () => {
    // Without it, a fixture that rejected every scripted reply passes every case above.
    const fixture = createFixture(scenarioWithRefusal());

    await expect(callThroughBridge(fixture, DELAYED_CALL)).resolves.toStrictEqual(DELAYED_RESULT);
  });
});
