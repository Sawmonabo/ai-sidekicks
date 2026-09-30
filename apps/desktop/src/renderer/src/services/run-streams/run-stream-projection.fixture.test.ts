// The projector's own behavior, apart from the bridge that calls it. The bridge-level test cannot
// tell "this name registers no projection" from "the projection rebuilt the envelope" (both
// deliver an envelope), nor see which optional members survive (a projector that dropped them all
// still parses). This suite asserts `undefined` directly and pins which beats reach the schema
// gate, which are refused at it, and what the refusal names.

import { describe, expect, it } from "vitest";

import { RunStateChangeEventSchema, RunRolledBackEventSchema } from "@ai-sidekicks/contracts";

import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { PROBE_RUN_ID, runTransitionBeat } from "@test/helpers/fixture-bridge.js";
import { projectRunStreamDelivery } from "./run-stream-projection.fixture.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
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
    sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
    runId: PROBE_RUN_ID,
    runVersion: 4,
    previousState: "starting",
    newState: "running",
    ...overrides,
  };
}

/**
 * One `run.rolled_back` beat in the registered per-type payload shape, built off the shared
 * transition beat and re-kinded so the cases are about the payload.
 */
function rollbackBeatEvent(
  overrides: Readonly<Record<string, unknown>> = {},
): ProjectedSessionEvent {
  const beat = runTransitionBeat({
    sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
    runId: PROBE_RUN_ID,
    runVersion: 5,
    targetPosition: 2,
    ...overrides,
  });
  return { ...beat.event, kind: "run.rolled_back" };
}

describe("run-stream projection — which subscriptions it answers for", () => {
  it("answers `undefined` for a subscription that registers no projection", () => {
    // The whole-session stream carries the log and a bare event type carries only itself; the
    // corpus registers a projection for neither.
    const beat = runTransitionBeat(transitionPayload());

    const noQueueRows = (): undefined => undefined;

    expect(projectRunStreamDelivery(SESSION_EVENT_STREAM, beat.event, noQueueRows)).toBeUndefined();
    expect(projectRunStreamDelivery("run.starting", beat.event, noQueueRows)).toBeUndefined();
  });

  it("negative control: the narrowed run stream does answer for the same beat", () => {
    // Without it, a projector that answered `undefined` for everything would pass the case above.
    const beat = runTransitionBeat(transitionPayload());

    expect(projectRunStreamDelivery(RUN_STATE_EVENT_STREAM, beat.event)?.status).toBe("projected");
  });
});

describe("run-stream projection — the optional members a beat supplies", () => {
  it("carries them through rather than flattening them", () => {
    const beat = runTransitionBeat(
      transitionPayload({ completionKind: "turn", trigger: "budget_exhausted" }),
    );
    const projection = projectRunStreamDelivery(RUN_STATE_EVENT_STREAM, beat.event);

    expect(projection?.status).toBe("projected");
    if (projection?.status !== "projected") {
      return;
    }
    const parsed = RunStateChangeEventSchema.parse(projection.delivery);
    expect(parsed.completionKind).toBe("turn");
    expect(parsed.trigger).toBe("budget_exhausted");
  });

  it("negative control: one the beat omits is absent, not defaulted", () => {
    // A projector that stamped every optional would pass the case above and put a `completionKind`
    // on a run that never completed.
    const beat = runTransitionBeat(transitionPayload());
    const projection = projectRunStreamDelivery(RUN_STATE_EVENT_STREAM, beat.event);

    expect(projection?.status).toBe("projected");
    if (projection?.status !== "projected") {
      return;
    }
    const parsed = RunStateChangeEventSchema.parse(projection.delivery);
    expect(parsed.completionKind).toBeUndefined();
    expect("trigger" in parsed).toBe(false);
  });
});

