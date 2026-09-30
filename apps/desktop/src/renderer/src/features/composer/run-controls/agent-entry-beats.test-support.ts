// The two rows that bring an agent into a session, as the projected timeline holds
// them: the session's birth record naming its lead, and a run's creation naming an
// agent started from a saved definition.
//
// Shared by the run-to-driver join's suite and the gating suite, which both build the
// join out of a session the way the pane does: one answer to what an agent on a driver
// looks like in the log.

import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";

/** One `session.created` beat whose lead runs on the named driver. */
export function leadCreatedBeat(input: LeadCreatedBeatInput): ProjectedSessionEvent {
  return {
    id: "event-created",
    sessionId: input.sessionId,
    sequence: 0,
    kind: "session.created",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {
      sessionId: input.payloadSessionId ?? input.sessionId,
      shape: "chat",
      mainAgent: {
        agentId: input.leadAgentId,
        name: "Ada",
        binding: {
          driverName: input.driverName,
          modelId: "a-model",
          providerAccountId: null,
          effort: null,
        },
        ancestry: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
}

/** One `run.queued` beat that starts an agent from its saved definition on the named driver. */
export function definitionAgentQueuedBeat(
  input: DefinitionAgentQueuedBeatInput,
): ProjectedSessionEvent {
  const binding = {
    driverName: input.driverName,
    modelId: "a-model",
    providerAccountId: null,
    effort: null,
  };
  return {
    id: `event-queued-${input.runId}`,
    sessionId: input.sessionId,
    sequence: 1,
    kind: "run.queued",
    occurredAt: "2026-01-01T00:00:01.000Z",
    payload: {
      sessionId: input.payloadSessionId ?? input.sessionId,
      runId: input.runId,
      runVersion: 1,
      newState: "queued",
      agentId: input.agentId,
      resolvedAgent: {
        agentId: input.agentId,
        name: "Grace",
        binding,
        resolvedConfiguration: {
          resolvedFromDefinitionId: "019b7a33-3300-7de1-8120-d1a4c1150402",
          resolvedBinding: binding,
          executionPostureMode: null,
          toolAllowlist: null,
          instructions: "",
          goal: null,
        },
        ancestry: [{ kind: "agent", agentId: input.leadAgentId }],
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    },
  };
}

interface LeadCreatedBeatInput {
  readonly sessionId: string;
  readonly leadAgentId: string;
  readonly driverName: string;
  /** The session the payload names, where a case needs it to differ from the envelope's. */
  readonly payloadSessionId?: string;
}

interface DefinitionAgentQueuedBeatInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly leadAgentId: string;
  readonly driverName: string;
  /** The session the payload names, where a case needs it to differ from the envelope's. */
  readonly payloadSessionId?: string;
}
