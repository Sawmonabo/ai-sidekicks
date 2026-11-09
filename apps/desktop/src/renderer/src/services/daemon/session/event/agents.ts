// The session's agents as its log names them, for the composer's target: which agent is the lead
// and which provider each agent is bound to. `session.created` carries the lead,
// `agent.run.queued` an agent started from a saved definition, and `agent.providerBinding.changed`
// an agent's switch to another binding. The store keeps all three among its standing events,
// whatever rows its window holds. Each is read through its generated check because the payload is
// `unknown`, and a hand-shaped read would take a number or an empty string as a binding.

import {
  AGENT_PROVIDER_BINDING_CHANGED_EVENT,
  validateAgentProviderBindingChangedPayload,
} from "@ai-sidekicks/contracts/agent/provider-binding";
import type { AgentProviderBinding } from "@ai-sidekicks/contracts/agent/definition";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import { validateAgentRunQueuedPayload } from "@ai-sidekicks/contracts/run/queued";
import { validateSessionCreatedPayload } from "@ai-sidekicks/contracts/session/events";

import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { RUN_QUEUED_EVENT_KIND } from "#renderer/store/session/events/run/state-kinds.js";
import { SESSION_CREATED_EVENT_KIND } from "#renderer/store/session/standing-events.js";

/**
 * Each agent's current provider, from the rows among `events` that bring agents into the session
 * and switch their bindings: its newest switch's target, else the binding it came in with. A
 * payload naming another session is ignored.
 */
export function readAgentDriverNames(
  events: readonly ProjectedSessionEvent[],
): ReadonlyMap<string, ProviderId> {
  const broughtInProviderByAgentId = new Map<string, ProviderId>();
  const switchedProviderByAgentId = new Map<string, ProviderId>();
  for (const entry of events) {
    const agent = agentBroughtInBy(entry);
    if (agent !== undefined) {
      broughtInProviderByAgentId.set(agent.agentId, agent.binding.providerName);
    }
    const switched = bindingSwitchIn(entry);
    if (switched !== undefined) {
      switchedProviderByAgentId.set(switched.agentId, switched.providerName);
    }
  }
  return new Map([...broughtInProviderByAgentId, ...switchedProviderByAgentId]);
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

/** An agent a row brings in: its id and the binding it comes in with. */
interface BroughtInAgent {
  readonly agentId: string;
  readonly binding: AgentProviderBinding;
}

/** The agent this row brings into its own session, or `undefined` where it brings none. */
function agentBroughtInBy(entry: ProjectedSessionEvent): BroughtInAgent | undefined {
  const payload = entry.payload;
  if (entry.kind === SESSION_CREATED_EVENT_KIND) {
    return validateSessionCreatedPayload(payload) && payload.sessionId === entry.sessionId
      ? payload.mainAgent
      : undefined;
  }
  if (entry.kind === RUN_QUEUED_EVENT_KIND) {
    // Only a run started from a saved definition brings an agent in; any other names one already
    // in the session.
    return validateAgentRunQueuedPayload(payload) && payload.sessionId === entry.sessionId
      ? payload.resolvedAgent
      : undefined;
  }
  return undefined;
}

/** The agent this row switched in its own session and the provider it moved to, or `undefined`. */
function bindingSwitchIn(
  entry: ProjectedSessionEvent,
): { readonly agentId: string; readonly providerName: ProviderId } | undefined {
  if (entry.kind !== AGENT_PROVIDER_BINDING_CHANGED_EVENT) {
    return undefined;
  }
  const payload = entry.payload;
  return validateAgentProviderBindingChangedPayload(payload) &&
    payload.sessionId === entry.sessionId
    ? { agentId: payload.agentId, providerName: payload.to.providerName }
    : undefined;
}
