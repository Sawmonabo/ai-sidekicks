// Who a session event puts on the hue wheel, and in what order. The wheel hands out steps in the
// order identities arrive, so every client draws the same hues only if every client admits them in
// one order whatever stretch of the log it holds. The events that brought each agent into the
// session reach every read among its standing events, so a read admits them first, in sequence
// order, and the stream and pages admit the same identities from the same events.

import { isWireRecord } from "#renderer/lib/wire/record.js";
import { readWireString } from "#renderer/lib/wire/strings.js";
import type { AgentHueAllocator } from "#renderer/styles/agent-hue.js";
import type { ProjectedSessionEvent } from "./entities/vocabulary.js";
import { readResolvedAgentId } from "./events/run/entity-body.js";
import { RUN_QUEUED_EVENT_KIND } from "./events/run/state-kinds.js";
import { SESSION_CREATED_EVENT_KIND } from "./standing-events.js";

/**
 * Admit to `allocator` the event's actor, then the agent the event brings into the session, if
 * any: the lead on `session.created`, the agent a `run.queued` resolved from its definition.
 */
export function admitToHueWheel(allocator: AgentHueAllocator, event: ProjectedSessionEvent): void {
  if (event.actorId !== undefined) {
    allocator.admit(event.actorId);
  }
  const joiningAgentId = readJoiningAgentId(event);
  if (joiningAgentId !== undefined) {
    allocator.admit(joiningAgentId);
  }
}

/**
 * Admit, from a read, every event that brought an agent into the session, in sequence order, so
 * each agent's step follows the order agents joined rather than the stretch the read carried.
 */
export function admitJoinsToHueWheel(
  allocator: AgentHueAllocator,
  standingEvents: readonly ProjectedSessionEvent[],
): void {
  for (const event of standingEvents) {
    if (readJoiningAgentId(event) !== undefined) {
      admitToHueWheel(allocator, event);
    }
  }
}

/** The agent this event brings into the session, or `undefined` where it brings none. */
function readJoiningAgentId(event: ProjectedSessionEvent): string | undefined {
  if (event.kind === SESSION_CREATED_EVENT_KIND) {
    const mainAgent = event.payload?.["mainAgent"];
    return isWireRecord(mainAgent) ? readWireString(mainAgent["agentId"]) : undefined;
  }
  return event.kind === RUN_QUEUED_EVENT_KIND ? readResolvedAgentId(event.payload) : undefined;
}
