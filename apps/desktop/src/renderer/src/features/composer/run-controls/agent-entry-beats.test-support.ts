// A session's birth record as the projected timeline holds it, naming its lead.
//
// Shared by the run-to-driver join's suite and the gating suite, which both build the
// join out of a session the way the pane does: one answer to what a lead on a driver
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

interface LeadCreatedBeatInput {
  readonly sessionId: string;
  readonly leadAgentId: string;
  readonly driverName: string;
  /** The session the payload names, where a case needs it to differ from the envelope's. */
  readonly payloadSessionId?: string;
}
