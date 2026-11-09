// One session agent as `agent.subscribe` sends it, and the acknowledgment the stream opens with,
// for suites that feed a session's agent list.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type {
  AgentSubscribeEntry,
  AgentSubscribeResponse,
} from "@ai-sidekicks/contracts/agent/methods";
import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";

/** A lead agent of the given id and name, bound to a provider's default model and account. */
export function agentEntry(agentId: string, name: string): AgentSubscribeEntry {
  return {
    agentId: agentId as AgentId,
    name,
    binding: {
      providerName: "claude" as ProviderId,
      modelId: "claude-sonnet",
      providerAccountId: null,
      effort: null,
    },
    ancestry: [],
    createdAt: "2026-01-01T10:05:00.000Z",
  };
}

/** The acknowledgment `agent.subscribe` opens with, carrying the session's agents. */
export function agentListAcknowledgment(
  agents: readonly AgentSubscribeEntry[],
): AgentSubscribeResponse {
  return {
    subscriptionId: "019b7b30-0280-7c3d-8110-cca0117a0150" as SubscriptionId,
    agents: [...agents],
  };
}
