// The predicate's membership-role legs, and the one scenario property it cannot carry.
//
// A PER-LEG CONTROL FOR THE ROLES A SCENARIO DECLARES. Each case drives the same
// imported predicate over a real scenario with one deliberate defect, and never a local
// copy of the rule.
//
// AND ONE PROPERTY THE PREDICATE DELIBERATELY DOES NOT CHECK. A scenario that names a
// viewer and declares no role for them serves a successful identity read into a roster
// that resolves nothing — the exact state the fixture was in for every scenario before
// the base state carried memberships. It is not a wire-truth defect here because the
// shipped scenarios that declare no roles at all would each fire it; it is asserted
// below over the shipped seat board instead, and it moves into the predicate the day
// those scenarios gain a role.
//
// THE OTHER AXES ARE BESIDE THIS FILE, ONE PER MODULE THEY COVER, on the
// `fixture-growth-port.*.test.ts` precedent: `wire-truth.run-beats.test.ts` for the
// run and rollback semantics, and `wire-truth.beat-order.test.ts` for the tick and log
// position. Every one of them drives the aggregate entry rather than a leg directly,
// because the aggregate is the only surface a family's scenario is measured through.

import { describe, expect, it } from "vitest";

import { CONSOLE_SCENARIOS } from "./index.js";
import { FLAGSHIP_SCENARIO } from "./flagship.js";
import { findScenarioWireTruthDefects } from "./wire-truth.js";
import type { ConsoleScenario, ScenarioBeat } from "../scenario-runtime/scenario.js";

/** Someone this session never joins, spelled as the branded id type declares. */
const STRANGER_PARTICIPANT_ID = "019b79ee-0280-79a4-8110-cca0117a9999";

/** The flagship's stated viewer, which the misdeclared-role case declares against. */
const FLAGSHIP_VIEWER = FLAGSHIP_SCENARIO.viewingParticipantId ?? "";

