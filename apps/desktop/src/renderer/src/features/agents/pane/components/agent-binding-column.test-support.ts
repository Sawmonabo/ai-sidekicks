// The scaffolding the `AgentBindingColumn` suites are driven with: the daemon scripts,
// the bridge, the roster fixtures, and the DOM queries needed by more than one suite,
// so they live here once rather than being copied into the file written second.

import { AgentsPaneModels } from "../agents-pane-models.js";
import type { AgentsPaneCalls } from "../../agent-reads.js";
import { unscriptedScenario, withDaemonCall } from "@test/helpers/fixture-bridge.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "@renderer/services/platform/platform-bridge.fixture.js";
import {
  type AgentListReading,
  type ChildRunLinkReading,
} from "@renderer/services/wire-shapes/agents.js";
import { SessionStore } from "@renderer/store/session/session-store.js";

/**
 * What the test daemon below exposes to the bridge.
 *
 * `answer` rather than `call`, and held to that name deliberately: this object is a
 * per-method reply script, not the bridge every view shares. A stand-in whose
 * operation were named `call` on a holder named for the daemon would be
 * indistinguishable in source text from a view reaching the real `callDaemon` —
 * which is what a reviewer sweeping for one would flag, and it would flag this file.
 */
export interface ScriptedDaemon {
  readonly answer: (method: string, params?: unknown) => Promise<unknown>;
}

/**
 * The real fixture bridge, answering this suite's scripted daemon through `callDaemon`,
 * and the engine whose frozen clock its window runs on.
 *
 * The calls reach the bridge's own call arm through the shared `withDaemonCall`, which is
 * where the reach lives; this file holds no copy of the bridge's namespace shape.
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

/**
 * The console's two roster-side reads, answered by the same scripted daemon.
 *
 * The roster and the child-run links are taken as calls by the models, so a suite decides
 * their answers here rather than through the bridge.
 */
function callsAnswering(scriptedDaemon: ScriptedDaemon): AgentsPaneCalls {
  return {
    listAgents: async (request) =>
      (await scriptedDaemon.answer("agent.list", request)) as AgentListReading,
    readChildRunLinks: async (request) =>
      (await scriptedDaemon.answer(
        "orchestration.childRunLinkRead",
        request,
      )) as ChildRunLinkReading,
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
 * Dispose every models object a case opened. Each suite calls it from its own
 * `afterEach`, rather than this module registering one on import: a hook that
 * attaches itself to whichever file happens to import a helper is a lifecycle a
 * reader of that file cannot see.
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

export const AGENT_ON_CLAUDE = {
  agentId: "agent-a",
  name: "Scout",
  driverName: "claude",
  modelId: "claude-sonnet",
};

export const AGENT_ON_CODEX = {
  agentId: "agent-b",
  name: "Runner",
  driverName: "codex",
  modelId: "gpt-5.6",
};
