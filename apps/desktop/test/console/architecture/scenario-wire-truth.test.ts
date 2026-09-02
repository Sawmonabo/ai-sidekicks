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