describe("scenario wire truth — the memberships a scenario declares", () => {
  it("accepts the shipped seat board, roles and all", () => {
    expect(
      findScenarioWireTruthDefects(CONSOLE_SCENARIOS).map(
        (defect) => `${defect.scenarioId}: ${defect.subject} — ${defect.reason}`,
      ),
    ).toStrictEqual([]);
  });

  it("reports a role declared for someone the scenario never joins", () => {
    // The roster and the hue wheel would then disagree about who is in the room, and
    // the entry could only be reached by a lookup no surface performs.
    const defects = findScenarioWireTruthDefects([
      {
        ...FLAGSHIP_SCENARIO,
        id: "declares-a-stranger",
        membershipRoleByParticipantId: {
          ...FLAGSHIP_SCENARIO.membershipRoleByParticipantId,
          [STRANGER_PARTICIPANT_ID]: "collaborator",
        },
      },
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toContain(STRANGER_PARTICIPANT_ID);
  });

  it("reports a role the contract does not register, which reads back as no role", () => {
    // The quiet half. `membershipRoleOf` parses and answers `undefined` for anything
    // the schema rejects, so an unregistered role renders exactly like a member whose
    // role went unread — which is why the cast below has to be caught here.
    // Widened to the wire's own key type before the assertion, because the defect
    // being planted is a value the field's own type forbids — which is how it reaches
    // the predicate in life too: a scenario is data, authored from design notes and
    // cast into shape, and the predicate is what stands between that and a surface.
    const unregisteredRoles: Readonly<Record<string, string>> = { [FLAGSHIP_VIEWER]: "admin" };
    const misdeclaredRole = {
      ...FLAGSHIP_SCENARIO,
      id: "declares-an-unregistered-role",
      membershipRoleByParticipantId: unregisteredRoles,
    } as ConsoleScenario;

    const defects = findScenarioWireTruthDefects([misdeclaredRole]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("MembershipRole");
  });
});

describe("every shipped scenario that names its viewer names that viewer's role", () => {
  it("declares a role for the identity the fixture answers with", () => {
    expect(scenariosNamingARolelessViewer(CONSOLE_SCENARIOS)).toStrictEqual([]);
  });

  it("negative control: reports a scenario that names one and no role", () => {
    const { membershipRoleByParticipantId: _declaredRoles, ...withoutRoles } = FLAGSHIP_SCENARIO;
    const rolelessViewer: ConsoleScenario = { ...withoutRoles, id: "states-no-role" };

    expect(scenariosNamingARolelessViewer([rolelessViewer])).toStrictEqual(["states-no-role"]);
  });
});

/**
 * Scenarios naming a viewer the roster declares no membership role for.
 *
 * A viewer is what the caller-identity read answers with and a role is what every
 * gated control resolves from it, so a scenario carrying the first without the second
 * serves a successful read no surface can act on.
 */
function scenariosNamingARolelessViewer(scenarios: readonly ConsoleScenario[]): readonly string[] {
  return scenarios
    .filter((scenario) => {
      const { viewingParticipantId } = scenario;
      if (viewingParticipantId === undefined) {
        return false;
      }
      return (scenario.membershipRoleByParticipantId ?? {})[viewingParticipantId] === undefined;
    })
    .map((scenario) => scenario.id);
}

/** A queue row the queue-state cases below are about, spelled as its branded id declares. */
const CONTROL_QUEUE_ITEM_ID = "019b79ee-0280-7c11-8110-d1a4c1159902";

/** Someone the flagship joins, so a viewer case varies the viewer and nothing else. */
const FLAGSHIP_MEMBER_ID = FLAGSHIP_SCENARIO.participantIdsInJoinOrder[0] ?? "";

/**
 * The flagship playing exactly ONE beat, built from its own opening beat.
 *
 * A single beat is what every case below is about, and starting from the seat board's
 * own means the envelope members a case does not touch — the session it travels on,
 * the log position it opens at, the actor — are ones the predicate already accepts.
 */
function scenarioPlayingOneBeat(
  scenarioId: string,
  revise: (beat: ScenarioBeat) => ScenarioBeat,
): ConsoleScenario {
  const openingBeat = FLAGSHIP_SCENARIO.beats[0];
  if (openingBeat === undefined) {
    throw new Error("the flagship scenario plays no beats, so there is no beat to build from");
  }
  return { ...FLAGSHIP_SCENARIO, id: scenarioId, beats: [revise(openingBeat)] };
}

describe("scenario wire truth — the shape a beat's envelope and payload have to hold", () => {
  it("reports a beat whose kind no daemon emits", () => {
    // `run.started` is the defect this leg was written for: it reads exactly like a
    // real event, and the census has `run.starting` instead.
    const defects = findScenarioWireTruthDefects([
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
    const defects = findScenarioWireTruthDefects([
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
    const defects = findScenarioWireTruthDefects([
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
    const defects = findScenarioWireTruthDefects([
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
    // empty one is neither a participant nor the system arm, which omits the key, so
    // the delivery would be counted unreadable and dropped, which in a fixture reads as
    // a beat that renders nothing.
    const runBeat = FLAGSHIP_SCENARIO.beats.find((beat) => beat.event.kind === "run.starting");
    if (runBeat === undefined) {
      throw new Error("the flagship scenario plays no `run.starting` beat to build a case from");
    }
    const defects = findScenarioWireTruthDefects([
      {
        ...FLAGSHIP_SCENARIO,
        id: "carries-an-empty-actor",
        beats: [
          {
            ...runBeat,
            atMs: 0,
            event: {
              ...runBeat.event,
              sequence: FLAGSHIP_SCENARIO.beats[0]?.event.sequence ?? 1,
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
  /** The flagship's opening beat, replaced by a queue beat carrying the payload named. */
  function scenarioPlayingQueueBeat(
    scenarioId: string,
    eventKind: string,
    payload: Readonly<Record<string, unknown>>,
  ): ConsoleScenario {
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
    const defects = findScenarioWireTruthDefects([
      scenarioPlayingQueueBeat("names-no-queue-state", "queue_item.admitted", {
        sessionId: FLAGSHIP_SCENARIO.sessionId,
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
    const defects = findScenarioWireTruthDefects([
      scenarioPlayingQueueBeat("names-two-queue-states", "queue_item.admitted", {
        sessionId: FLAGSHIP_SCENARIO.sessionId,
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
      findScenarioWireTruthDefects([
        scenarioPlayingQueueBeat("names-the-announced-state", "queue_item.created", {
          sessionId: FLAGSHIP_SCENARIO.sessionId,
          queueItemId: CONTROL_QUEUE_ITEM_ID,
          state: "queued",
        }),
      ]),
    ).toStrictEqual([]);
  });
});

describe("scenario wire truth — the viewer a scenario answers its identity read with", () => {
  it("reports a stated viewer who is not in the scenario's own roster", () => {
    // A viewer outside the join order resolves to no roster entry, so every surface
    // that reads a role from it silently gets none — a defect that renders as a member
    // with no elevated permissions rather than as anything wrong.
    const defects = findScenarioWireTruthDefects([
      {
        ...FLAGSHIP_SCENARIO,
        id: "names-a-viewer-it-never-joins",
        viewingParticipantId: STRANGER_PARTICIPANT_ID,
        membershipRoleByParticipantId: {
          ...FLAGSHIP_SCENARIO.membershipRoleByParticipantId,
          [STRANGER_PARTICIPANT_ID]: "collaborator",
        },
      },
    ]);

    expect(defects.map((defect) => defect.subject)).toContain(
      `viewingParticipantId "${STRANGER_PARTICIPANT_ID}"`,
    );
    expect(defects.some((defect) => defect.reason.includes("participantIdsInJoinOrder"))).toBe(
      true,
    );
  });

  it("accepts a stated viewer the scenario actually joins", () => {
    // The other arm, so the case above is a membership check rather than a blanket
    // refusal of the field — which would make every scenario that states its viewer
    // fail and read exactly the same here.
    expect(
      findScenarioWireTruthDefects([
        {
          ...FLAGSHIP_SCENARIO,
          id: "names-a-viewer-it-joins",
          viewingParticipantId: FLAGSHIP_MEMBER_ID,
        },
      ]),
    ).toStrictEqual([]);
  });
});
