// Who holds a membership in this session, at the instant the question is asked.
//
// THE OPENING ROSTER IS THE WHOLE OF IT. `session-snapshot.ts` derives what a session
// already CONTAINS when a store opens on it — the roster the scenario declares, entity
// for entity, at cursor zero — and the event census registers no `membership.*` frame
// that could move it, so there is nothing to fold on top. A count that consulted the
// delivered log would be reading a family of frames no producer emits.
//
// ONE READER for the whole fixture's channel plane — the act that records how many
// people a create put in a channel, and the directory fold that answers for a creation
// no act of this fixture performed — because two counts of one roster are free to
// disagree about who is in it.

import { fixtureSessionSnapshot } from "./session-snapshot.js";
import type { ScenarioEngine } from "../../scenario/runtime/index.js";

/**
 * How many PEOPLE hold a membership in one session, as this playback has been told.
 *
 * Counted off the snapshot's participant ENTITIES rather than off the join log, and the
 * difference is the agents: the join order holds everything that gets a hue, and an
 * agent is attached rather than admitted, so it appears there and holds no membership.
 * A channel's `participantCount` counts people.
 *
 * Scoped to the session asked about, which is what keeps a read addressed elsewhere
 * from collecting this room's roster — the same scoping `fixtureSessionSnapshot`
 * applies to the opening term.
 */
export function fixtureSessionMembershipCount(engine: ScenarioEngine, sessionId: string): number {
  let count = 0;
  for (const entity of fixtureSessionSnapshot(engine.scenario, sessionId).entities) {
    if (entity.kind === "participant") {
      count += 1;
    }
  }
  return count;
}
