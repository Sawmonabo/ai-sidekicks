// The opening every scripted session plays before its first run: the room and its lead.
// It reads the entry type from `script-entries.ts`, which reads nothing from here.

import {
  AgentListEntrySchema,
  SessionCreatedPayloadSchema,
  type AgentListEntry,
  type SessionCreatedPayload,
  type SessionShape,
} from "@ai-sidekicks/contracts";

import type { Scenario } from "../scenario.js";
import { type ScriptEntry } from "./script-entries.js";

/**
 * One agent of a scenario's cast, stated once so `session.created` and any beat that names
 * the agent's provider are built from the same copy.
 */
export interface ScenarioAgent {
  readonly agentId: string;
  readonly name: string;
  readonly driverName: string;
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

/** The ISO instant `atMs` after the scenario's start. */
export function composeScenarioInstant(startedAtMs: number, atMs: number): string {
  return new Date(startedAtMs + atMs).toISOString();
}

/**
 * The `session.created` payload, its lead shaped as the live agent list shapes it.
 *
 * Parsed here so an authoring mistake fails the scenario's module. The lead's binding names
 * no account and no effort, and its ancestry is empty because a lead has no parent.
 */
export function composeSessionCreatedPayload(input: SessionCreatedInput): SessionCreatedPayload {
  return SessionCreatedPayloadSchema.parse({
    sessionId: input.sessionId,
    shape: input.shape,
    mainAgent: {
      agentId: input.lead.agentId,
      name: input.lead.name,
      binding: {
        driverName: input.lead.driverName,
        modelId: input.lead.modelId,
        providerAccountId: null,
        effort: null,
      },
      ancestry: [],
      createdAt: input.createdAt,
    },
    actor: input.openedBy,
  });
}

/**
 * The agent a `run.queued` beat brings into the session, with the configuration it was
 * resolved from. Throws when the agent names no saved definition.
 *
 * The definition holds only empty defaults (no posture, tool list, instructions or goal)
 * because no scenario reads them.
 */
export function composeResolvedAgent(input: ResolvedAgentInput): AgentListEntry {
  const { agent } = input;
  if (agent.definitionId === undefined) {
    throw new RangeError(`agent ${agent.agentId} names no saved definition to be started from`);
  }
  const binding = {
    driverName: agent.driverName,
    modelId: agent.modelId,
    providerAccountId: null,
    effort: null,
  };
  return AgentListEntrySchema.parse({
    agentId: agent.agentId,
    name: agent.name,
    binding,
    resolvedConfiguration: {
      resolvedFromDefinitionId: agent.definitionId,
      resolvedBinding: binding,
      executionPostureMode: null,
      toolAllowlist: null,
      instructions: "",
      goal: null,
    },
    ancestry: [{ kind: "agent", agentId: input.lead.agentId }],
    createdAt: input.resolvedAt,
  });
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

/**
 * The agent id of a scenario's lead, read from its `session.created` beat so tests do not
 * restate it. Throws when the scenario plays no such beat.
 */
export function scenarioLeadAgentId(scenario: Scenario): string {
  const created = scenario.beats.find((beat) => beat.event.kind === "session.created");
  if (created === undefined) {
    throw new RangeError(`scenario ${scenario.id} plays no session.created, so it has no lead`);
  }
  return SessionCreatedPayloadSchema.parse(created.event.payload).mainAgent.agentId;
}
