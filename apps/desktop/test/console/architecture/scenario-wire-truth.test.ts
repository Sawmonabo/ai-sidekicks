// Every scenario the fixture can play is an event stream the daemon could emit.
//
// The tier is architecture rather than unit because the subject is not one
// module's behaviour: it is a property of the whole scenario MANIFEST, and it has
// to hold for files that do not exist yet. `bridge/scenarios/index.ts` is a seat
// board with one reserved line per view family, and six family branches are
// building against it concurrently. Each will land a scenario written from the
// same design notes the substrate's own two were written from — so each can land
// with the same defects, and the day a family's scenario joins that list is the
// day this test has to be the thing that says so.
//
// WHAT THE DEFECTS WERE, since a test that only reports "wire truth" teaches
// nobody. The substrate shipped two scenarios and both contradicted the contract:
// `run.started` for a type that is spelled `run.starting`; `participant.joined` for
// a type that does not exist at all (`membership.created` is the event a person
// joining produces); `session.created` carrying `{title}` against a `.strict()`
// payload that registers `{sessionId, config, metadata}`; `run.*` payloads carrying
// a bare `{runId}` where the wire carries a state transition and a progression
// counter; `agent.attached` carrying `displayName` where the member is `name`; and
// readable identifiers throughout where the branded id types declare UUIDs. Not one
// of them changed a rendering, which is exactly why they survived review — the
// console does not read those payloads yet. It will.
//
// THE PREDICATE IS IMPORTED, NEVER RESTATED. `bridge/scenarios/wire-truth.ts` owns
// it, and the negative controls below drive that same function: a test carrying its
// own copy of the rule would go green against a copy nobody ships.
//
// WHAT IS NOT HERE. What a subscriber RECEIVES when a scenario plays is
// `scenario-delivery-shape.test.ts`'s: a different claim, measured through the
// real bridge rather than over the declared beats.

import { describe, expect, it } from "vitest";

import { CONSOLE_SCENARIOS } from "../../../src/renderer/src/console/bridge/scenarios/index.js";
import { findScenarioWireTruthDefects } from "../../../src/renderer/src/console/bridge/scenarios/wire-truth.js";
import type { ConsoleScenario } from "../../../src/renderer/src/console/bridge/scenario.js";

/** A UUID the branded id types accept, so a control fails for its own reason. */
const CONTROL_SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a99a9";

/**
 * The daemon's opaque row id a control beat carries.
 *
 * Supplied by the SCENARIO rather than by the predicate. The probe used to mint a
 * fixed id of its own, which meant the one envelope member a scenario could get
 * wrong was the one member the check never saw — the last control below is what
 * that closes.
 */
const CONTROL_EVENT_ID = "019b79ee-0280-7ea1-8110-e5e0d1159901";

/** A run the transition controls below are about. */
const CONTROL_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1159901";

/** A queue row the queue-state controls below are about. */
const CONTROL_QUEUE_ITEM_ID = "019b79ee-0280-7c11-8110-d1a4c1159902";

/** One queue beat, over whatever payload the control under test wants to plant. */
function queueControlBeat(
  eventKind: string,
  payload: Readonly<Record<string, unknown>>,
): ConsoleScenario["beats"][number] {
  return {
    atMs: 0,
    event: {
      id: CONTROL_EVENT_ID,
      sessionId: CONTROL_SESSION_ID,
      sequence: 1,
      kind: eventKind,
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload,
    },
  };
}

/** The smallest well-formed scenario, so each control varies exactly one thing. */
function controlScenario(overrides: Partial<ConsoleScenario>): ConsoleScenario {
  return {
    id: "wire-truth-control",
    label: "Control",
    purpose: "Drives the shipped wire-truth predicate with one deliberate defect.",
    sessionId: CONTROL_SESSION_ID,
    participantIdsInJoinOrder: [],
    startedAtIso: "2026-01-01T00:00:00.000Z",
    beats: [],
    replies: [],
    ...overrides,
  };
}

/** The payload the strict layer registers for `session.created`. */
function validSessionCreatedPayload(): Readonly<Record<string, unknown>> {
  return { sessionId: CONTROL_SESSION_ID, config: {}, metadata: {} };
}

