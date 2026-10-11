// The session's agents as its log names them: which agent is the lead and which driver each agent
// is bound to. `driver.listCapabilities` is addressed at the daemon and names no agent, but the
// session's log does: `session.created` carries the lead, `run.queued` an agent started from a
// saved definition, and `agent.provider_binding_changed` an agent's switch to another binding.
// The store keeps all three among its standing events, whatever rows its window holds. Each is
// read through a schema because the payload is `unknown`, and a hand-shaped read would take a
// number or an empty string as a binding.

import {
  AGENT_PROVIDER_BINDING_CHANGED_EVENT,
  AgentProviderBindingChangedPayloadSchema,
} from "@ai-sidekicks/contracts/agent/provider-binding";
import { RunQueuedPayloadSchema } from "@ai-sidekicks/contracts/run/queued";
import { SessionCreatedPayloadSchema } from "@ai-sidekicks/contracts/session/events";
import type { AgentListEntry } from "@ai-sidekicks/contracts/agent/methods";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";

import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { RUN_QUEUED_EVENT_KIND } from "#renderer/store/session/events/run/state-kinds.js";
import { SESSION_CREATED_EVENT_KIND } from "#renderer/store/session/standing-events.js";

/**
 * Each agent's current driver, from the rows among `events` that bring agents into the session
 * and switch their bindings: its newest switch's target, else the binding it came in with. A
 * payload naming another session is ignored.
 */
export function readAgentDriverNames(
  events: readonly ProjectedSessionEvent[],
): ReadonlyMap<string, ProviderName> {
  const broughtInDriverByAgentId = new Map<string, ProviderName>();
  const switchedDriverByAgentId = new Map<string, ProviderName>();
  for (const entry of events) {
    const agent = agentBroughtInBy(entry);
    if (agent !== undefined) {
      broughtInDriverByAgentId.set(agent.agentId, agent.binding.driverName);
    }
    const switched = bindingSwitchIn(entry);
    if (switched !== undefined) {
      switchedDriverByAgentId.set(switched.agentId, switched.driverName);
    }
  }
  return new Map([...broughtInDriverByAgentId, ...switchedDriverByAgentId]);
}

/**
 * The session's lead: the agent the `session.created` row among `events` brought in, or
 * `undefined` where they hold no readable one naming its own session.
 */
export function readLeadAgentId(events: readonly ProjectedSessionEvent[]): string | undefined {
  for (const entry of events) {
    const lead = entry.kind === SESSION_CREATED_EVENT_KIND ? agentBroughtInBy(entry) : undefined;
    if (lead !== undefined) {
      return lead.agentId;
    }
  }
  return undefined;
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

/** The agent this row switched in its own session and the driver it moved to, or `undefined`. */
function bindingSwitchIn(
  entry: ProjectedSessionEvent,
): { readonly agentId: string; readonly driverName: ProviderName } | undefined {
  if (entry.kind !== AGENT_PROVIDER_BINDING_CHANGED_EVENT) {
    return undefined;
  }
  const parsed = AgentProviderBindingChangedPayloadSchema.safeParse(entry.payload);
  return parsed.success && parsed.data.sessionId === entry.sessionId
    ? { agentId: parsed.data.agentId, driverName: parsed.data.to.driverName }
    : undefined;
}
