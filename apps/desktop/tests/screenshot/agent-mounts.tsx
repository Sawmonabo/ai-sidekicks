// The agents pane, mounted once for the tiers that look at it. Not a test file. `app-harness.ts`
// owns how the app is mounted and this module owns what of the agents feature is mounted into it,
// like the modules in `tests/helpers/feature-mounts/`.
//
// The pane is mounted over an unscripted fixture bridge with the roster handed in as a plain
// call; the roster rows come from the module the feature keeps them in, so a capture cannot drift
// from the feature's own suites. The session store opens with the window's own fold
// ({@link COMPOSED_ENTITY_PROJECTORS}), so a partition a column reads is the one a window would
// project. `renderSettled` flushes promises and moves no clock, so the mount also drains the
// scheduled reads and then waits for the roster cards: a capture of a skeleton is green in every
// tier.

import { waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { renderSettled } from "../helpers/app-harness.js";

import {
  AGENT_ON_CLAUDE,
  AGENT_ON_CODEX,
} from "@renderer/features/agents/pane/components/agent-binding-column.test-support.js";
import { agentsPaneBody } from "@renderer/features/agents/pane/agents-pane-body.js";
import { settleReads } from "@renderer/features/agents/pane/agents-pane.test-support.js";
import type { AgentsPaneCalls } from "@renderer/features/agents/agent-reads.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { unscriptedScenario } from "../helpers/fixture-bridge.js";
import { FixtureBridgeProvider } from "../helpers/app-frame-fixtures.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { COMPOSED_ENTITY_PROJECTORS } from "../helpers/feature-mounts/projector-composition.js";

/** The session the store is open on, so the roster read is asked rather than skipped. */
const SESSION_ID = "session-agents";

/** The roster this pane shows: two agents on two providers, and no child runs. */
const AGENTS_PANE_CALLS: AgentsPaneCalls = {
  listAgents: () => Promise.resolve({ agents: [AGENT_ON_CLAUDE, AGENT_ON_CODEX] }),
  readChildRunLinks: () =>
    Promise.resolve({
      children: [],
      counts: { live: 0, total: 0, waiting: 0 },
      rejectedCreates: [],
    }),
};

/**
 * The one element a mount hands back, or a throw naming what was missing. It throws so a pane that
 * stopped rendering its root fails here, with the selector named, instead of handing a tier an
 * absent element.
 */
function requireRendered(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`the agents pane rendered no ${selector}, so there is nothing to mount`);
  }
  return element;
}

const renderAgentsPaneBody = agentsPaneBody(AGENTS_PANE_CALLS);

/** The pane body as a component, because bodies hold hooks and must be mounted, not called. */
function AgentsPaneBody(props: { readonly context: PaneContext }): ReactNode {
  return renderAgentsPaneBody(props.context);
}

/** The pane layout context a pane is mounted with, about one named agent. */
function paneContext(
  bridge: PlatformBridge,
  sessionStore: SessionStore,
  agentId: string,
): PaneContext {
  return {
    kind: "agents",
    paneId: "pane-agents",
    entity: { kind: "agent", id: agentId },
    frameStore: new WindowStore(),
    uiStateStore: UiStateStore.opening(),
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
    // Nothing opened this pane from another: every tier mounts one body directly.
    linkedSourcePaneId: undefined,
    bridge,
    sessionStore,
  };
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

/** The pane mounted over the fixture roster, addressed at the agent on `claude`. */
async function renderAgentsPane(): Promise<{
  readonly container: HTMLElement;
  readonly bridge: PlatformBridge;
}> {
  const fixture = createFixtureBridge({ scenario: unscriptedScenario("agents-screenshot") });
  const { bridge } = fixture;
  const context = paneContext(bridge, agentsSessionStore(), AGENT_ON_CLAUDE.agentId);
  const { container } = await renderSettled(
    <FixtureBridgeProvider fixture={fixture}>
      <AgentsPaneBody context={context} />
    </FixtureBridgeProvider>,
  );
  await settleReads(fixture.scenarioEngine);
  // Not inside `act`: the roster read resolves in a promise React does not know about, and an
  // `act` scope holds the commit back until it exits, so a wait inside one would wait for a
  // render its own scope prevents.
  await waitFor(() => {
    if (container.querySelector(".meridian-agent-card") === null) {
      throw new Error("the roster read has not landed yet");
    }
  });
  return { container, bridge };
}

/** The whole agents pane, chrome and column, over the fixture roster. */
export async function mountAgentsPane(): Promise<HTMLElement> {
  const { container } = await renderAgentsPane();
  return requireRendered(container, ".meridian-pane");
}