describe("scenario wire truth — every shipped scenario", () => {
  it("plays only registered event types, with the payloads those types register", () => {
    const defects = findScenarioWireTruthDefects(CONSOLE_SCENARIOS);

    // Printed in full rather than counted: a family reading this failure needs the
    // beat and the reason, not the number of things wrong.
    expect(
      defects.map((defect) => `${defect.scenarioId}: ${defect.subject} — ${defect.reason}`),
    ).toStrictEqual([]);
  });

  it("is measured against a manifest that actually has scenarios on it", () => {
    // Without this the case above passes vacuously the day the seat board is
    // emptied or the import resolves to something else.
    expect(CONSOLE_SCENARIOS.length).toBeGreaterThan(0);
    expect(CONSOLE_SCENARIOS.some((scenario) => scenario.beats.length > 0)).toBe(true);
  });
});

describe("scenario wire truth — the controls", () => {
  it("reports a beat whose kind no daemon emits", () => {
    // `run.started` is the defect this file was written for: it reads exactly like
    // a real event, and the census has `run.starting` instead.
    const defects = findScenarioWireTruthDefects([
      controlScenario({
        beats: [
          {
            atMs: 0,
            event: {
              id: CONTROL_EVENT_ID,
              sessionId: CONTROL_SESSION_ID,
              sequence: 1,
              kind: "run.started",
              occurredAt: "2026-01-01T00:00:00.000Z",
              payload: {},
            },
          },
        ],
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("not a registered event type");
  });

  it("reports a beat claiming a run moved to the state it was already in", () => {
    // Every member here is individually registered — `run.queued` is a census row,
    // and `queued` is a member of the run-state vocabulary twice over — so neither
    // the census leg nor the strict layer can see this one, and the strict layer
    // registers no variant for the run-lifecycle kinds at all. The transition table
    // is what rules it out: it has no row whose `From` and `To` are one state, so no
    // daemon emits this, and a surface built against it learns to render a
    // transition production never produces.
    const defects = findScenarioWireTruthDefects([
      controlScenario({
        beats: [
          {
            atMs: 0,
            event: {
              id: CONTROL_EVENT_ID,
              sessionId: CONTROL_SESSION_ID,
              sequence: 1,
              kind: "run.queued",
              occurredAt: "2026-01-01T00:00:00.000Z",
              payload: {
                sessionId: CONTROL_SESSION_ID,
                runId: CONTROL_RUN_ID,
                runVersion: 1,
                previousState: "queued",
                newState: "queued",
              },
            },
          },
        ],
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("the state it was already in");
  });

  it("negative control: the same beat naming a real transition is clean", () => {
    // Without it, a rule that reported every run beat would pass the case above —
    // and every scenario's run script would be unbuildable.
    const defects = findScenarioWireTruthDefects([
      controlScenario({
        beats: [
          {
            atMs: 0,
            event: {
              id: CONTROL_EVENT_ID,
              sessionId: CONTROL_SESSION_ID,
              sequence: 1,
              kind: "run.starting",
              occurredAt: "2026-01-01T00:00:00.000Z",
              payload: {
                sessionId: CONTROL_SESSION_ID,
                runId: CONTROL_RUN_ID,
                runVersion: 2,
                previousState: "queued",
                newState: "starting",
              },
            },
          },
        ],
      }),
    ]);

    expect(defects).toStrictEqual([]);
  });

  it("reports a queue beat that names no state", () => {
    // Every leg above passes this beat: `queue_item.admitted` is a census row, the
    // canonical envelope carries it, and the strict layer registers no variant for
    // any of the five queue kinds — so the omission was invisible, and the stream's
    // projection would have taken the row's state from the KIND alone and built a
    // valid-looking summary out of half a payload.
    const defects = findScenarioWireTruthDefects([
      controlScenario({
        beats: [
          queueControlBeat("queue_item.admitted", {
            sessionId: CONTROL_SESSION_ID,
            queueItemId: CONTROL_QUEUE_ITEM_ID,
          }),
        ],
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("names no `state`");
  });

  it("reports a queue beat whose kind and payload name different states", () => {
    // The other half of the same rule, and the one the missing member used to skip
    // past: `queue_item.admitted` announces `admitted`, so a payload saying `queued`
    // is a row that moved two ways at once.
    const defects = findScenarioWireTruthDefects([
      controlScenario({
        beats: [
          queueControlBeat("queue_item.admitted", {
            sessionId: CONTROL_SESSION_ID,
            queueItemId: CONTROL_QUEUE_ITEM_ID,
            state: "queued",
          }),
        ],
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("two queue states");
  });

  it("negative control: the same beat naming the state its kind announces is clean", () => {
    // Without it, a leg that reported every queue beat would pass both cases above,
    // and no family could script a queue row at all. `queue_item.created` is the row
    // that proves the mapping is read and not guessed: its kind says `created` and
    // the state it announces is `queued`.
    const defects = findScenarioWireTruthDefects([
      controlScenario({
        beats: [
          queueControlBeat("queue_item.created", {
            sessionId: CONTROL_SESSION_ID,
            queueItemId: CONTROL_QUEUE_ITEM_ID,
            state: "queued",
          }),
        ],
      }),
    ]);

    expect(defects).toStrictEqual([]);
  });

  it("reports a registered kind carrying a payload the strict layer rejects", () => {
    // The quieter half. Without this control the payload leg could be skipping
    // every beat and the case above would still be green.
    const defects = findScenarioWireTruthDefects([
      controlScenario({
        beats: [
          {
            atMs: 0,
            event: {
              id: CONTROL_EVENT_ID,
              sessionId: CONTROL_SESSION_ID,
              sequence: 1,
              kind: "session.created",
              occurredAt: "2026-01-01T00:00:00.000Z",
              payload: { title: "Rate-limit wiring" },
            },
          },
        ],
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("rejects this beat");
  });

  it("reports an identifier the branded id types do not accept", () => {
    const defects = findScenarioWireTruthDefects([
      controlScenario({
        sessionId: "session-flagship",
        beats: [
          {
            atMs: 0,
            event: {
              id: CONTROL_EVENT_ID,
              sessionId: "session-flagship",
              sequence: 1,
              kind: "session.created",
              occurredAt: "2026-01-01T00:00:00.000Z",
              payload: { sessionId: "session-flagship", config: {}, metadata: {} },
            },
          },
        ],
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("rejects this beat");
  });

  it("reports a beat the canonical carrier rejects, on a kind the strict layer skips", () => {
    // The carrier leg's own control, and it is planted where only that leg reaches:
    // `run.starting` has no registered payload variant, so the strict layer reports
    // nothing but the unmatched discriminator and this beat used to pass silently.
    // A negative `sequence` is not a position any event can occupy — the store's
    // cursor and gap detection key on it — so the delivery would be counted
    // unreadable and dropped, which in a fixture reads as a beat that renders
    // nothing.
    const defects = findScenarioWireTruthDefects([
      controlScenario({
        beats: [
          {
            atMs: 0,
            event: {
              id: CONTROL_EVENT_ID,
              sessionId: CONTROL_SESSION_ID,
              sequence: -1,
              kind: "run.starting",
              occurredAt: "2026-01-01T00:00:00.000Z",
              payload: {},
            },
          },
        ],
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("the canonical envelope rejects this beat");
  });

  it("reports a beat due before the beat in front of it", () => {
    // `beats` is an ordered script, and the engine consumes the contiguous prefix
    // that has fallen due — so an entry written behind a later-due one is
    // delivered later than the tick it names. It used to pass silently, and the
    // screenshot and endurance tiers pin frames by advancing to an exact tick.
    const defects = findScenarioWireTruthDefects([
      controlScenario({
        beats: [
          {
            atMs: 200,
            event: {
              id: CONTROL_EVENT_ID,
              sessionId: CONTROL_SESSION_ID,
              sequence: 1,
              kind: "run.starting",
              occurredAt: "2026-01-01T00:00:00.200Z",
              payload: {},
            },
          },
          {
            atMs: 20,
            event: {
              id: CONTROL_EVENT_ID,
              sessionId: CONTROL_SESSION_ID,
              sequence: 2,
              kind: "run.running",
              occurredAt: "2026-01-01T00:00:00.020Z",
              payload: {},
            },
          },
        ],
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe("beat 1 (run.running)");
    expect(defects[0]?.reason).toContain("before the beat in front of it");
  });

  it("accepts two beats scripted at one tick, which is ordinary rather than a defect", () => {
    // The other arm: nondecreasing, not strictly increasing. Without this the case
    // above could be a blanket refusal of equal ticks, which every scenario that
    // scripts an event and the transition it triggers would then fail.
    const defects = findScenarioWireTruthDefects([
      controlScenario({
        beats: [
          {
            atMs: 40,
            event: {
              id: CONTROL_EVENT_ID,
              sessionId: CONTROL_SESSION_ID,
              sequence: 1,
              kind: "run.starting",
              occurredAt: "2026-01-01T00:00:00.040Z",
              payload: {},
            },
          },
          {
            atMs: 40,
            event: {
              id: CONTROL_EVENT_ID,
              sessionId: CONTROL_SESSION_ID,
              sequence: 2,
              kind: "run.running",
              occurredAt: "2026-01-01T00:00:00.040Z",
              payload: {},
            },
          },
        ],
      }),
    ]);

    expect(defects).toStrictEqual([]);
  });

  it("reports a second reply for a call another reply already claims", () => {
    const defects = findScenarioWireTruthDefects([
      controlScenario({
        replies: [
          { call: "agent.list", result: { agents: [] } },
          { call: "agent.list", result: { agents: [] } },
        ],
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe('reply "agent.list"');
  });

  it("reports a stated viewer who is not in the scenario's own roster", () => {
    // The identity the fixture answers `callerParticipantRead` from. A viewer
    // outside the join order resolves to no roster entry, so every surface that
    // reads a role from it silently gets none — a defect that renders as a member
    // with no elevated permissions rather than as anything wrong.
    const stranger = "019b79ee-0280-79a4-8110-cca0117a9999";
    const member = "019b79ee-0280-79a4-8110-cca0117a0110";

    const defects = findScenarioWireTruthDefects([
      controlScenario({ participantIdsInJoinOrder: [member], viewingParticipantId: stranger }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain(stranger);
    expect(defects[0]?.reason).toContain("participantIdsInJoinOrder");
  });

  it("accepts a stated viewer the scenario actually joins", () => {
    // The other arm, so the case above is a membership check rather than a blanket
    // refusal of the field — which would have made every scenario that states its
    // viewer fail and read exactly the same in this file.
    const member = "019b79ee-0280-79a4-8110-cca0117a0110";

    const defects = findScenarioWireTruthDefects([
      controlScenario({ participantIdsInJoinOrder: [member], viewingParticipantId: member }),
    ]);

    expect(defects).toStrictEqual([]);
  });

  it("reports a beat whose envelope id is empty, which the probe used to supply for it", () => {
    // The leg this file could not have: the wire-truth probe minted its own
    // envelope id, so a scenario carrying an unusable one was measured against a
    // good one the predicate had substituted. `EventEnvelope.id` is what every
    // later read of an event's body is keyed by, and an empty one resolves to
    // nothing — it is a defect exactly as a bad `sessionId` is.
    const defects = findScenarioWireTruthDefects([
      controlScenario({
        beats: [
          {
            atMs: 0,
            event: {
              id: "",
              sessionId: CONTROL_SESSION_ID,
              sequence: 1,
              kind: "session.created",
              occurredAt: "2026-01-01T00:00:00.000Z",
              payload: validSessionCreatedPayload(),
            },
          },
        ],
      }),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("rejects this beat");
  });

  it("passes a control that carries no defect at all", () => {
    // The positive control. Every case above asserts that something is REPORTED;
    // this one asserts the predicate can also stay silent, so a function that
    // reported one defect per beat unconditionally could not pass this file.
    const defects = findScenarioWireTruthDefects([
      controlScenario({
        beats: [
          {
            atMs: 0,
            event: {
              id: CONTROL_EVENT_ID,
              sessionId: CONTROL_SESSION_ID,
              sequence: 1,
              kind: "session.created",
              occurredAt: "2026-01-01T00:00:00.000Z",
              payload: validSessionCreatedPayload(),
            },
          },
          {
            atMs: 10,
            event: {
              id: CONTROL_EVENT_ID,
              sessionId: CONTROL_SESSION_ID,
              sequence: 2,
              // A registered type the strict layer has no payload variant for yet.
              // It is held to the census leg and no further, which is what keeps
              // this test from demanding schemas Plan-006 has not shipped.
              kind: "run.starting",
              occurredAt: "2026-01-01T00:00:00.010Z",
              payload: { runId: CONTROL_SESSION_ID, runVersion: 1 },
            },
          },
        ],
        replies: [{ call: "agent.list", result: { agents: [] } }],
      }),
    ]);

    expect(defects).toStrictEqual([]);
  });
});
