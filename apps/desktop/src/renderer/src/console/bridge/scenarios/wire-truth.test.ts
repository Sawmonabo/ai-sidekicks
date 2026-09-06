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
import type { ConsoleScenario } from "../scenario-runtime/scenario.js";

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
