// The predicate's beat, queue and caller legs, driven through the aggregate entry.
//
// Each case drives the imported predicate over a real scenario with one deliberate defect, never a
// local copy of the rule. The other axes are in `run-and-queue-semantics.test.ts`,
// `beat-order.test.ts` and `reply-checks.test.ts`.

import { describe, expect, it } from "vitest";

import { SCENARIOS } from "../../../fixtures/index.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../fixtures/scenarios/concurrent-streaming.js";
import { findScenarioContractDefects } from "./contract-check.js";
import type { Scenario, ScenarioBeat } from "../../../fixtures/scenario.js";

/** Someone this session never joins, spelled as the branded id type declares. */
const STRANGER_USER_ID = "019b79ee-0280-79a4-8110-cca0117a9999";

describe("scenario wire truth — the shipped scenarios", () => {
  it("accepts every scenario a feature has landed in the registry", () => {
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
 * The concurrent-streaming scenario playing exactly one beat, built from its own opening beat.
 *
 * Starting from the shipped beat keeps every envelope member a case does not touch (session, log
 * position, actor) one the predicate already accepts.
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
    // `run.started` reads like a real event; the census has `run.starting`.
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
    // Without this the payload leg could skip every beat and the case above stay green.
    // `session.created`'s variant is `.strict()`, so a `title` member is a payload no daemon sends.
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
    // A readable identifier renders like a real one but every branded schema rejects it.
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
    // `EventEnvelope.id` keys every later read of an event's body, and an empty one resolves to
    // nothing.
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
    // The carrier leg's own control, on a kind the strict layer skips (run lifecycle kinds register
    // no variant). An empty `actorId` is neither a user nor the system arm, so the console would
    // count the delivery unreadable and drop it.
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
  /** The concurrent-streaming scenario's opening beat, replaced by a queue beat with `payload`. */
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
    // Every other leg passes this beat, and the projection would take the row's state from the
    // kind alone.
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
    // `queue_item.admitted` announces `admitted`, so a payload saying `queued` is a row that moved
    // two ways at once.
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
    // Without it a leg reporting every queue beat would pass both cases above. `queue_item.created`
    // announces `queued`, which proves the mapping is read and not guessed.
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
    // A caller outside the join order resolves to no user, so rows are attributed to nobody.
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
    // The other arm, so the case above is a join-order check and not a refusal of the field.
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
