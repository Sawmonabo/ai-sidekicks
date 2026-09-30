// The run and rollback legs: what a beat has to carry for the stream that delivers it.
//
// Cases drive `findScenarioContractDefects`, the only function a scenario is measured through, and
// start from the concurrent-streaming scenario's own beats so each varies one member.

import { describe, expect, it } from "vitest";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../fixtures/scenarios/concurrent-streaming.js";
import { findScenarioContractDefects } from "./contract-check.js";
import type { Scenario, ScenarioBeat } from "../../../fixtures/scenario.js";

/** A valid session id that is not the one the concurrent-streaming beats travel on. */
const STRANGER_SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a7777";

/**
 * The concurrent-streaming scenario with exactly one beat replaced: the first beat of the kind
 * named.
 *
 * The shipped scenario plays several runs, so replacing every beat of a kind would report five
 * defects for the one a case is about.
 */
function scenarioWithFirstBeatOfKindReplaced(
  scenarioId: string,
  kind: string,
  replace: (beat: ScenarioBeat) => ScenarioBeat,
): Scenario {
  const beatIndex = CONCURRENT_STREAMING_SCENARIO.beats.findIndex(
    (beat) => beat.event.kind === kind,
  );
  if (beatIndex === -1) {
    throw new Error(
      `the concurrent-streaming scenario plays no \`${kind}\` beat to build a case from`,
    );
  }
  return {
    ...CONCURRENT_STREAMING_SCENARIO,
    id: scenarioId,
    beats: CONCURRENT_STREAMING_SCENARIO.beats.map((beat, at) =>
      at === beatIndex ? replace(beat) : beat,
    ),
  };
}

