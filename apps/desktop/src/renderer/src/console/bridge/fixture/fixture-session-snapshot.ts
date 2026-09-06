// The base state the fixture's session read establishes.
//
// Beside `fixture-growth-port.ts` on the same terms its three other neighbours are:
// the DECISION — which operations are served — is declared in
// `fixture-served-operations.ts` and composed by the port, while each answer with a
// job of its own lives here, because each fails in a way the decision cannot.
// `fixture-session-directory.ts` derives what the node HAS; this one derives what one
// session already CONTAINS at the moment a store opens on it.
//
// WHAT THE BASE STATE HONESTLY IS
//
// Cursor zero, the session's roster, and the memberships that roster holds. Zero
// rather than a position derived from the scenario's beats, because a base state
// ahead of the stream would make the store discard every beat below it; the
// subscription is replay-then-tail, so nothing is missed by starting at the bottom. A
// re-read therefore lands behind an initialised store's cursor and is a silent no-op,
// which is `SessionStore.admitsSnapshotAt`'s documented behaviour and not a defect of
// this derivation: repairing a degraded store needs a read that carries a position,
// and this one cannot until the wire does.
//
// WHY THE ROSTER IS IN THE BASE STATE AND NOT PROJECTED FROM A BEAT
//
// Because it is the only place it CAN be, and because it is where the daemon puts it
// too. `SessionStore.initialise` merges a snapshot's entities into the partitions
// directly, which is the one path into the store that needs no registered projector —
// and the console registers none for `membership.*`: the composition root installs
// `RUN_LIFECYCLE_PROJECTORS` and nothing else, and participant projection belongs to
// the collaboration family, which owns those surfaces and has not landed yet. So a
// fixture that left the roster to a beat would be waiting on a projector nobody has
// written, and every role-gated control would render closed against a store that had
// never held a participant.
//
// It is also not a liberty the snapshot was not already taking. `participantJoinLog`
// has always carried the WHOLE roster at cursor zero, including people whose
// `membership.created` beat has not been delivered yet — because hue allocation keys
// on join order and a wheel allocated one member at a time would recolour the session
// as it loaded. The join order and the roles are two facts about one roster, and this
// carries the second on the same terms as the first.
//
// The day the collaboration family registers a `membership.*` projector, nothing here
// changes and nothing here competes with it: this establishes the roster the session
// opens with, and the projector folds the changes that arrive afterwards onto it
// through the same merge.
//
// WHY ONLY A DECLARED MEMBERSHIP BECOMES A PARTICIPANT ENTITY
//
// A scenario's join order holds everything that gets a hue, agents included, and an
// agent is attached rather than admitted — it holds no membership and no role. Filing
// one under the `participant` partition would put a row in front of `membershipRoleOf`
// that resolves to no role and reads exactly like a member whose role went unread. So
// the members are exactly the ids `membershipRoleByParticipantId` names, and an id in
// the join order with no entry contributes nothing rather than an empty row.
//
// NOTHING IS INVENTED ONTO THE ROW EITHER. `MembershipSummary` registers a membership
// id and a `MembershipState` beside the role, and a scenario states neither, so
// neither is here: a `state: "active"` supplied by this module would be a default
// presented as a reading, which is the one thing the fixture must not do.

import type { MembershipSummary } from "@ai-sidekicks/contracts";

import type { ConsoleScenario } from "../scenario-runtime/index.js";
import type { SessionSnapshot } from "../../store/index.js";

/**
 * One entity a snapshot carries, derived from the snapshot rather than named again.
 *
 * The store family publishes `SessionSnapshot` through its door and not the element
 * type, and a second declaration of that shape here would be one this module could
 * keep compiling against after the family moved it.
 */
type SnapshotEntity = SessionSnapshot["entities"][number];

/** The body a participant row carries its role on, spelled as the wire spells it. */
type ParticipantEntityBody = Pick<MembershipSummary, "role">;

/**
 * The base state one scenario establishes for one session.
 *
 * Scoped to the session the scenario is PLAYING, and the scoping is the same rule the
 * join log has always been under rather than a new one: a roster is a fact about one
 * session, and lending this session's to another would colour a stranger's rows as if
 * they were hers and hand a surface a role in a session it may not even be a member
 * of. Another id therefore reads as an empty session rather than as a refusal — the
 * read IS answered, and what it found for that session is nothing.
 */
export function fixtureSessionSnapshot(
  scenario: ConsoleScenario,
  sessionId: string,
): SessionSnapshot {
  if (sessionId !== scenario.sessionId) {
    return { cursor: BASE_STATE_CURSOR, entities: [], participantJoinLog: [] };
  }
  return {
    cursor: BASE_STATE_CURSOR,
    entities: participantEntitiesOf(scenario),
    participantJoinLog: scenario.participantIdsInJoinOrder,
  };
}

/**
 * The position the fixture's read answers at. See the header for why it is the bottom
 * of the stream rather than the top. Exported for one reader: the scenario wire-truth
 * walk derives the first admissible beat position from it, so the two cannot drift.
 */
export const BASE_STATE_CURSOR = 0;

/**
 * One participant entity per declared membership, in join order.
 *
 * Ordered by the join log rather than by the role map's own key order: the partition
 * is keyed, so order changes no lookup, but it is what a reader walking the map in a
 * debugger sees — and a roster that reads in a different order from the hue wheel is
 * a discrepancy someone has to rule out before they can trust either.
 */
function participantEntitiesOf(scenario: ConsoleScenario): readonly SnapshotEntity[] {
  const roleByParticipantId = scenario.membershipRoleByParticipantId ?? {};
  const entities: SnapshotEntity[] = [];
  for (const participantId of scenario.participantIdsInJoinOrder) {
    const role = roleByParticipantId[participantId];
    if (role === undefined) {
      continue;
    }
    const body: ParticipantEntityBody = { role };
    entities.push({ kind: "participant", id: participantId, body });
  }
  return entities;
}
