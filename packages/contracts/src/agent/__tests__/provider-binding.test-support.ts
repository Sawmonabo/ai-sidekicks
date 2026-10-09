// Binding switch payloads several contracts tests parse.

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const DEVICE_ID = "device-laptop";

/** The Claude binding a fixture switch leaves. */
export const CLAUDE_BINDING: Readonly<Record<string, unknown>> = {
  driverName: "claude",
  modelId: "opus",
  providerAccountId: "claude-work",
  effort: "high",
};

/**
 * A valid `agent.provider_binding_changed` payload: a switch to Codex that rebuilt the conversation
 * from a brief and declares what the brief dropped.
 */
export const BINDING_CHANGED_PAYLOAD: Readonly<Record<string, unknown>> = {
  sessionId: SESSION_ID,
  agentId: AGENT_ID,
  switchId: "switch-1",
  actor: DEVICE_ID,
  from: CLAUDE_BINDING,
  to: {
    driverName: "codex",
    modelId: "gpt-5.5",
    providerAccountId: "codex-personal",
    effort: "medium",
  },
  landedProviderAccountId: "codex-personal",
  continuity: "brief",
  declaredLosses: ["conversation_history_summarized", "provider_private_reasoning"],
};

/**
 * A valid `agent.provider_binding_change_failed` payload: a switch refused because the target
 * account needs signing in again.
 */
export const BINDING_CHANGE_FAILED_PAYLOAD: Readonly<Record<string, unknown>> = {
  sessionId: SESSION_ID,
  agentId: AGENT_ID,
  switchId: "switch-2",
  actor: DEVICE_ID,
  from: CLAUDE_BINDING,
  attempted: { driverName: "codex", modelId: "gpt-5.5", largerWindow: null },
  reason: "account_unavailable",
  accountState: "reauth_required",
};