describe("scenario wire truth — a run beat that reports two states at once", () => {
  /**
   * The concurrent-streaming scenario's own `run.starting` beat, with its `newState` replaced.
   *
   * Built from the shipped beat so the case is about the state pair and nothing else.
   */
  function scenarioWithStartingBeatState(scenarioId: string, newState: string): Scenario {
    return scenarioWithFirstBeatOfKindReplaced(scenarioId, "run.starting", (beat) => ({
      ...beat,
      event: { ...beat.event, payload: { ...beat.event.payload, newState } },
    }));
  }

  it("reports a beat whose payload names a state its kind does not announce", () => {
    // Both `run.starting` and `"failed"` are registered and no payload variant exists for run
    // lifecycle kinds, so the strict layer cannot see the pair.
    const defects = findScenarioContractDefects([
      scenarioWithStartingBeatState("reports-two-run-states", "failed"),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("run.starting");
    // The projection's own words, because the projection makes the call.
    expect(defects[0]?.reason).toContain("two current states");
  });

  it("negative control: the same beat naming the state its kind announces is clean", () => {
    // Without this the case above would hold over a leg that reported every run beat.
    expect(
      findScenarioContractDefects([scenarioWithStartingBeatState("names-one-state", "starting")]),
    ).toStrictEqual([]);
  });

  it("reports a beat whose payload names no state at all", () => {
    // A `run.running` beat with no `newState` would be refused at delivery as unprojectable while
    // the projector dropped its mutation: a green gate with nothing on screen.
    const withoutNewState = scenarioWithFirstBeatOfKindReplaced(
      "names-no-run-state",
      "run.starting",
      (beat) => ({
        ...beat,
        event: { ...beat.event, payload: { ...beat.event.payload, newState: undefined } },
      }),
    );

    const defects = findScenarioContractDefects([withoutNewState]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("run.starting");
    expect(defects[0]?.reason).toContain("newState");
  });

  it("leaves the kinds the run-state stream does not carry to the other legs", () => {
    // `run.queued` is a creation, not a transition, and the mapping claims no state for it, so the
    // shipped creation beat (`newState: "queued"`, no state it came from) stays clean.
    const queuedBeat = CONCURRENT_STREAMING_SCENARIO.beats.find(
      (beat) => beat.event.kind === "run.queued",
    );

    expect(queuedBeat?.event.payload?.["newState"]).toBe("queued");
    expect(findScenarioContractDefects([CONCURRENT_STREAMING_SCENARIO])).toStrictEqual([]);
  });
});

describe("scenario wire truth — a run beat held to the whole shape its stream projects", () => {
  /**
   * The concurrent-streaming scenario's own `run.starting` beat, carrying exactly `payload`.
   *
   * A replacement rather than a spread, since these cases vary which members are present.
   */
  function scenarioWithStartingBeatPayload(
    scenarioId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Scenario {
    return scenarioWithFirstBeatOfKindReplaced(scenarioId, "run.starting", (beat) => ({
      ...beat,
      event: { ...beat.event, payload },
    }));
  }

  /** The concurrent-streaming scenario's own `run.starting` payload: a complete transition. */
  function shippedStartingPayload(): Readonly<Record<string, unknown>> {
    const payload = CONCURRENT_STREAMING_SCENARIO.beats.find(
      (beat) => beat.event.kind === "run.starting",
    )?.event.payload;
    if (payload === undefined) {
      throw new Error(
        "the concurrent-streaming scenario plays no `run.starting` beat to read a payload from",
      );
    }
    return payload;
  }

  it("reports a beat carrying nothing but the state its kind announces", () => {
    // The announced state matches and the tolerant envelope carries it, yet the fixture refuses the
    // beat at delivery and the run-lifecycle projector, which needs a `runId`, yields no mutation.
    const defects = findScenarioContractDefects([
      scenarioWithStartingBeatPayload("names-only-its-state", { newState: "starting" }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("run.starting");
    expect(defects[0]?.reason).toContain("run.subscribeState");
    expect(defects[0]?.reason).toContain("sessionId");
  });

  it("names every member the registered transition shape is still missing", () => {
    // With the session supplied the refusal reaches the parse, which reports each absent member by
    // path so an author fixes the beat in one pass.
    const defects = findScenarioContractDefects([
      scenarioWithStartingBeatPayload("names-its-session-and-no-more", {
        sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
        newState: "starting",
      }),
    ]);

    expect(defects).toHaveLength(1);
    const reason = defects[0]?.reason ?? "";
    expect(reason).toContain("runId");
    expect(reason).toContain("runVersion");
    expect(reason).toContain("previousState");
  });

  it("reports a transition beat whose payload names a session it is not delivered on", () => {
    // Neither state arm's registered shape carries a `sessionId`, so the projection drops the
    // disagreeing value and the subscriber gets a valid-looking update about another session.
    const defects = findScenarioContractDefects([
      scenarioWithStartingBeatPayload("transition-names-another-session", {
        ...shippedStartingPayload(),
        sessionId: STRANGER_SESSION_ID,
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain(STRANGER_SESSION_ID);
    expect(defects[0]?.reason).toContain("disagree");
  });

  it("negative control: the complete transition the shipped scenario carries is clean", () => {
    // Without it every case above would hold over a leg that refused every run beat.
    expect(
      findScenarioContractDefects([
        scenarioWithStartingBeatPayload("names-the-shipped-payload", shippedStartingPayload()),
      ]),
    ).toStrictEqual([]);
  });
});

describe("scenario wire truth — a rollback beat whose payload names the wrong session", () => {
  /**
   * The concurrent-streaming scenario's own `run.starting` beat, re-kinded as the rollback row.
   *
   * The transition members go with the state kind, since the rollback row registers none.
   */
  function scenarioWithRollbackBeat(
    scenarioId: string,
    payloadSessionId: string | undefined,
  ): Scenario {
    return scenarioWithFirstBeatOfKindReplaced(scenarioId, "run.starting", (beat) => ({
      ...beat,
      event: {
        ...beat.event,
        kind: "run.rolled_back",
        payload: {
          ...(payloadSessionId === undefined ? {} : { sessionId: payloadSessionId }),
          runId: beat.event.payload?.["runId"],
          runVersion: beat.event.payload?.["runVersion"],
          targetPosition: 1,
        },
      },
    }));
  }

  it("reports a rollback beat that carries no session at all", () => {
    // The registered payload requires the member and nothing shipped enforces it, so the projection
    // stamped the envelope's session on in its place.
    const defects = findScenarioContractDefects([
      scenarioWithRollbackBeat("rollback-names-no-session", undefined),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("run.rolled_back");
    expect(defects[0]?.reason).toContain("sessionId");
  });

  it("reports a rollback beat whose payload session is not the one it is delivered on", () => {
    const defects = findScenarioContractDefects([
      scenarioWithRollbackBeat("rollback-names-another-session", STRANGER_SESSION_ID),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain(STRANGER_SESSION_ID);
    expect(defects[0]?.reason).toContain("disagree");
  });

  it("negative control: the same beat naming its own session is clean", () => {
    // Without it both cases above would hold over a leg that reported every rollback beat.
    expect(
      findScenarioContractDefects([
        scenarioWithRollbackBeat(
          "rollback-names-its-own-session",
          CONCURRENT_STREAMING_SCENARIO.sessionId,
        ),
      ]),
    ).toStrictEqual([]);
  });
});

describe("scenario wire truth — the run kinds no narrowed stream projects", () => {
  /** The concurrent-streaming scenario's own creation beat, carrying exactly the payload named. */
  function scenarioWithQueuedPayload(
    scenarioId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Scenario {
    return scenarioWithFirstBeatOfKindReplaced(scenarioId, "run.queued", (beat) => ({
      ...beat,
      event: { ...beat.event, payload },
    }));
  }

  /**
   * The concurrent-streaming scenario's `run.starting` beat, re-kinded to a forward, non-state row.
   *
   * A replacement payload rather than a spread, since these cases vary which members are present.
   */
  function scenarioWithForwardRunBeat(
    scenarioId: string,
    kind: string,
    payload: Readonly<Record<string, unknown>>,
  ): Scenario {
    return scenarioWithFirstBeatOfKindReplaced(scenarioId, "run.starting", (beat) => ({
      ...beat,
      event: { ...beat.event, kind, payload },
    }));
  }

  /** The identity every run-lifecycle payload carries, taken off the shipped beat. */
  const RUN_IDENTITY = {
    sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
    runId: "019b79ee-0280-740e-8110-d1a4c1150011",
    runVersion: 2,
  };

  it("reports a creation beat carrying neither its progression counter nor its state", () => {
    // `run.queued` reaches a subscriber only through `session.subscribe`, so its payload is the
    // contract's creation row; a half payload would fold into a run with no version and no state.
    const defects = findScenarioContractDefects([
      scenarioWithQueuedPayload("creation-names-half-a-payload", {
        sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
        runId: RUN_IDENTITY.runId,
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("run.queued");
    expect(defects[0]?.reason).toContain("runVersion");
    expect(defects[0]?.reason).toContain("newState");
  });

  it("reports a provider-initialization beat that names no provider", () => {
    const defects = findScenarioContractDefects([
      scenarioWithForwardRunBeat(
        "init-names-no-provider",
        "run.provider_initialized",
        RUN_IDENTITY,
      ),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("run.provider_initialized");
    expect(defects[0]?.reason).toContain("provider");
  });

  it("reports a forward beat that names no run at all, whichever of the three it is", () => {
    for (const kind of ["run.turn_started", "run.worker_shutdown"]) {
      const defects = findScenarioContractDefects([
        scenarioWithForwardRunBeat(`${kind}-names-no-run`, kind, {
          sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
        }),
      ]);

      expect(defects, kind).toHaveLength(1);
      expect(defects[0]?.reason, kind).toContain("runId");
      expect(defects[0]?.reason, kind).toContain("runVersion");
    }
  });

  it("negative control: a complete payload passes on every one of the four kinds", () => {
    // Without this the cases above would hold over a leg reporting every beat of these kinds. The
    // optional members are carried too, since a leg refusing them would be stricter than the wire.
    expect(findScenarioContractDefects([CONCURRENT_STREAMING_SCENARIO])).toStrictEqual([]);
    expect(
      findScenarioContractDefects([
        scenarioWithForwardRunBeat("init-is-complete", "run.provider_initialized", {
          ...RUN_IDENTITY,
          provider: "claude",
          model: "claude-opus-4-6",
        }),
        scenarioWithForwardRunBeat("turn-is-complete", "run.turn_started", {
          ...RUN_IDENTITY,
          position: 3,
        }),
        scenarioWithForwardRunBeat("shutdown-is-complete", "run.worker_shutdown", {
          ...RUN_IDENTITY,
          reason: "provider worker restarting",
        }),
      ]),
    ).toStrictEqual([]);
  });

  it("negative control: a projected kind is left to the projection leg, not held here", () => {
    // The two legs partition the `run.` root, so a beat is reported by one and never both; a
    // `run.starting` beat reports in the projection's own words.
    const defects = findScenarioContractDefects([
      scenarioWithForwardRunBeat("transition-names-half-a-payload", "run.starting", {
        sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
        newState: "starting",
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("run.subscribeState");
    expect(defects[0]?.reason).not.toContain("no narrowed stream");
  });
});

describe("scenario wire truth — a run beat claiming it moved to the state it was in", () => {
  /** The concurrent-streaming scenario's own `run.starting` beat, with `previousState` replaced. */
  function scenarioWithStartingBeatPreviousState(
    scenarioId: string,
    previousState: string,
  ): Scenario {
    return scenarioWithFirstBeatOfKindReplaced(scenarioId, "run.starting", (beat) => ({
      ...beat,
      event: { ...beat.event, payload: { ...beat.event.payload, previousState } },
    }));
  }

  it("reports a beat naming one state as both the state it left and the state it reached", () => {
    // Each member is registered and the strict layer has no variant for run lifecycle kinds, so
    // only the transition table rules it out: it has no row whose `From` and `To` are one state.
    const defects = findScenarioContractDefects([
      scenarioWithStartingBeatPreviousState("reports-a-self-transition", "starting"),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("run.starting");
    expect(defects[0]?.reason).toContain("the state it was already in");
  });

  it("negative control: the same beat naming a real transition is clean", () => {
    // Without it a rule reporting every run beat would pass the case above. `queued` is the state
    // the shipped beat comes from, so the revision is a no-op.
    expect(
      findScenarioContractDefects([
        scenarioWithStartingBeatPreviousState("reports-a-real-transition", "queued"),
      ]),
    ).toStrictEqual([]);
  });
});
