// The projector's own behaviour, apart from the bridge that calls it.
//
// `fixture-bridge.run-streams.test.ts` drives this module through a real bridge and
// a real engine, which is the right way to prove that a subscriber receives the
// registered payload. It cannot prove two things, though, and they are the two a
// wrong projector fails at silently:
//
//   • **Which subscriptions it answers for at all.** Through the bridge, "this name
//     registers no projection" and "the projection rebuilt the envelope" look
//     identical — both deliver an envelope. Here they are two different values, and
//     `undefined` is asserted directly.
//   • **Which optional members survive.** Every optional member of the registered
//     state-change shape is optional on the wire too, so a projector that dropped
//     all of them still parses cleanly against the schema. What is lost is the
//     distinction between a turn-complete and a task-complete, and between a
//     budget-exhausted interrupt and a participant cancel.
//
// The schema is imported as a VALUE here, as it is in the sibling suite: a test file
// is not bundled, so it can hold the projector to the registered shape where the
// module deliberately imports the type only.

import { describe, expect, it } from "vitest";

import { RunStateChangeEventSchema } from "@ai-sidekicks/contracts";

import { PROBE_RUN_ID, runTransitionBeat } from "./fixture-bridge.test-support.js";
import { projectRunStreamDelivery } from "./run-stream-projection.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import { RUN_STATE_EVENT_STREAM, SESSION_EVENT_STREAM } from "./session-event-streams.js";

/** The members every well-formed transition beat below carries. */
function transitionPayload(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    sessionId: FLAGSHIP_SCENARIO.sessionId,
    runId: PROBE_RUN_ID,
    runVersion: 4,
    previousState: "starting",
    newState: "running",
    ...overrides,
  };
}

describe("run-stream projection — which subscriptions it answers for", () => {
  it("answers `undefined` for a subscription that registers no projection", () => {
    // The arm that keeps the envelope reaching the console's one real subscriber.
    // The whole-session stream carries the log and a bare event type carries only
    // itself; the corpus registers a projection for neither.
    const beat = runTransitionBeat(transitionPayload());

    expect(projectRunStreamDelivery(SESSION_EVENT_STREAM, beat.event)).toBeUndefined();
    expect(projectRunStreamDelivery("run.starting", beat.event)).toBeUndefined();
  });

  it("negative control: the narrowed run stream does answer for the same beat", () => {
    // Without it, a projector that answered `undefined` for everything would pass
    // the case above — and every narrowed subscriber would quietly go back to
    // receiving the envelope.
    const beat = runTransitionBeat(transitionPayload());

    expect(projectRunStreamDelivery(RUN_STATE_EVENT_STREAM, beat.event)?.status).toBe("projected");
  });
});

describe("run-stream projection — the optional members a beat supplies", () => {
  it("carries them through rather than flattening them", () => {
    const beat = runTransitionBeat(
      transitionPayload({ healthSignal: "stuck-suspected", internalHelper: true }),
    );
    const projection = projectRunStreamDelivery(RUN_STATE_EVENT_STREAM, beat.event);

    expect(projection?.status).toBe("projected");
    if (projection?.status !== "projected") {
      return;
    }
    const parsed = RunStateChangeEventSchema.parse(projection.delivery);
    expect(parsed.healthSignal).toBe("stuck-suspected");
    expect(parsed.internalHelper).toBe(true);
  });

  it("negative control: one the beat omits is absent, not defaulted", () => {
    // The other half. A projector that stamped every optional would satisfy the case
    // above and put a `completionKind` on a run that never completed — a member the
    // schema accepts and a surface renders.
    const beat = runTransitionBeat(transitionPayload());
    const projection = projectRunStreamDelivery(RUN_STATE_EVENT_STREAM, beat.event);

    expect(projection?.status).toBe("projected");
    if (projection?.status !== "projected") {
      return;
    }
    const parsed = RunStateChangeEventSchema.parse(projection.delivery);
    expect(parsed.healthSignal).toBeUndefined();
    expect(parsed.completionKind).toBeUndefined();
    expect("internalHelper" in parsed).toBe(false);
  });
});

describe("run-stream projection — a member it will not compose", () => {
  it("refuses a counter that is not a whole non-negative number", () => {
    // `runVersion` is the comparand every guarded request is rejected against, so a
    // fractional one admitted here would reach a caller at a type saying it cannot
    // be — and come back as an `expectedRunVersion` no row can match.
    const fractional = projectRunStreamDelivery(
      RUN_STATE_EVENT_STREAM,
      runTransitionBeat(transitionPayload({ runVersion: 1.5 })).event,
    );

    expect(fractional?.status).toBe("unprojectable");
  });

  it("refuses a state the registered vocabulary does not carry", () => {
    // `run.started` reads exactly like a real transition and names a state that does
    // not exist. Admitted, it would reach a surface as a `currentState` typed at a
    // union it is not a member of.
    const unregistered = projectRunStreamDelivery(
      RUN_STATE_EVENT_STREAM,
      runTransitionBeat(transitionPayload({ previousState: "started" })).event,
    );

    expect(unregistered?.status).toBe("unprojectable");
  });

  it("negative control: the same beat with both members well-formed projects", () => {
    // Without it, a reader that rejected every value would pass both cases above.
    const projection = projectRunStreamDelivery(
      RUN_STATE_EVENT_STREAM,
      runTransitionBeat(transitionPayload()).event,
    );

    expect(projection?.status).toBe("projected");
  });
});
