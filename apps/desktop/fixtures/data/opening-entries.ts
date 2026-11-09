// The opening every scripted session plays before its first run: the room and its lead.
// It reads the entry type from `script-entries.ts`, which reads nothing from here.

import type {
  AgentDefinitionId,
  AgentId,
  AgentProviderBinding,
} from "@ai-sidekicks/contracts/agent/definition";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type { ResolvedAgent } from "@ai-sidekicks/contracts/run/queued";
import type { SessionCreatedPayload } from "@ai-sidekicks/contracts/session/events";
import type { SessionId, UserId } from "@ai-sidekicks/contracts/session/id";
import type { SessionShape } from "@ai-sidekicks/contracts/session/methods";

import type { ScriptEntry } from "./script-entries.js";

/**
 * One agent of a scenario's cast, stated once so `session.created` and any beat that names
 * the agent's provider are built from the same copy.
 */
export interface ScenarioAgent {
  readonly agentId: string;
  readonly name: string;
  readonly providerName: string;
  readonly modelId: string;
  /** The saved definition an agent other than the lead was started from. */
  readonly definitionId?: string;
}

/** An agent started from its saved definition by a run's creation. */
interface ResolvedAgentInput {
  readonly agent: ScenarioAgent;
  /** The session's lead, which heads every other agent's ancestry. */
  readonly lead: ScenarioAgent;
  /** The instant the run that starts the agent is created, as an ISO string. */
  readonly resolvedAt: string;
}

/** A session's birth: the room and the lead born with it. */
interface SessionCreatedInput {
  readonly sessionId: string;
  readonly shape: SessionShape;
  /** The user who opened the session, and whose window this is. */
  readonly openedBy: string;
  /** The session's lead. Any other agent of the cast takes part only when a run names it. */
  readonly lead: ScenarioAgent;
  /** The instant the session and its lead are born, as an ISO string. */
  readonly createdAt: string;
}

/**
 * One agent of a scenario's cast by agent id, so a beat reads a run's provider off the cast
 * instead of restating it. Throws when no cast member has that id.
 */
export function findScenarioMember(cast: readonly ScenarioAgent[], agentId: string): ScenarioAgent {
  const member = cast.find((castMember) => castMember.agentId === agentId);
  if (member === undefined) {
    throw new RangeError(`no cast member of this scenario is agent ${agentId}`);
  }
  return member;
}

/**
 * The `session.created` payload, its lead shaped as the live agent list shapes it. The lead's
 * binding names no account and no effort, and its ancestry is empty because a lead has no
 * parent. Typed against the generated payload; the scenario contract check holds the beat to
 * its generated check.
 */
export function composeSessionCreatedPayload(
  input: SessionCreatedInput,
): Readonly<Record<string, unknown>> {
  const payload = {
    sessionId: input.sessionId as SessionId,
    shape: input.shape,
    mainAgent: {
      agentId: input.lead.agentId as AgentId,
      name: input.lead.name,
      binding: unaccountedBinding(input.lead),
      ancestry: [],
      createdAt: input.createdAt,
    },
    actor: input.openedBy as UserId,
  } satisfies SessionCreatedPayload;
  return payload;
}

/**
 * The agent a `run.queued` beat brings into the session, with the configuration it was
 * resolved from. Throws when the agent names no saved definition.
 *
 * The definition holds only empty defaults (no tool list, instructions or goal)
 * because no scenario reads them.
 */
export function composeResolvedAgent(input: ResolvedAgentInput): ResolvedAgent {
  const { agent } = input;
  if (agent.definitionId === undefined) {
    throw new RangeError(`agent ${agent.agentId} names no saved definition to be started from`);
  }
  const binding = unaccountedBinding(agent);
  return {
    agentId: agent.agentId as AgentId,
    name: agent.name,
    binding,
    resolvedConfiguration: {
      resolvedFromDefinitionId: agent.definitionId as AgentDefinitionId,
      resolvedBinding: binding,
      accentHue: null,
      toolAllowlist: null,
      instructions: "",
      goal: null,
    },
    ancestry: [{ kind: "agent", agentId: input.lead.agentId as AgentId }],
    createdAt: input.resolvedAt,
  };
}

/** An agent's binding to its provider and model, naming no account and no effort. */
function unaccountedBinding(agent: ScenarioAgent): AgentProviderBinding {
  return {
    providerName: agent.providerName as ProviderId,
    modelId: agent.modelId,
    providerAccountId: null,
    effort: null,
  };
}

/** The opening of a scripted session: the room, born with its lead. */
export function composeOpeningEntry(input: SessionCreatedInput): ScriptEntry {
  return {
    atMs: 0,
    kind: "session.created",
    actorId: input.openedBy,
    payload: composeSessionCreatedPayload(input),
  };
}
