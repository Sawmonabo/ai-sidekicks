// Session events several contracts tests parse, kept as one body each so a payload change is
// made once.

import type { EventCategory } from "../event-envelope.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const RUN_ID = "990e8400-e29b-41d4-a716-446655440004";

/** A session event as it crosses the wire, before a parse brands its ids. */
interface WireSessionEvent {
  id: string;
  sessionId: string;
  sequence: number;
  occurredAt: string;
  category: EventCategory;
  type: string;
  actor: string | null;
  version: string;
  payload: Record<string, unknown>;
}

/** A valid `session.created` event: the first row of a chat session. */
export function buildSessionCreatedEvent(): WireSessionEvent {
  return {
    id: "evt-0001",
    sessionId: SESSION_ID,
    sequence: 0,
    occurredAt: "2026-01-22T19:14:35.000Z",
    category: "session_lifecycle",
    type: "session.created",
    actor: USER_ID,
    version: "1.0",
    payload: {
      sessionId: SESSION_ID,
      shape: "chat",
      mainAgent: {
        agentId: "44444444-4444-4444-8444-444444444444",
        name: "Implementer",
        binding: {
          driverName: "claude",
          modelId: "claude-sonnet-5",
          providerAccountId: null,
          effort: null,
        },
        ancestry: [],
        createdAt: "2026-01-22T19:14:35.000Z",
      },
    },
  };
}

/** A valid `assistant.message` event in a run; its body lives apart from the payload. */
export function buildAssistantMessageEvent(): WireSessionEvent {
  return {
    id: "evt-3601",
    sessionId: SESSION_ID,
    sequence: 40,
    occurredAt: "2026-01-22T19:15:01.000Z",
    category: "assistant_output",
    type: "assistant.message",
    actor: null,
    version: "1.0",
    payload: {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      contentType: "text/markdown",
      contentLength: 4096,
    },
  };
}
