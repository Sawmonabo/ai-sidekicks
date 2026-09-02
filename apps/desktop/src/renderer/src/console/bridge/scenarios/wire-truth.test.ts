// The predicate's membership-role legs, and the one scenario property it cannot carry.
//
// WHY THIS FILE EXISTS BESIDE THE ARCHITECTURE TIER'S. That tier owns the property
// this predicate is FOR — every scenario on the seat board is an event stream the
// daemon could emit — and drives the shipped function with controls of its own. What
// it does not have is a per-leg control for the roles a scenario declares, so these
// are those: each drives the same imported predicate over a real scenario with one
// deliberate defect, and never a local copy of the rule.
//
// AND ONE PROPERTY THE PREDICATE DELIBERATELY DOES NOT CHECK. A scenario that names a
// viewer and declares no role for them serves a successful identity read into a roster
// that resolves nothing — the exact state the fixture was in for every scenario before
// the base state carried memberships. It is not a wire-truth defect here because the
// architecture tier's controls pin exact defect counts for scenarios that declare no
// roles at all, and this leg would fire on two of them; it is asserted below over the
// shipped seat board instead, and it moves into the predicate the day those controls
// gain a role.

import { describe, expect, it } from "vitest";

import { CONSOLE_SCENARIOS } from "./index.js";
import { FIRST_RUN_SCENARIO } from "./first-run.js";
import { FLAGSHIP_SCENARIO } from "./flagship.js";
import { findScenarioWireTruthDefects } from "./wire-truth.js";
import type { ConsoleScenario } from "../scenario.js";

/** Someone this session never joins, spelled as the branded id type declares. */
const STRANGER_PARTICIPANT_ID = "019b79ee-0280-79a4-8110-cca0117a9999";

/** A session the branded schema accepts that is not the one the flagship's beats travel on. */
const STRANGER_SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a7777";

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

describe("scenario wire truth — the log position a scenario opens at", () => {
  /** The flagship's beats, every position shifted by the same amount. */
  function scenarioOpeningAt(scenarioId: string, firstPosition: number): ConsoleScenario {
    const openingBeat = FLAGSHIP_SCENARIO.beats[0];
    if (openingBeat === undefined) {
      throw new Error("the flagship scenario plays no beats, so there is nothing to shift");
    }
    const shift = firstPosition - openingBeat.event.sequence;
    return {
      ...FLAGSHIP_SCENARIO,
      id: scenarioId,
      beats: FLAGSHIP_SCENARIO.beats.map((beat) => ({
        ...beat,
        event: { ...beat.event, sequence: beat.event.sequence + shift },
      })),
    };
  }

  it("reports a single-beat scenario that opens anywhere but the first position", () => {
    // The case contiguity could never reach: with one beat there is no pair to
    // compare, so the old walk skipped it entirely and a script opening at 2 shipped
    // green while the store read position 1 as a row it had lost.
    const openingBeat = FIRST_RUN_SCENARIO.beats[0];
    if (openingBeat === undefined) {
      throw new Error("the first-run scenario plays no beats, so there is nothing to shift");
    }
    const defects = findScenarioWireTruthDefects([
      {
        ...FIRST_RUN_SCENARIO,
        id: "opens-at-two-with-one-beat",
        beats: [{ ...openingBeat, event: { ...openingBeat.event, sequence: 2 } }],
      },
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe("beat 0 (session.created)");
    expect(defects[0]?.reason).toContain("opens the script at log position 2");
  });

  it("reports a contiguous multi-beat scenario that starts late, naming its first beat", () => {
    // Contiguous throughout, so every pair-wise check passes and the only thing
    // wrong is where the run begins — which is the subject the defect has to name,
    // because shifting the whole script is the fix and beat 1 is not the culprit.
    const defects = findScenarioWireTruthDefects([scenarioOpeningAt("opens-at-three", 3)]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe("beat 0 (session.created)");
    expect(defects[0]?.reason).toContain("first delivered position is 1");
  });

  it("negative control: the same script opening at the first position is clean", () => {
    // Without it both cases above would hold over a rule that reported every opening
    // beat, and no scenario could be scripted at all. The shift is a no-op here, so
    // what is measured is the position and nothing else about the beats.
    expect(findScenarioWireTruthDefects([scenarioOpeningAt("opens-at-one", 1)])).toStrictEqual([]);
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
