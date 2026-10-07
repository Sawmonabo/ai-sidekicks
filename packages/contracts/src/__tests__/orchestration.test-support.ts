// Orchestration payloads several contracts tests parse.

/** The session the orchestration fixtures belong to. */
export const SESSION_ID = "33333333-3333-4333-8333-333333333333";
/** The agent a fixture create targets. */
export const AGENT_ID = "44444444-4444-4444-8444-444444444444";
/** The run a fixture create is made from. */
export const PARENT_RUN_ID = "66666666-6666-4666-8666-666666666666";

/** A valid `orchestration.rejected` payload: a create whose target agent is not in the session. */
export const ORCHESTRATION_REJECTED_PAYLOAD: Readonly<Record<string, unknown>> = {
  sessionId: SESSION_ID,
  targetAgentId: AGENT_ID,
  parentRunId: PARENT_RUN_ID,
  reason: "agent.not_found",
  detail: "No agent with that id is in the session.",
};