describe("run-stream projection — an optional the registered shape rejects", () => {
  // Each value is one the wire member's own schema refuses (`intendedClose` is `z.literal(true)`,
  // `completionKind` is `z.enum(["turn", "task"])`, and a `trusted` `executionPosture` requires
  // `networkAccess` and `writableRoots`); a fixture subscriber must never receive one.
  it.each([
    ["intendedClose", { intendedClose: false }],
    ["completionKind", { completionKind: "session" }],
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
    // The member's own path, so a scenario author reads which member is wrong.
    expect(projection.detail).toContain(member);
  });

  it("negative control: the same optionals at values the shape admits are delivered", () => {
    // Without it, a projector that refused every optional would pass all three cases above.
    const projection = projectRunStreamDelivery(
      RUN_STATE_EVENT_STREAM,
      runTransitionBeat(
        transitionPayload({
          intendedClose: true,
          completionKind: "turn",
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
    // The whole delivered value, since the parse is what stands between a subscriber and a shape
    // the daemon does not send.
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
      newState: "running",
      timestamp: beat.event.occurredAt,
    });
  });
});

describe("run-stream projection — the rollback arm's session, which the payload owns", () => {
  it("refuses a rollback beat that names no session in its payload", () => {
    // The registered payload is `{sessionId, runId, runVersion, channelId?, targetPosition}` and no
    // strict-layer variant is registered for the kind, so nothing else rejects an omission of it.
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
    // The louder half: the durable row is refined against the envelope, so they cannot disagree,
    // and the disagreement must not be resolved silently in the envelope's favor.
    const projection = projectRunStreamDelivery(
      RUN_STATE_EVENT_STREAM,
      rollbackBeatEvent({ sessionId: OTHER_SESSION_ID }),
    );

    expect(projection?.status).toBe("unprojectable");
    if (projection?.status !== "unprojectable") {
      return;
    }
    // Both values, so a scenario author reads which two sessions were in hand.
    expect(projection.detail).toContain(CONCURRENT_STREAMING_SCENARIO.sessionId);
    expect(projection.detail).toContain(OTHER_SESSION_ID);
  });

  it("negative control: an agreeing beat is delivered, carrying the payload's own member", () => {
    // Without this the two cases above would hold over an arm that refused every rollback. The
    // delivered session is the payload's; copying the envelope's would pass here but make the
    // mismatch check unreachable, which the case above pins.
    const projection = projectRunStreamDelivery(RUN_STATE_EVENT_STREAM, rollbackBeatEvent());

    expect(projection?.status).toBe("projected");
    if (projection?.status !== "projected") {
      return;
    }
    expect(projection.delivery).toStrictEqual({
      sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
      runId: PROBE_RUN_ID,
      runVersion: 5,
      targetPosition: 2,
    });
    expect(RunRolledBackEventSchema.parse(projection.delivery)).toStrictEqual(projection.delivery);
  });
});

/** The queue item every queue beat below is about, and its row. */
const PROBE_QUEUE_ITEM_ID = "019b79ee-0280-7c11-8110-d1a4c1150092";
const PROBE_QUEUE_ROW: Readonly<Record<string, unknown>> = {
  id: PROBE_QUEUE_ITEM_ID,
  priority: 0,
  content: "Also run the linter",
  createdAt: "2026-01-01T14:20:00.420Z",
};

/** One `queue_item.created` beat, whose kind announces the `queued` state. */
function queueBeatEvent(overrides: Readonly<Record<string, unknown>> = {}): ProjectedSessionEvent {
  const beat = runTransitionBeat({
    sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
    queueItemId: PROBE_QUEUE_ITEM_ID,
    state: "queued",
    ...overrides,
  });
  return { ...beat.event, kind: "queue_item.created" };
}

describe("run-stream projection — the session every arm's payload names", () => {
  // Both other arms need this too: neither `RunStateChangeEvent` nor `QueueItemSummary` carries a
  // `sessionId`, so a disagreement would reach a subscriber with nothing left to notice it by.
  const stateArm = {
    name: "state-transition",
    project: (payload: Readonly<Record<string, unknown>>) =>
      projectRunStreamDelivery(RUN_STATE_EVENT_STREAM, runTransitionBeat(payload).event),
    wellFormed: transitionPayload(),
  };
  const queueArm = {
    name: "queue",
    project: (payload: Readonly<Record<string, unknown>>) =>
      projectRunStreamDelivery(RUN_QUEUE_EVENT_STREAM, queueBeatEvent(payload), (queueItemId) =>
        queueItemId === PROBE_QUEUE_ITEM_ID ? PROBE_QUEUE_ROW : undefined,
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
      expect(projection.detail).toContain(CONCURRENT_STREAMING_SCENARIO.sessionId);
      expect(projection.detail).toContain(OTHER_SESSION_ID);
    });

    it(`refuses a ${arm.name} beat whose payload names a session that is not a string`, () => {
      // A number cannot be compared against the envelope's identifier, and admitting it would
      // leave the arm delivering on an identifier nothing checked.
      const projection = arm.project({ ...arm.wellFormed, sessionId: 42 });

      expect(projection?.status).toBe("unprojectable");
      if (projection?.status !== "unprojectable") {
        return;
      }
      expect(projection.detail).toContain("sessionId");
    });

    it(`negative control: the agreeing ${arm.name} beat is delivered`, () => {
      // Without this the three cases above would hold over an arm that refused every beat.
      expect(arm.project(arm.wellFormed)?.status).toBe("projected");
    });
  }
});

describe("run-stream projection — a member it will not compose", () => {
  it("refuses a counter that is not a whole non-negative number", () => {
    // `runVersion` is the comparand every guarded request is rejected against, so an admitted
    // fractional one would come back as an `expectedRunVersion` no row can match.
    const fractional = projectRunStreamDelivery(
      RUN_STATE_EVENT_STREAM,
      runTransitionBeat(transitionPayload({ runVersion: 1.5 })).event,
    );

    expect(fractional?.status).toBe("unprojectable");
  });

  it("refuses a state the registered vocabulary does not carry", () => {
    // `run.started` reads like a real transition but names a state that does not exist; admitted,
    // it would reach a view typed as a union it is not a member of.
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
