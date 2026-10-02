// The agents pane, mounted for the screenshot tier, the only tier that looks at it. Not a test
// file.
//
// The pane is mounted over an unscripted fixture bridge with the agent list handed in as a plain
// call; the agent-list rows come from the module the feature keeps them in, so a capture cannot
// drift from the feature's own suites. The session store opens with the window's own fold ({@link
// COMPOSED_ENTITY_PROJECTORS}), so a partition a column reads is the one a window would project.
// `renderSettled` flushes promises and moves no clock, so the mount also drains the scheduled reads
// and then waits for the agent cards: a capture of a skeleton is green in every tier.

import { waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { renderSettled } from "../helpers/app-harness.js";

import { AGENT_ON_CLAUDE, AGENT_ON_CODEX } from "../helpers/agent-list.js";
import { agentsPaneBody } from "@renderer/features/agents/pane/agents-pane-body.js";
import { settleReads } from "@renderer/features/agents/pane/agents-pane.test-support.js";
import type { AgentsPaneCalls } from "@renderer/features/agents/agent-reads.js";
import { unscriptedScenario } from "../helpers/fixture-bridge.js";
import { FixtureBridgeProvider } from "../helpers/app-frame-fixtures.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { COMPOSED_ENTITY_PROJECTORS } from "../helpers/feature-mounts/projector-composition.js";
import { paneBinding } from "../helpers/feature-mounts/pane-body-resolution.js";
import { requireCapturedElement } from "./captured-element.js";

/** The session the store is open on, so the agent-list read is asked rather than skipped. */
const SESSION_ID = "session-agents";

/** The agent list this pane shows: two agents on two providers, and no child runs. */
const AGENTS_PANE_CALLS: AgentsPaneCalls = {
  listAgents: () => Promise.resolve({ agents: [AGENT_ON_CLAUDE, AGENT_ON_CODEX] }),
  readChildRunLinks: () =>
    Promise.resolve({
      children: [],
      counts: { live: 0, total: 0, waiting: 0 },
      rejectedCreates: [],
    }),
};

const renderAgentsPaneBody = agentsPaneBody(AGENTS_PANE_CALLS);

/** The pane body as a component, because bodies hold hooks and must be mounted, not called. */
function AgentsPaneBody(props: { readonly context: PaneContext }): ReactNode {
  return renderAgentsPaneBody(props.context);
}

/** An open session with no history, folded the way a window folds one. */
function agentsSessionStore(): SessionStore {
  const store = new SessionStore({
    sessionId: SESSION_ID,
    projectors: COMPOSED_ENTITY_PROJECTORS,
  });
  store.initialize({ cursor: 0, entities: [] });
  return store;
}

/** The whole agents pane over the fixture agent list, addressed at the agent on `claude`. */
export async function mountAgentsPane(): Promise<{ readonly element: Element }> {
  const fixture = createFixtureBridge({ scenario: unscriptedScenario("agents-screenshot") });
  const { bridge } = fixture;
  const context: PaneContext = {
    kind: "agents",
    entity: { kind: "agent", id: AGENT_ON_CLAUDE.agentId },
    ...paneBinding({ paneId: "pane-agents", bridge, sessionStore: agentsSessionStore() }),
  };
  const { container } = await renderSettled(
    <FixtureBridgeProvider fixture={fixture}>
      <AgentsPaneBody context={context} />
    </FixtureBridgeProvider>,
  );
  await settleReads(fixture.scenarioEngine);
  // Not inside `act`: the agent-list read resolves in a promise React does not know about, and an
  // `act` scope holds the commit back until it exits, so a wait inside one would wait for a
  // render its own scope prevents.
  await waitFor(() => {
    if (container.querySelector(".meridian-agent-card") === null) {
      throw new Error("the agent-list read has not landed yet");
    }
  });
  return { element: requireCapturedElement(container, ".meridian-pane") };
}
