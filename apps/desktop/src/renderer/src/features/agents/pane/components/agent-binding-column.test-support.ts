// The roster fixtures the Agents pane suites, the accessibility tier and the screenshot mounts
// share.

import type {
  AgentDefinitionId,
  AgentId,
  AgentListEntry,
  AgentResolvedConfiguration,
} from "@ai-sidekicks/contracts";

/** One roster row on Claude with every optional member left out; a case adds what it is about. */
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
    executionPostureMode: "sandboxed",
    toolAllowlist: null,
    instructions: "Read before writing.",
    goal: "Survey the repository",
    ...overrides,
  };
}

/** An agent bound to the default Claude driver. */
export const AGENT_ON_CLAUDE: AgentListEntry = agentEntry({ agentId: "agent-a" as AgentId });

/** An agent named Runner bound to the Codex driver. */
export const AGENT_ON_CODEX: AgentListEntry = agentEntry({
  agentId: "agent-b" as AgentId,
  name: "Runner",
  binding: { driverName: "codex", modelId: "gpt-5.6", providerAccountId: null, effort: null },
});
