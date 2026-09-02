// The viewer a scenario states, and the roles it declares for the people in it.
//
// Two claims about the same roster, so one module: the viewer is what the identity
// read answers with and a role is what every gated control resolves from it, and both
// defects render as nothing at all rather than as anything wrong.

import { MembershipRoleSchema } from "@ai-sidekicks/contracts";

import type { ScenarioWireTruthDefect } from "./defect.js";
import type { ConsoleScenario } from "../../scenario.js";

/**
 * A stated viewer who is not in the roster, or `undefined` when the scenario is sound.
 *
 * `viewingParticipantId` is the one field a surface resolves a ROLE from, and it
 * resolves it by looking the id up in the session's own participant projection. An id
 * outside `participantIdsInJoinOrder` therefore resolves to nothing, and a surface
 * handed one either renders a role gate closed for a member who has it or renders it
 * open for a stranger — neither of which is visible in the fixture, because both look
 * exactly like a session whose viewer simply has no elevated role.
 *
 * Scoped to scenarios that STATE one: an absent viewer is the deliberate state the
 * fixture refuses the caller-identity read from, not a defect.
 */
export function describeViewerDefect(
  scenario: ConsoleScenario,
): ScenarioWireTruthDefect | undefined {
  const { viewingParticipantId } = scenario;
  if (viewingParticipantId === undefined) {
    return undefined;
  }
  if (scenario.participantIdsInJoinOrder.includes(viewingParticipantId)) {
    return undefined;
  }
  return {
    scenarioId: scenario.id,
    subject: `viewingParticipantId "${viewingParticipantId}"`,
    reason:
      "the stated viewer is not in `participantIdsInJoinOrder`, so no surface can " +
      "resolve their role from this session's roster. Name a participant the " +
      "scenario actually joins, or leave the field absent and let the caller-identity " +
      "read refuse.",
  };
}

/**
 * Declared memberships that name someone the scenario never joins, or a role the
 * contract does not register.
 *
 * `membershipRoleByParticipantId` is the fact every role gate resolves through: the
 * fixture's session read turns each entry into a `participant` row and
 * `store/selectors.ts`'s `membershipRoleOf` reads the role back off it. Both legs
 * therefore catch a defect that renders as nothing at all.
 *
 *   • A key outside `participantIdsInJoinOrder` mints a roster row for someone the
 *     session has no join order position for — so the hue wheel and the roster
 *     disagree about who is in the room, and the entry can only ever be reached by a
 *     lookup no surface performs.
 *   • A role the contract does not register is parsed back as ABSENT rather than as
 *     wrong: `membershipRoleOf` returns `undefined` for anything
 *     `MembershipRoleSchema` rejects, so a scenario writing `"admin"` produces a
 *     member with no role and looks identical to one whose role went unread.
 *
 * The second leg is not made redundant by the field's type. A scenario is data, and
 * data reaches this predicate from files that were authored against design notes and
 * cast into shape; a scenario's beats are typed too, and are parsed for the same
 * reason.
 */
export function findMembershipRoleDefects(
  scenario: ConsoleScenario,
): readonly ScenarioWireTruthDefect[] {
  const defects: ScenarioWireTruthDefect[] = [];
  for (const [participantId, role] of Object.entries(
    scenario.membershipRoleByParticipantId ?? {},
  )) {
    const subject = `membershipRoleByParticipantId["${participantId}"]`;
    if (!scenario.participantIdsInJoinOrder.includes(participantId)) {
      defects.push({
        scenarioId: scenario.id,
        subject,
        reason:
          "a role is declared for someone this scenario never joins, so the roster and " +
          "the hue wheel disagree about who is in the room and no surface can reach the " +
          "entry. Add the participant to `participantIdsInJoinOrder`, or drop the role.",
      });
      continue;
    }
    if (!MembershipRoleSchema.safeParse(role).success) {
      defects.push({
        scenarioId: scenario.id,
        subject,
        reason:
          `"${role}" is not a registered \`MembershipRole\`, and the roster lookup reads an ` +
          "unregistered role as no role at all — so this renders as a member whose role " +
          "went unread rather than as anything wrong. Use one of the registered roles.",
      });
    }
  }
  return defects;
}
