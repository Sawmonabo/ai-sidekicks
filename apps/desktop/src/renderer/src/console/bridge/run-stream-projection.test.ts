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
// The projector now parses through the registered schema itself, so the suite's job
// changes with it: not "does the output happen to satisfy the shape" — it must, or
// it was never delivered — but WHICH beats reach that gate and which are refused at
// it, and with what named in the refusal.

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

describe("run-stream projection — an optional the registered shape rejects", () => {
  // Every one of these is a value the wire member's own schema refuses:
  // `intendedClose` is `z.literal(true)`, `healthSignal` is
  // `z.literal("stuck-suspected")`, and `executionPosture` is a two-arm union whose
  // `trusted` arm requires `networkAccess` and `writableRoots`. Before the parse
  // they were copied through wire-verbatim and a cast presented the result as a
  // valid `RunStateChangeEvent`, so a fixture subscriber received values the live
  // bridge cannot send — the one thing a fixture must never do.
  it.each([
    ["intendedClose", { intendedClose: false }],
    ["healthSignal", { healthSignal: "healthy" }],
    ["executionPosture", { executionPosture: { mode: "trusted" } }],
  ])("refuses a malformed `%s` and names the member in the refusal", (member, overrides) => {
    const projection = projectRunStreamDelivery(
      RUN_STATE_EVENT_STREAM,
      runTransitionBeat(transitionPayload(overrides)).event,
    );

    expect(projection?.status).toBe("unprojectable");
    if (projection?.status !== "unprojectable") {
      return;
    }
    // The member's own path, so a scenario author reads WHICH member is wrong.
    expect(projection.detail).toContain(member);
  });

  it("negative control: the same optionals at values the shape admits are delivered", () => {
    // Without it, a projector that refused every optional would pass all three cases
    // above — and every scenario that scripts a `completionKind` or a `trigger` would
    // silently lose it.
    const projection = projectRunStreamDelivery(
      RUN_STATE_EVENT_STREAM,
      runTransitionBeat(
        transitionPayload({
          intendedClose: true,
          healthSignal: "stuck-suspected",
          executionPosture: { networkAccess: "none", writableRoots: [], mode: "trusted" },
        }),
      ).event,
    );

    expect(projection?.status).toBe("projected");
    if (projection?.status !== "projected") {
      return;
    }
    expect(RunStateChangeEventSchema.parse(projection.delivery)).toStrictEqual(projection.delivery);
  });

  it("delivers exactly the registered members, and no envelope member with them", () => {
    // The whole delivered value, asserted rather than sampled: the parse is what
    // stands between a subscriber and a shape the daemon does not send, so what it
    // lets through is the claim worth pinning.
    const beat = runTransitionBeat(transitionPayload());
    const projection = projectRunStreamDelivery(RUN_STATE_EVENT_STREAM, beat.event);

    expect(projection?.status).toBe("projected");
    if (projection?.status !== "projected") {
      return;
    }
    expect(projection.delivery).toStrictEqual({
      runId: PROBE_RUN_ID,
      runVersion: 4,
      previousState: "starting",
      currentState: "running",
      timestamp: beat.event.occurredAt,
    });
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
