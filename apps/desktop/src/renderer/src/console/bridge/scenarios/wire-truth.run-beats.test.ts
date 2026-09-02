// The run and rollback legs: what a beat has to carry for the stream that delivers it.
//
// One file per axis of the predicate, beside the aggregate entry rather than inside
// `wire-truth/`, because every case here drives `findScenarioWireTruthDefects` and not
// the leg module directly — the aggregate is the only surface a family's scenario is
// ever measured through, and a test that reached past it would be checking a function
// no scenario meets.
//
// EVERY CASE IS BUILT FROM A SHIPPED BEAT. The flagship's own `run.starting` beat is
// the base for all of them, so what a case varies is the one member it is about and
// every other member is one the seat board already carries and the predicate already
// accepts.

import { describe, expect, it } from "vitest";

import { FLAGSHIP_SCENARIO } from "./flagship.js";
import { findScenarioWireTruthDefects } from "./wire-truth.js";
import type { ConsoleScenario, ScenarioBeat } from "../scenario.js";

/** A session the branded schema accepts that is not the one the flagship's beats travel on. */
const STRANGER_SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a7777";

/**
 * The flagship with exactly ONE beat replaced — the first beat of the kind named.
 *
 * Every case in this file is about a single beat, and the seat board plays several
 * runs, so replacing every beat of a kind would vary five and report five defects for
 * the one defect the case is about. The helper is the only thing that knows there is
 * more than one run; each case still reads as "the flagship's own beat, with X
 * replaced", which is what its own comment claims.
 */
function scenarioWithFirstBeatOfKindReplaced(
  scenarioId: string,
  kind: string,
  replace: (beat: ScenarioBeat) => ScenarioBeat,
): ConsoleScenario {
  const beatIndex = FLAGSHIP_SCENARIO.beats.findIndex((beat) => beat.event.kind === kind);
  if (beatIndex === -1) {
    throw new Error(`the flagship scenario plays no \`${kind}\` beat to build a case from`);
  }
  return {
    ...FLAGSHIP_SCENARIO,
    id: scenarioId,
    beats: FLAGSHIP_SCENARIO.beats.map((beat, at) => (at === beatIndex ? replace(beat) : beat)),
  };
}

