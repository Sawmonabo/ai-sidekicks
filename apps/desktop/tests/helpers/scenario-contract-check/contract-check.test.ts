// The predicate's beat, queue and caller legs, driven through the aggregate entry.
//
// A PER-LEG CONTROL. Each case drives the same imported predicate over a real scenario
// with one deliberate defect, and never a local copy of the rule.
//
// THE OTHER AXES ARE BESIDE THIS FILE, ONE PER MODULE THEY COVER: `run-beats.test.ts`
// for the run and rollback semantics, and `beat-order.test.ts` for the tick and log
// position. Every one of them drives the aggregate entry rather than a leg directly,
// because the aggregate is the only surface a family's scenario is measured through.

import { describe, expect, it } from "vitest";

import { SCENARIOS } from "../../../fixtures/index.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../fixtures/scenarios/concurrent-streaming.js";
import { findScenarioContractDefects } from "./contract-check.js";
import type { Scenario, ScenarioBeat } from "../../../fixtures/scenario.js";

/** Someone this session never joins, spelled as the branded id type declares. */
const STRANGER_USER_ID = "019b79ee-0280-79a4-8110-cca0117a9999";

describe("scenario wire truth — the shipped seat board", () => {
  it("accepts every scenario a family has landed on the board", () => {
    expect(
      findScenarioContractDefects(SCENARIOS).map(
        (defect) => `${defect.scenarioId}: ${defect.subject} — ${defect.reason}`,
      ),
    ).toStrictEqual([]);
  });
});

