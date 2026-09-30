// Who is in the room before any run starts, as a beat.
//
// `script-entries.ts` beside it turns an ordered script into positioned, stamped beats
// and carries the run, assistant and tool payload shapes. This holds the opening every
// scripted session plays before its first run, which answers to a different question:
// the script machinery changes when the engine's contract moves, these shapes change
// when the session-opening wire does.
//
// The dependency runs one way: this module reads the entry type from the script module
// and the script module reads nothing back. The run entry builders there never compose
// an opening, because an opening is not a run's.

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
 * One agent of a scenario's cast.
 *
 * A scenario states each agent once, and the lead's place in `session.created` and any
 * beat that names an agent's provider are built from it, which two hand-written copies
 * would let drift in the direction nothing catches.
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
  /** The instant the run that starts the agent is created, as the ISO string a beat carries. */
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
  /** The instant the session and its lead are born, as the ISO string a beat carries. */
  readonly createdAt: string;
}

/**
 * One agent of a scenario's cast, by the agent id a beat already names.
 *
 * So a beat that has to state a run's provider reads it off the cast rather than
 * restating it. The driver name is already one fact in one table, and a second copy
 * beside a beat would let a subagent be attributed to a provider its own agent does
 * not run on, which is half the key the transcript pairs a subagent's rows by.
 *
 * Throws rather than answering for nobody. A lookup that missed would otherwise hand
 * a beat an empty provider, and an empty provider is an identity the anchor index
 * silently declines to build: a fixture that renders as though nothing was scripted.
 */
export function findScenarioMember(cast: readonly ScenarioAgent[], agentId: string): ScenarioAgent {
  const member = cast.find((castMember) => castMember.agentId === agentId);
  if (member === undefined) {
    throw new RangeError(`no cast member of this scenario is agent ${agentId}`);
  }
  return member;
}

/**
 * The instant a tick after the scenario's start stands for, as the ISO string a beat or
 * reply carries.
 */
export function composeScenarioInstant(startedAtMs: number, atMs: number): string {
  return new Date(startedAtMs + atMs).toISOString();
}

/**
 * The `session.created` payload, its lead named as the live agent list names it.
 *
 * Parsed through the registered schema here rather than left for the contract check, so
 * an authoring mistake fails the scenario's module and names the session rather than a
 * beat. The lead's binding names no account and no effort, because no scenario picks
 * either, and its ancestry is empty because a lead has no parent.
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
 * The agent a `run.queued` beat brings into the session, as the live agent list names
 * it, with the configuration it was resolved from.
 *
 * Parsed through the registered schema here for the reason the birth record is. The
 * definition's own fields are the plainest a definition can hold (no posture, no tool
 * list, no instructions, no goal), because no scenario reads them, and the binding
 * resolved from it is the agent's own.
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
 * The agent id of a scenario's lead, read out of its log rather than restated.
 *
 * A second copy of the id beside a test would agree with the scenario only by
 * discipline, and the day the scenario's lead changed the test would go on addressing an
 * agent nobody leads. Throws where the scenario plays no birth record, because then no
 * agent is in its session.
 */
export function scenarioLeadAgentId(scenario: Scenario): string {
  const created = scenario.beats.find((beat) => beat.event.kind === "session.created");
  if (created === undefined) {
    throw new RangeError(`scenario ${scenario.id} plays no session.created, so it has no lead`);
  }
  return SessionCreatedPayloadSchema.parse(created.event.payload).mainAgent.agentId;
}
