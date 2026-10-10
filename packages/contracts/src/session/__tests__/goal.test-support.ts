// Goal payloads several contracts tests parse.

/** The session the fixture goal belongs to. */
export const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
/** The agent the fixture goal is for. */
export const AGENT_ID = "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7b";

/** A `session.goal_updated` payload's goal and target, before a status is added. */
export const GOAL_UPDATED_PAYLOAD_BASE: Readonly<Record<string, unknown>> = {
  sessionId: SESSION_ID,
  agentId: AGENT_ID,
  goal: { text: "Ship it" },
};
