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
import type { ConsoleScenario } from "../scenario.js";

/** A session the branded schema accepts that is not the one the flagship's beats travel on. */
const STRANGER_SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a7777";

describe("scenario wire truth — a run beat that reports two states at once", () => {
  /**
   * The flagship's own `run.starting` beat, with its `newState` replaced.
   *
   * Built from the shipped beat rather than from a synthetic one so the case is
   * about the state pair and nothing else: every other member is the beat the
   * seat board already ships and the predicate already accepts.
   */
  function scenarioWithStartingBeatState(scenarioId: string, newState: string): ConsoleScenario {
    return {
      ...FLAGSHIP_SCENARIO,
      id: scenarioId,
      beats: FLAGSHIP_SCENARIO.beats.map((beat) =>
        beat.event.kind === "run.starting"
          ? { ...beat, event: { ...beat.event, payload: { ...beat.event.payload, newState } } }
          : beat,
      ),
    };
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
    const withoutNewState: ConsoleScenario = {
      ...FLAGSHIP_SCENARIO,
      id: "names-no-run-state",
      beats: FLAGSHIP_SCENARIO.beats.map((beat) =>
        beat.event.kind === "run.starting"
          ? {
              ...beat,
              event: { ...beat.event, payload: { ...beat.event.payload, newState: undefined } },
            }
          : beat,
      ),
    };

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
    return {
      ...FLAGSHIP_SCENARIO,
      id: scenarioId,
      beats: FLAGSHIP_SCENARIO.beats.map((beat) =>
        beat.event.kind === "run.starting" ? { ...beat, event: { ...beat.event, payload } } : beat,
      ),
    };
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
    return {
      ...FLAGSHIP_SCENARIO,
      id: scenarioId,
      beats: FLAGSHIP_SCENARIO.beats.map((beat) =>
        beat.event.kind === "run.starting"
          ? {
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
            }
          : beat,
      ),
    };
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
