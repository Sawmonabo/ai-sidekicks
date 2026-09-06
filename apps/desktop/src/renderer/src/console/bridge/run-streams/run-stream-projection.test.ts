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

import { RunStateChangeEventSchema, RunRolledBackEventSchema } from "@ai-sidekicks/contracts";

import type { ConsoleSessionEvent } from "../../store/index.js";
import { PROBE_RUN_ID, runTransitionBeat } from "../fixture/fixture-bridge.test-support.js";
import { projectRunStreamDelivery } from "./run-stream-projection.js";
import { FLAGSHIP_SCENARIO } from "../scenarios/flagship.js";
import {
  RUN_QUEUE_EVENT_STREAM,
  RUN_STATE_EVENT_STREAM,
  SESSION_EVENT_STREAM,
} from "../daemon/session-event-streams.js";

/** A session the branded schema accepts that is not the one the beats are delivered on. */
const OTHER_SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a7777";

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

/**
 * One `run.rolled_back` beat, in the registered per-type payload shape.
 *
 * Built off the shared transition beat and then re-kinded, so the envelope members are
 * the ones the fixture's own beats carry and the cases below are about the payload.
 */
function rollbackBeatEvent(overrides: Readonly<Record<string, unknown>> = {}): ConsoleSessionEvent {
  const beat = runTransitionBeat({
    sessionId: FLAGSHIP_SCENARIO.sessionId,
    runId: PROBE_RUN_ID,
    runVersion: 5,
    targetPosition: 2,
    ...overrides,
  });
  return { ...beat.event, kind: "run.rolled_back" };
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

describe("run-stream projection — the rollback arm's session, which the payload owns", () => {
  it("refuses a rollback beat that names no session in its payload", () => {
    // The registered per-type payload is `{sessionId, runId, runVersion, channelId?,
    // targetPosition}` and no strict-layer variant is registered for the kind, so
    // nothing the contracts package ships rejects an omission. This module used to
    // stamp the envelope's session onto the candidate before parsing, which turned a
    // beat missing the member into a valid-looking rollback.
    const projection = projectRunStreamDelivery(
      RUN_STATE_EVENT_STREAM,
      rollbackBeatEvent({ sessionId: undefined }),
    );

    expect(projection?.status).toBe("unprojectable");
    if (projection?.status !== "unprojectable") {
      return;
    }
    expect(projection.detail).toContain("sessionId");
  });

  it("refuses a rollback beat whose payload names a different session, naming both", () => {
    // The louder half of the same defect. The durable row is what the timeline's
    // boundary entry refines against the envelope, so the two cannot disagree — and
    // before the check the disagreement was resolved silently, in the envelope's
    // favour, by overwriting the evidence.
    const projection = projectRunStreamDelivery(
      RUN_STATE_EVENT_STREAM,
      rollbackBeatEvent({ sessionId: OTHER_SESSION_ID }),
    );

    expect(projection?.status).toBe("unprojectable");
    if (projection?.status !== "unprojectable") {
      return;
    }
    // Both values, so a scenario author reads which two sessions were in hand rather
    // than that something about a session was wrong.
    expect(projection.detail).toContain(FLAGSHIP_SCENARIO.sessionId);
    expect(projection.detail).toContain(OTHER_SESSION_ID);
  });

  it("negative control: an agreeing beat is delivered, carrying the payload's own member", () => {
    // Without this the two cases above would hold over an arm that refused every
    // rollback. The delivered value is asserted whole: the session it carries is the
    // one the PAYLOAD named, which is the same value the envelope named — and a
    // projection that went back to copying the envelope's would pass this case while
    // making the equality check unreachable, which is why the mismatch case above is
    // the one that pins the source.
    const projection = projectRunStreamDelivery(RUN_STATE_EVENT_STREAM, rollbackBeatEvent());

    expect(projection?.status).toBe("projected");
    if (projection?.status !== "projected") {
      return;
    }
    expect(projection.delivery).toStrictEqual({
      sessionId: FLAGSHIP_SCENARIO.sessionId,
      runId: PROBE_RUN_ID,
      runVersion: 5,
      targetPosition: 2,
    });
    expect(RunRolledBackEventSchema.parse(projection.delivery)).toStrictEqual(projection.delivery);
  });
});

/** The queue item every queue beat below is about, and the row the scripted read carries. */
const PROBE_QUEUE_ITEM_ID = "019b79ee-0280-7c11-8110-d1a4c1150092";
const PROBE_QUEUE_ROW_READ: Readonly<Record<string, unknown>> = {
  items: [
    {
      id: PROBE_QUEUE_ITEM_ID,
      priority: 0,
      createdAt: "2026-01-01T14:20:00.420Z",
    },
  ],
};

/** One `queue_item.created` beat, whose kind announces the `queued` state. */
function queueBeatEvent(overrides: Readonly<Record<string, unknown>> = {}): ConsoleSessionEvent {
  const beat = runTransitionBeat({
    sessionId: FLAGSHIP_SCENARIO.sessionId,
    queueItemId: PROBE_QUEUE_ITEM_ID,
    state: "queued",
    ...overrides,
  });
  return { ...beat.event, kind: "queue_item.created" };
}

describe("run-stream projection — the session every arm's payload names", () => {
  // The rollback arm carried this cross-check alone. The two arms beside it are the
  // ones where a disagreement is UNRECOVERABLE afterwards: neither
  // `RunStateChangeEvent` nor `QueueItemSummary` carries a `sessionId` member, so the
  // projection dropped the payload's value on the floor and the narrowed subscriber
  // received a valid-looking update about a session it never asked for, with nothing
  // left on the delivered shape to notice it by.
  const stateArm = {
    name: "state-transition",
    project: (payload: Readonly<Record<string, unknown>>) =>
      projectRunStreamDelivery(RUN_STATE_EVENT_STREAM, runTransitionBeat(payload).event),
    wellFormed: transitionPayload(),
  };
  const queueArm = {
    name: "queue",
    project: (payload: Readonly<Record<string, unknown>>) =>
      projectRunStreamDelivery(
        RUN_QUEUE_EVENT_STREAM,
        queueBeatEvent(payload),
        PROBE_QUEUE_ROW_READ,
      ),
    wellFormed: {},
  };

  for (const arm of [stateArm, queueArm]) {
    it(`refuses a ${arm.name} beat whose payload names no session`, () => {
      const projection = arm.project({ ...arm.wellFormed, sessionId: undefined });

      expect(projection?.status).toBe("unprojectable");
      if (projection?.status !== "unprojectable") {
        return;
      }
      expect(projection.detail).toContain("sessionId");
    });

    it(`refuses a ${arm.name} beat whose payload names a different session, naming both`, () => {
      const projection = arm.project({ ...arm.wellFormed, sessionId: OTHER_SESSION_ID });

      expect(projection?.status).toBe("unprojectable");
      if (projection?.status !== "unprojectable") {
        return;
      }
      expect(projection.detail).toContain(FLAGSHIP_SCENARIO.sessionId);
      expect(projection.detail).toContain(OTHER_SESSION_ID);
    });

    it(`refuses a ${arm.name} beat whose payload names a session that is not a string`, () => {
      // A number cannot be compared against the envelope's identifier, and admitting
      // it would leave the arm delivering on an identifier nothing ever checked.
      const projection = arm.project({ ...arm.wellFormed, sessionId: 42 });

      expect(projection?.status).toBe("unprojectable");
      if (projection?.status !== "unprojectable") {
        return;
      }
      expect(projection.detail).toContain("sessionId");
    });

    it(`negative control: the agreeing ${arm.name} beat is delivered`, () => {
      // Without this the three cases above would hold over an arm that refused every
      // beat, which is the failure a fail-closed guard makes easy to ship.
      expect(arm.project(arm.wellFormed)?.status).toBe("projected");
    });
  }
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