describe("scenario wire truth — a run beat that reports two states at once", () => {
  /**
   * The flagship's own `run.starting` beat, with its `newState` replaced.
   *
   * Built from the shipped beat rather than from a synthetic one so the case is
   * about the state pair and nothing else: every other member is the beat the
   * seat board already ships and the predicate already accepts.
   */
  function scenarioWithStartingBeatState(scenarioId: string, newState: string): ConsoleScenario {
    return scenarioWithFirstBeatOfKindReplaced(scenarioId, "run.starting", (beat) => ({
      ...beat,
      event: { ...beat.event, payload: { ...beat.event.payload, newState } },
    }));
  }

  it("reports a beat whose payload names a state its kind does not announce", () => {
    // The defect the strict layer cannot see: `run.starting` and `"failed"` are
    // both registered, the census admits the kind, the envelope carries the beat,
    // and no payload variant is registered for the run-lifecycle kinds — so before
    // this leg the pair reached the fold unchallenged.
    const defects = findScenarioWireTruthDefects([
      scenarioWithStartingBeatState("reports-two-run-states", "failed"),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("run.starting");
    // The projection's own words, because the projection is what makes the call.
    expect(defects[0]?.reason).toContain("two current states");
  });

  it("negative control: the same beat naming the state its kind announces is clean", () => {
    // Without this the case above would hold over a leg that reported every run
    // beat, and the seat-board case at the top of this file would be the only
    // thing standing between that and a predicate nothing can satisfy.
    expect(
      findScenarioWireTruthDefects([scenarioWithStartingBeatState("names-one-state", "starting")]),
    ).toStrictEqual([]);
  });

  it("reports a beat whose payload names no state at all", () => {
    // The quieter half, and the one that stayed green: absence was treated as
    // clean, so a family scenario could ship a `run.running` beat with no
    // `newState`, pass the architecture suite, and then be refused at delivery as
    // unprojectable while the run-lifecycle projector dropped its mutation. Green
    // gate, nothing on screen.
    const withoutNewState = scenarioWithFirstBeatOfKindReplaced(
      "names-no-run-state",
      "run.starting",
      (beat) => ({
        ...beat,
        event: { ...beat.event, payload: { ...beat.event.payload, newState: undefined } },
      }),
    );

    const defects = findScenarioWireTruthDefects([withoutNewState]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("run.starting");
    expect(defects[0]?.reason).toContain("newState");
  });

  it("leaves the kinds the run-state stream does not carry to the other legs", () => {
    // `run.queued` is the run's creation rather than a transition, and the mapping
    // this leg reads claims no state for it — so the shipped creation beat, which
    // names `newState: "queued"` and no state it came from, is not this leg's
    // business and stays clean.
    const queuedBeat = FLAGSHIP_SCENARIO.beats.find((beat) => beat.event.kind === "run.queued");

    expect(queuedBeat?.event.payload?.["newState"]).toBe("queued");
    expect(findScenarioWireTruthDefects([FLAGSHIP_SCENARIO])).toStrictEqual([]);
  });
});

describe("scenario wire truth — a run beat held to the whole shape its stream projects", () => {
  /**
   * The flagship's own `run.starting` beat, carrying exactly the payload named.
   *
   * A replacement rather than a spread, unlike the state-pair cases above: what these
   * cases vary is which members are PRESENT, and a spread would supply the ones the
   * beat is meant to be missing.
   */
  function scenarioWithStartingBeatPayload(
    scenarioId: string,
    payload: Readonly<Record<string, unknown>>,
  ): ConsoleScenario {
    return scenarioWithFirstBeatOfKindReplaced(scenarioId, "run.starting", (beat) => ({
      ...beat,
      event: { ...beat.event, payload },
    }));
  }

  /**
   * The flagship's own `run.starting` payload — a complete registered transition.
   *
   * Read off the shipped beat rather than written out again, so a case that varies one
   * member varies it against the payload the seat board actually carries.
   */
  function shippedStartingPayload(): Readonly<Record<string, unknown>> {
    const payload = FLAGSHIP_SCENARIO.beats.find((beat) => beat.event.kind === "run.starting")
      ?.event.payload;
    if (payload === undefined) {
      throw new Error("the flagship scenario plays no `run.starting` beat to read a payload from");
    }
    return payload;
  }

  it("reports a beat carrying nothing but the state its kind announces", () => {
    // The finding and its negative control at once: on the old walk this answered NO
    // defect. The announced state matched, the tolerant envelope carried the payload,
    // and the strict layer's discriminator escape covered the rest — while the fixture
    // refused the very same beat at delivery and the run-lifecycle projector, which
    // needs a `runId`, produced no mutation for it. Green gate, nothing on screen.
    const defects = findScenarioWireTruthDefects([
      scenarioWithStartingBeatPayload("names-only-its-state", { newState: "starting" }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("run.starting");
    expect(defects[0]?.reason).toContain("run.subscribeState");
    expect(defects[0]?.reason).toContain("sessionId");
  });

  it("names every member the registered transition shape is still missing", () => {
    // With the session supplied the refusal reaches the parse, which reports each
    // absent member by its own path rather than stopping at the first — so a scenario
    // author fixes the beat in one pass instead of one member per run.
    const defects = findScenarioWireTruthDefects([
      scenarioWithStartingBeatPayload("names-its-session-and-no-more", {
        sessionId: FLAGSHIP_SCENARIO.sessionId,
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
    // The rollback arm used to carry this check alone, which left the two state arms
    // as the ones that could hide the mismatch: neither registered stream shape carries
    // a `sessionId` member at all, so the disagreeing value is dropped by the projection
    // and the subscriber receives a valid-looking update about a session nobody asked
    // about, with nothing on the delivered payload left to notice it by.
    const defects = findScenarioWireTruthDefects([
      scenarioWithStartingBeatPayload("transition-names-another-session", {
        ...shippedStartingPayload(),
        sessionId: STRANGER_SESSION_ID,
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain(STRANGER_SESSION_ID);
    expect(defects[0]?.reason).toContain("disagree");
  });

  it("negative control: the complete transition the seat board ships is clean", () => {
    // Without it every case above would hold over a leg that refused every run beat,
    // and no family could script a transition at all. The payload is the shipped one,
    // handed back through the same replacement the cases above use.
    expect(
      findScenarioWireTruthDefects([
        scenarioWithStartingBeatPayload("names-the-shipped-payload", shippedStartingPayload()),
      ]),
    ).toStrictEqual([]);
  });
});

describe("scenario wire truth — a rollback beat whose payload names the wrong session", () => {
  /**
   * The flagship's own `run.starting` beat, re-kinded as the rollback row.
   *
   * Built from a shipped beat for the reason the state-pair cases above are: every
   * envelope member is one the seat board already carries and the predicate already
   * accepts, so what the case is about is the payload's session and nothing else. The
   * transition members go with the state kind — the rollback row registers none.
   */
  function scenarioWithRollbackBeat(
    scenarioId: string,
    payloadSessionId: string | undefined,
  ): ConsoleScenario {
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
    // The member is required by the registered per-type payload and enforced by
    // nothing the contracts package ships — no strict-layer variant is registered for
    // this kind — so before this leg the beat passed every check and the projection
    // that consumes it stamped the envelope's session on in its place.
    const defects = findScenarioWireTruthDefects([
      scenarioWithRollbackBeat("rollback-names-no-session", undefined),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("run.rolled_back");
    expect(defects[0]?.reason).toContain("sessionId");
  });

  it("reports a rollback beat whose payload session is not the one it is delivered on", () => {
    const defects = findScenarioWireTruthDefects([
      scenarioWithRollbackBeat("rollback-names-another-session", STRANGER_SESSION_ID),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain(STRANGER_SESSION_ID);
    expect(defects[0]?.reason).toContain("disagree");
  });

  it("negative control: the same beat naming its own session is clean", () => {
    // Without it both cases above would hold over a leg that reported every rollback
    // beat — and the seat-board case at the top of this file would be all that stood
    // between that and a predicate no scenario carrying a rollback could satisfy.
    expect(
      findScenarioWireTruthDefects([
        scenarioWithRollbackBeat("rollback-names-its-own-session", FLAGSHIP_SCENARIO.sessionId),
      ]),
    ).toStrictEqual([]);
  });
});

describe("scenario wire truth — the run kinds no narrowed stream projects", () => {
  /** The flagship's own creation beat, carrying exactly the payload named. */
  function scenarioWithQueuedPayload(
    scenarioId: string,
    payload: Readonly<Record<string, unknown>>,
  ): ConsoleScenario {
    return scenarioWithFirstBeatOfKindReplaced(scenarioId, "run.queued", (beat) => ({
      ...beat,
      event: { ...beat.event, payload },
    }));
  }

  /**
   * The flagship's `run.starting` beat, re-kinded to a forward, non-state row.
   *
   * A replacement payload rather than a spread, because what these cases vary is
   * which members are PRESENT: a spread would supply the transition members the
   * shipped beat carries and the case would be about something else.
   */
  function scenarioWithForwardRunBeat(
    scenarioId: string,
    kind: string,
    payload: Readonly<Record<string, unknown>>,
  ): ConsoleScenario {
    return scenarioWithFirstBeatOfKindReplaced(scenarioId, "run.starting", (beat) => ({
      ...beat,
      event: { ...beat.event, kind, payload },
    }));
  }

  /** The identity every run-lifecycle payload carries, taken off the shipped beat. */
  const RUN_IDENTITY = {
    sessionId: FLAGSHIP_SCENARIO.sessionId,
    runId: "019b79ee-0280-740e-8110-d1a4c1150011",
    runVersion: 2,
  };

  it("reports a creation beat carrying neither its progression counter nor its state", () => {
    // `run.queued` reaches a subscriber only through `session.subscribe`, so the
    // projection leg claims it and the strict layer registers no variant for it —
    // which left every member of its payload unchecked. A beat like this passed the
    // census, the envelope, and the discriminator escape, and the run-lifecycle
    // projector then folded it into a run with no version and no state.
    const defects = findScenarioWireTruthDefects([
      scenarioWithQueuedPayload("creation-names-half-a-payload", {
        sessionId: FLAGSHIP_SCENARIO.sessionId,
        runId: RUN_IDENTITY.runId,
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain("run.queued");
    expect(defects[0]?.reason).toContain("runVersion");
    expect(defects[0]?.reason).toContain("newState");
  });

  it("reports a provider-initialization beat that names no provider", () => {
    const defects = findScenarioWireTruthDefects([
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
      const defects = findScenarioWireTruthDefects([
        scenarioWithForwardRunBeat(`${kind}-names-no-run`, kind, {
          sessionId: FLAGSHIP_SCENARIO.sessionId,
        }),
      ]);

      expect(defects, kind).toHaveLength(1);
      expect(defects[0]?.reason, kind).toContain("runId");
      expect(defects[0]?.reason, kind).toContain("runVersion");
    }
  });

  it("negative control: a complete payload passes on every one of the four kinds", () => {
    // Without this the cases above would hold over a leg that reported every beat of
    // these kinds, which would make the shipped creation row — and every family
    // scenario that scripts one — unshippable. The optional members are carried too,
    // because the registered shapes name them and a leg that refused them would be
    // stricter than the wire.
    expect(findScenarioWireTruthDefects([FLAGSHIP_SCENARIO])).toStrictEqual([]);
    expect(
      findScenarioWireTruthDefects([
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
    // The two legs partition the `run.` root, so a beat can be reported by one of
    // them and never by both. A `run.starting` beat missing the same members reports
    // in the projection's own words, which is how a reader tells which rule it broke.
    const defects = findScenarioWireTruthDefects([
      scenarioWithForwardRunBeat("transition-names-half-a-payload", "run.starting", {
        sessionId: FLAGSHIP_SCENARIO.sessionId,
        newState: "starting",
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("run.subscribeState");
    expect(defects[0]?.reason).not.toContain("no narrowed stream");
  });
});
