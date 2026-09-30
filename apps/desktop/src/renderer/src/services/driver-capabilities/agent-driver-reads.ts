// The two log reads that say which driver a run is bound to.
//
// `driver.listCapabilities` answers with one report PER DRIVER and is addressed at the
// NODE, so it names no run. The session's own log can: `session.created` carries the
// session's lead as the live agent list names it, binding and all; `run.queued` carries
// an agent started from a saved definition the same way; and the run-lifecycle
// projector carries a run's `agentId` onto its body in the run partition.
//
// READ THROUGH A SCHEMA rather than off the record by hand: the payload and the body are
// `unknown` here, and a hand-shaped read would take a number, an empty string, or a
// missing member as a binding.

import { z } from "zod";
import {
  RunQueuedPayloadSchema,
  SessionCreatedPayloadSchema,
  type AgentListEntry,
  type SessionEventType,
} from "@ai-sidekicks/contracts";

import {
  type StoredEntity,
  type ProjectedSessionEvent,
} from "@renderer/store/session/entities/entities.js";

/**
 * The event kinds that bring an agent into its session: the session's birth brings the
 * lead, and a run's creation brings an agent started from a saved definition.
 *
 * Typed against the shipped taxonomy rather than written as bare strings, so a
 * misspelling fails to compile instead of quietly matching an event no daemon emits.
 */
const SESSION_CREATED_EVENT_KIND: Extract<SessionEventType, "session.created"> = "session.created";
const RUN_QUEUED_EVENT_KIND: Extract<SessionEventType, "run.queued"> = "run.queued";

/** The one member of a run's body this read takes. */
const runAgentBindingSchema = z.object({ agentId: z.string().min(1) });

/**
 * Each agent's declared driver, from the rows that bring agents into the session.
 *
 * Held to the envelope's own session: a payload naming another session is a claim about
 * another store.
 */
export function readAgentDriverNames(
  timeline: readonly ProjectedSessionEvent[],
): ReadonlyMap<string, string> {
  const driverNameByAgentId = new Map<string, string>();
  for (const entry of timeline) {
    const agent = agentBroughtInBy(entry);
    if (agent !== undefined) {
      driverNameByAgentId.set(agent.agentId, agent.binding.driverName);
    }
  }
  return driverNameByAgentId;
}

/** The agent a run was created for, or `undefined` where its body names none. */
export function readRunAgentId(run: StoredEntity): string | undefined {
  const binding = runAgentBindingSchema.safeParse(run.body);
  return binding.success ? binding.data.agentId : undefined;
}

/** The agent this row brings into its own session, or `undefined` where it brings none. */
function agentBroughtInBy(entry: ProjectedSessionEvent): AgentListEntry | undefined {
  if (entry.kind === SESSION_CREATED_EVENT_KIND) {
    const parsed = SessionCreatedPayloadSchema.safeParse(entry.payload);
    return parsed.success && parsed.data.sessionId === entry.sessionId
      ? parsed.data.mainAgent
      : undefined;
  }
  if (entry.kind === RUN_QUEUED_EVENT_KIND) {
    const parsed = RunQueuedPayloadSchema.safeParse(entry.payload);
    return parsed.success && parsed.data.sessionId === entry.sessionId
      ? parsed.data.resolvedAgent
      : undefined;
  }
  return undefined;
}
