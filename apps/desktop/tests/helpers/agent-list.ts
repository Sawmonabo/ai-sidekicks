// The agent-list fixtures the Agents pane suites and the accessibility tier share.

import type {
  AgentDefinitionId,
  AgentId,
  AgentResolvedConfiguration,
} from "@ai-sidekicks/contracts/agent-definition";
import type { AgentListEntry } from "@ai-sidekicks/contracts/agent";

/** One agent-list row on Claude with every optional member left out; a case adds what it is about. */
export function agentEntry(overrides: Partial<AgentListEntry> = {}): AgentListEntry {
  return {
    agentId: "agent-scout" as AgentId,
    name: "Scout",
    binding: {
      driverName: "claude",
      modelId: "claude-sonnet",
      providerAccountId: null,
      effort: null,
    },
    ancestry: [],
    createdAt: "2026-03-04T08:15:00.000Z",
    ...overrides,
  };
}

/** A resolved configuration with every row filled but the tools, which it leaves to the driver. */
export function resolvedConfiguration(
  overrides: Partial<AgentResolvedConfiguration> = {},
): AgentResolvedConfiguration {
  return {
    resolvedFromDefinitionId: "definition-scout" as AgentDefinitionId,
    resolvedBinding: {
      driverName: "claude",
      modelId: "claude-sonnet",
      providerAccountId: null,
      effort: "high",
    },
    toolAllowlist: null,
    instructions: "Read before writing.",
    goal: "Survey the repository",
    ...overrides,
  };
}
