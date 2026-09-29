// The two log reads that say which driver a run is bound to.
//
// `driver.listCapabilities` answers with one report PER DRIVER and is addressed at the
// NODE, so it names no run. The session's own log can: `agent.attached` carries the
// persona — `{sessionId, agentId, name, driverName, modelId, ...}` — the only
// client-readable shape that names an agent's driver, and the run-lifecycle projector
// carries a run's `agentId` onto its body in the run partition.
//
// READ THROUGH A SCHEMA rather than off the record by hand: the payload and the body are
// `unknown` here, and a hand-shaped read would take a number, an empty string, or a
// missing member as a binding.

import { z } from "zod";
import type { SessionEventType } from "@ai-sidekicks/contracts";

import {
  type ConsoleEntity,
  type ConsoleSessionEvent,
} from "@renderer/store/session/entities/entities.js";

/**
 * The one event kind that names an agent's driver.
 *
 * Typed against the shipped taxonomy rather than written as a bare string, so a
 * misspelling fails to compile instead of quietly matching an event no daemon emits.
 */
const AGENT_ATTACHED_EVENT_KIND: Extract<SessionEventType, "agent.attached"> = "agent.attached";

/** The three members of the attach payload this read takes, and nothing else. */
const agentAttachPayloadSchema = z.object({
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  driverName: z.string().min(1),
});

/** The one member of a run's body this read takes. */
const runAgentBindingSchema = z.object({ agentId: z.string().min(1) });

/**
 * Each agent's declared driver, from the session's attach beats.
 *
 * Held to the envelope's own session: a payload naming another session is a claim about
 * another store. The LAST attach beat for an agent wins, so an agent re-attached on a
 * different driver is read as its current binding rather than its first.
 */
export function readAgentDriverNames(
  timeline: readonly ConsoleSessionEvent[],
): ReadonlyMap<string, string> {
  const driverNameByAgentId = new Map<string, string>();
  for (const entry of timeline) {
    if (entry.kind !== AGENT_ATTACHED_EVENT_KIND) {
      continue;
    }
    const parsed = agentAttachPayloadSchema.safeParse(entry.payload);
    if (!parsed.success || parsed.data.sessionId !== entry.sessionId) {
      continue;
    }
    driverNameByAgentId.set(parsed.data.agentId, parsed.data.driverName);
  }
  return driverNameByAgentId;
}

/** The agent a run was created for, or `undefined` where its body names none. */
export function readRunAgentId(run: ConsoleEntity): string | undefined {
  const binding = runAgentBindingSchema.safeParse(run.body);
  return binding.success ? binding.data.agentId : undefined;
}
