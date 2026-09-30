// The scaffolding the `AgentBindingColumn` suites share: the daemon scripts, the bridge, the
// roster fixtures and the DOM queries.

import type {
  AgentDefinitionId,
  AgentId,
  AgentListEntry,
  AgentResolvedConfiguration,
  ChildRunLinkReadResponse,
} from "@ai-sidekicks/contracts";
import { AgentsPaneModels } from "../agents-pane-models.js";
import type { AgentRoster, AgentsPaneCalls } from "../../agent-reads.js";
import { unscriptedScenario, withDaemonCall } from "@test/helpers/fixture-bridge.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "@renderer/services/platform/platform-bridge.fixture.js";
import { SessionStore } from "@renderer/store/session/session-store.js";

/**
 * What the test daemon below exposes to the bridge. `answer`, not `call`, so this per-method
 * reply script cannot be mistaken for a view reaching the real `callDaemon`.
 */
export interface ScriptedDaemon {
  readonly answer: (method: string, params?: unknown) => Promise<unknown>;
}

/**
 * The real fixture bridge, answering this suite's scripted daemon through `callDaemon`, and the
 * engine whose frozen clock its window runs on.
 */
export function bridgeCalling(scriptedDaemon: ScriptedDaemon): FixtureBridge {
  const base = createFixtureBridge({ scenario: unscriptedScenario("agent-binding-column") });
  return {
    bridge: withDaemonCall(
      base.bridge,
      async ({ method, params }) => await scriptedDaemon.answer(method, params),
    ).bridge,
    scenarioEngine: base.scenarioEngine,
  };
}

/** The roster and child-run link reads the models take, answered by the scripted daemon. */
function callsAnswering(scriptedDaemon: ScriptedDaemon): AgentsPaneCalls {
  return {
    listAgents: async (request) =>
      (await scriptedDaemon.answer("agent.list", request)) as AgentRoster,
    readChildRunLinks: async (request) =>
      (await scriptedDaemon.answer(
        "orchestration.childRunLinkRead",
        request,
      )) as ChildRunLinkReadResponse,
  };
}

const openedModels: AgentsPaneModels[] = [];

/** A daemon that answers the roster read with a fixed roster. */
export class AgentListDaemon {
  readonly #roster: readonly unknown[];

  public readonly answer = async (method: string): Promise<unknown> => {
    if (method === "agent.list") {
      return { agents: this.#roster };
    }
    throw new Error(`the test daemon scripts no reply for ${method}`);
  };

  public constructor(roster: readonly unknown[]) {
    this.#roster = roster;
  }
}

/**
 * Dispose every models object a case opened. Each suite calls it from its own `afterEach`: a
 * hook attached on import would be a lifecycle a reader of that file cannot see.
 */
export function disposeOpenedModels(): void {
  for (const models of openedModels.splice(0, openedModels.length)) {
    models.dispose();
  }
}

/**
 * The real models over that bridge and daemon, on its frozen clock, disposed after the
 * test that opened them.
 */
export function modelsOver(
  fixture: FixtureBridge,
  scriptedDaemon: ScriptedDaemon,
  sessionId = "session-9",
): AgentsPaneModels {
  const models = new AgentsPaneModels(
    fixture.bridge,
    fixture.scenarioEngine.clock,
    new SessionStore({ sessionId }),
    callsAnswering(scriptedDaemon),
  );
  openedModels.push(models);
  return models;
}

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

export const AGENT_ON_CLAUDE: AgentListEntry = agentEntry({ agentId: "agent-a" as AgentId });

export const AGENT_ON_CODEX: AgentListEntry = agentEntry({
  agentId: "agent-b" as AgentId,
  name: "Runner",
  binding: { driverName: "codex", modelId: "gpt-5.6", providerAccountId: null, effort: null },
});
