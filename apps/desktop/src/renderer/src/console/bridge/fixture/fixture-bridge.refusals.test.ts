// A scenario can script a call that REFUSES, and it refuses in the wire's shape.
//
// The third of the three places a fixture that matched `SidekicksBridge`'s SHAPE
// still answered something the live bridge never would: `ScenarioReply` carried a
// `result` and nothing else, so no scenario could script a call that refuses — and
// every typed daemon refusal the console renders was unreachable through the
// fixture, leaving the refusal renderings drivable only from the growth port's one
// typed absence.
//
// Two properties make the arm worth having rather than one. The refusal a caller
// catches has to BE the daemon's envelope, recognised by `src/shared/`'s own wire
// vocabulary, because a fixture-scoped wrapper would train every refusal rendering
// against a code the person is never meant to read. And a refusal a real transport
// takes time to deliver is a loading state before it is an error, so the scripted
// latency binds this arm exactly as it binds the resolving one — which is why the
// pending and abandoned cases are repeated here rather than assumed from the
// sibling file.
//
// Every case drives the REAL fixture bridge over a real scenario and the real
// engine. A hand-written stand-in for either would pass over exactly the seam
// these cases exist to hold.

import { describe, expect, it } from "vitest";

import { FixtureBridgeError } from "./fixture-refusal.js";
import {
  DELAYED_CALL,
  DELAYED_RESULT,
  SCRIPTED_LATENCY_MS,
  callThroughBridge,
  createFixture,
  drainMicrotasks,
} from "./fixture-bridge.test-support.js";
import type { ConsoleScenario } from "../scenario-runtime/scenario.js";
import { FLAGSHIP_SCENARIO } from "../scenarios/flagship.js";
import {
  readWireErrorEnvelope,
  type WireErrorEnvelope,
} from "../../../../../shared/wire-errors.js";

import { normalizeWireRejection } from "../../core/index.js";

/** The call the refusal cases script, so a scenario can carry both arms at once. */
const REFUSED_CALL = "session.read";

/**
 * The refusal a scripted rejection carries.
 *
 * A real registered code rather than an invented one: `Spec-021`'s rate-limit
 * refusals are exactly the class of typed daemon failure this arm exists to make
 * reachable, and a fixture refusing under a code no namespace owns would train a
 * surface against a value nothing sends.
 */
const SCRIPTED_REFUSAL: WireErrorEnvelope = {
  code: "ratelimit.exceeded",
  message: "Too many session reads from this participant. Retry after 30 seconds.",
};

describe("fixture bridge — a scenario can script a call that refuses", () => {
  /** The flagship script, re-scripted so one call refuses and one still answers. */
  function scenarioWithRefusal(afterMs?: number): ConsoleScenario {
    return {
      ...FLAGSHIP_SCENARIO,
      id: "flagship-refusal-probe",
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

    // `toStrictEqual` against the envelope itself, not a message match: the value a
    // surface catches has to BE the daemon's refusal. A fixture that wrapped it
    // would hand every refusal rendering a fixture-scoped code instead of the one
    // the person is meant to read.
    await expect(callThroughBridge(fixture, REFUSED_CALL)).rejects.toStrictEqual(SCRIPTED_REFUSAL);
  });

  it("refuses in the shape the console's shared normalizer already understands", async () => {
    const fixture = createFixture(scenarioWithRefusal());
    const caught: unknown = await callThroughBridge(fixture, REFUSED_CALL).catch(
      (rejection: unknown) => rejection,
    );

    // The claim is not "some object was thrown" — it is that the console's own wire
    // vocabulary recognises it, which is what every renderer catch arm runs. A second
    // refusal shape would pass a `rejects` assertion and fail here. Read rather than
    // tested: the reader answers both members in one pass, so the assertion names
    // what the fixture refused with instead of guarding and then reading it again.
    expect(readWireErrorEnvelope(caught)).toStrictEqual({
      code: SCRIPTED_REFUSAL.code,
      message: SCRIPTED_REFUSAL.message,
    });
    // Through `core/wire-rejection.ts` — the normalizer a console catch arm actually
    // calls — rather than `src/shared/`'s `Error`-returning one, which no console
    // surface runs. What matters is that the daemon's CODE survives as the refusal's
    // code, because that is the string a person pastes into an issue.
    const rendered = normalizeWireRejection("fixture-bridge", caught);
    expect(rendered.code).toBe(SCRIPTED_REFUSAL.code);
    expect(rendered.detail).toBe(SCRIPTED_REFUSAL.message);
    // The negative control: a normalizer with no envelope arm would answer its own
    // synthesized code here, which is the defect this substrate exists to close.
    expect(rendered.code).not.toBe("fixture-bridge-call-failed");
  });

  it("holds a delayed refusal pending until the caller advances past it", async () => {
    const fixture = createFixture(scenarioWithRefusal(SCRIPTED_LATENCY_MS));
    let settled = false;
    const pending = callThroughBridge(fixture, REFUSED_CALL).catch((rejection: unknown) => {
      settled = true;
      throw rejection;
    });

    await drainMicrotasks();
    // A refusal a real transport takes time to deliver is a loading state first. A
    // fixture that refused on the calling turn would make that half unreachable —
    // the same defect the resolving arm's latency exists to close.
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

    // The FIXTURE's refusal, not the scenario's: the engine was torn down before
    // the clock ever reached the scripted answer, so what the caller is owed is the
    // reason the fixture could not answer at all. Reporting the scripted refusal
    // here would claim the daemon spoke.
    await expect(pending).rejects.toBeInstanceOf(FixtureBridgeError);
    await expect(pending).rejects.toMatchObject({
      refusal: { code: "reply-abandoned", origin: "fixture-bridge" },
    });
    expect(fixture.engine.pendingReplyCount).toBe(0);
  });

  it("negative control: a resolving reply in the same scenario still resolves", async () => {
    // Without this, an implementation that rejected every scripted reply would pass
    // every case above.
    const fixture = createFixture(scenarioWithRefusal());

    await expect(callThroughBridge(fixture, DELAYED_CALL)).resolves.toStrictEqual(DELAYED_RESULT);
  });
});