describe("the catalog", () => {
  it("carries unique ids, so the picker and the lookup cannot collide", () => {
    const ids = SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/** A queue row the queue-state cases below are about, spelled as its branded id declares. */
const CONTROL_QUEUE_ITEM_ID = "019b79ee-0280-7c11-8110-d1a4c1159902";

/** Someone the concurrent-streaming joins, so a caller case varies the caller and nothing else. */
const CONCURRENT_STREAMING_USER_ID = CONCURRENT_STREAMING_SCENARIO.userIdsInJoinOrder[0] ?? "";

/**
 * The concurrent-streaming scenario playing exactly ONE beat, built from its own opening beat.
 *
 * A single beat is what every case below is about, and starting from the seat board's
 * own means the envelope members a case does not touch — the session it travels on,
 * the log position it opens at, the actor — are ones the predicate already accepts.
 */
function scenarioPlayingOneBeat(
  scenarioId: string,
  revise: (beat: ScenarioBeat) => ScenarioBeat,
): Scenario {
  const openingBeat = CONCURRENT_STREAMING_SCENARIO.beats[0];
  if (openingBeat === undefined) {
    throw new Error(
      "the concurrent-streaming scenario plays no beats, so there is no beat to build from",
    );
  }
  return { ...CONCURRENT_STREAMING_SCENARIO, id: scenarioId, beats: [revise(openingBeat)] };
}

describe("scenario wire truth — the shape a beat's envelope and payload have to hold", () => {
  it("reports a beat whose kind no daemon emits", () => {
    // `run.started` is the defect this leg was written for: it reads exactly like a
    // real event, and the census has `run.starting` instead.
    const defects = findScenarioContractDefects([
      scenarioPlayingOneBeat("plays-an-unregistered-kind", (beat) => ({
        ...beat,
        event: { ...beat.event, kind: "run.started", payload: {} },
      })),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("not a registered event type");
  });

  it("reports a registered kind carrying a payload the strict layer rejects", () => {
    // The quieter half. Without this the payload leg could be skipping every beat and
    // the case above would still be green: `session.created` registers
    // `{sessionId, config, metadata}` and the variant is `.strict()`, so a `title`
    // member is a payload no daemon sends.
    const defects = findScenarioContractDefects([
      scenarioPlayingOneBeat("carries-an-unregistered-payload", (beat) => ({
        ...beat,
        event: { ...beat.event, kind: "session.created", payload: { title: "Rate-limit wiring" } },
      })),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("rejects this beat");
  });

  it("reports an identifier the branded id types do not accept", () => {
    // A readable identifier renders exactly like a real one and is rejected by every
    // branded schema the wire declares, so a scenario written from design notes rather
    // than from the contract fails at the first surface that parses it.
    const defects = findScenarioContractDefects([
      scenarioPlayingOneBeat("carries-a-readable-identifier", (beat) => ({
        ...beat,
        event: { ...beat.event, sessionId: "session-flagship" },
      })),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("rejects this beat");
  });

  it("reports a beat whose envelope id is empty", () => {
    // `EventEnvelope.id` is what every later read of an event's body is keyed by, and
    // an empty one resolves to nothing — a defect exactly as a bad `sessionId` is, and
    // one the predicate could not see while it minted an envelope id of its own.
    const defects = findScenarioContractDefects([
      scenarioPlayingOneBeat("carries-no-envelope-id", (beat) => ({
        ...beat,
        event: { ...beat.event, id: "" },
      })),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("rejects this beat");
  });

  it("reports a beat the canonical carrier rejects, on a kind the strict layer skips", () => {
    // The carrier leg's own control, put where only that leg reaches: the run
    // lifecycle kinds register no payload variant, so the strict layer reports nothing
    // for them and this beat used to pass silently. The defect is on `actorId`, a
    // canonical envelope member no run payload carries and no ordering rule reads — an
    // empty one is neither a user nor the system arm, which omits the key, so
    // the delivery would be counted unreadable and dropped, which in a fixture reads as
    // a beat that renders nothing.
    const runBeat = CONCURRENT_STREAMING_SCENARIO.beats.find(
      (beat) => beat.event.kind === "run.starting",
    );
    if (runBeat === undefined) {
      throw new Error(
        "the concurrent-streaming scenario plays no `run.starting` beat to build a case from",
      );
    }
    const defects = findScenarioContractDefects([
      {
        ...CONCURRENT_STREAMING_SCENARIO,
        id: "carries-an-empty-actor",
        beats: [
          {
            ...runBeat,
            atMs: 0,
            event: {
              ...runBeat.event,
              sequence: CONCURRENT_STREAMING_SCENARIO.beats[0]?.event.sequence ?? 1,
              actorId: "",
            },
          },
        ],
      },
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("the canonical envelope rejects this beat");
  });
});

describe("scenario wire truth — the state a queue beat says its row moved to", () => {
  /** The concurrent-streaming scenario's opening beat, replaced by a queue beat carrying the payload named. */
  function scenarioPlayingQueueBeat(
    scenarioId: string,
    eventKind: string,
    payload: Readonly<Record<string, unknown>>,
  ): Scenario {
    return scenarioPlayingOneBeat(scenarioId, (beat) => ({
      ...beat,
      event: { ...beat.event, kind: eventKind, payload },
    }));
  }

  it("reports a queue beat that names no state", () => {
    // Every other leg passes this beat: `queue_item.admitted` is a census row, the
    // canonical envelope carries it, and no payload variant is registered for any of
    // the queue kinds — so the omission was invisible, and the stream's projection
    // would have taken the row's state from the KIND alone and built a valid-looking
    // summary out of half a payload.
    const defects = findScenarioContractDefects([
      scenarioPlayingQueueBeat("names-no-queue-state", "queue_item.admitted", {
        sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
        queueItemId: CONTROL_QUEUE_ITEM_ID,
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("names no `state`");
  });

  it("reports a queue beat whose kind and payload name different states", () => {
    // The other half of the same rule, and the one the missing member used to skip
    // past: `queue_item.admitted` announces `admitted`, so a payload saying `queued` is
    // a row that moved two ways at once.
    const defects = findScenarioContractDefects([
      scenarioPlayingQueueBeat("names-two-queue-states", "queue_item.admitted", {
        sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
        queueItemId: CONTROL_QUEUE_ITEM_ID,
        state: "queued",
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("two queue states");
  });

  it("negative control: the same beat naming the state its kind announces is clean", () => {
    // Without it, a leg that reported every queue beat would pass both cases above and
    // no family could script a queue row at all. `queue_item.created` is the row that
    // proves the mapping is read and not guessed: its kind says `created` and the state
    // it announces is `queued`.
    expect(
      findScenarioContractDefects([
        scenarioPlayingQueueBeat("names-the-announced-state", "queue_item.created", {
          sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
          queueItemId: CONTROL_QUEUE_ITEM_ID,
          state: "queued",
        }),
      ]),
    ).toStrictEqual([]);
  });
});

describe("scenario wire truth — the caller a scenario answers its identity read with", () => {
  it("reports a stated caller who is not in the scenario's own user list", () => {
    // A caller outside the join order resolves to no user entry, so every
    // surface that attributes a row to this window silently attributes it to nobody —
    // a defect that renders as a session nobody is looking at rather than as anything
    // wrong.
    const defects = findScenarioContractDefects([
      {
        ...CONCURRENT_STREAMING_SCENARIO,
        id: "names-a-caller-it-never-joins",
        callerUserId: STRANGER_USER_ID,
      },
    ]);

    expect(defects.map((defect) => defect.subject)).toContain(`callerUserId "${STRANGER_USER_ID}"`);
    expect(defects.some((defect) => defect.reason.includes("userIdsInJoinOrder"))).toBe(true);
  });

  it("accepts a stated caller the scenario actually joins", () => {
    // The other arm, so the case above is a join-order check rather than a blanket
    // refusal of the field — which would make every scenario that states its caller
    // fail and read exactly the same here.
    expect(
      findScenarioContractDefects([
        {
          ...CONCURRENT_STREAMING_SCENARIO,
          id: "names-a-caller-it-joins",
          callerUserId: CONCURRENT_STREAMING_USER_ID,
        },
      ]),
    ).toStrictEqual([]);
  });
});
