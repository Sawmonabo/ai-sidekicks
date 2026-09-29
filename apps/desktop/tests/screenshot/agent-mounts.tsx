// The agents family's surface, mounted once for the tiers that look at it.
//
// Not a test file — no `include` glob reaches it as one. It sits beside the other
// family mount modules for their reason: `console-harness.tsx` owns HOW the console is
// mounted, and a module named for a family owns WHAT of that family is mounted into it.
//
// The console pane is mounted over an unscripted fixture bridge, with the roster handed in
// as a plain call. Nothing here re-authors a fixture: the roster rows come from the
// module the family already keeps them in, so a capture cannot drift from what the
// family's own suites are driven with.
//
// THE SESSION STORE OPENS WITH THE WINDOW'S OWN FOLD — {@link COMPOSED_CONSOLE_PROJECTORS}
// and never a registrar this file picked — so a partition a column reads is the one a
// window would have projected.
//
// AND THE MOUNT SETTLES ITS OWN READS. `renderSettled` flushes promises and moves no
// clock; the composition arms a `RefreshScheduler` on the fixture's frozen one, so the
// advance is the second half of what settling MEANS for a surface that reads. The mount
// then WAITS ON THE THING IT EXISTS TO SHOW rather than returning on the settle alone,
// because a capture of a skeleton is a green case in every tier that takes one.

import { waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { renderSettled } from "../../test/console/console-harness.js";

import {
  AGENT_ON_CLAUDE,
  AGENT_ON_CODEX,
} from "@renderer/features/agents/pane/components/agent-binding-column.test-support.js";
import { agentConsolePaneBody } from "@renderer/features/agents/pane/agents-pane-body.js";
import { settleReads } from "@renderer/features/agents/pane/agents-pane.test-support.js";
import type { AgentConsoleCalls } from "@renderer/features/agents/agent-reads.js";
import { unscriptedScenario } from "@renderer/console/bridge/fixture/call-plane/bridge.test-support.js";
import { createFixtureBridge } from "@renderer/console/bridge/fixture/call-plane/bridge.js";
import { type ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/console/core/constants/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { type ConsolePaneContext } from "@renderer/console/seats/index.js";
import { FrameStore } from "@renderer/store/window/window-store.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { COMPOSED_CONSOLE_PROJECTORS } from "../helpers/feature-mounts/projector-composition.js";

/** The session the store is open on, so the roster read is asked rather than skipped. */
const SESSION_ID = "session-agents";

/** The roster this surface shows: two agents on two providers, and no child runs. */
const AGENT_CONSOLE_CALLS: AgentConsoleCalls = {
  listAgents: () => Promise.resolve({ agents: [AGENT_ON_CLAUDE, AGENT_ON_CODEX] }),
  readChildRunLinks: () => Promise.resolve({ links: [], rejectedCreates: [] }),
};

/**
 * The one element a mount hands back, or a throw naming what was missing.
 *
 * A throw rather than an optional return, so a surface that stopped rendering its root
 * fails here — where the message names the selector — instead of handing a tier an
 * absent element to compare a reference against.
 */
function requireRendered(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`the agents family rendered no ${selector}, so there is nothing to mount`);
  }
  return element;
}

const renderAgentConsolePane = agentConsolePaneBody(AGENT_CONSOLE_CALLS);

/** The pane body as a component, because bodies hold hooks and must be mounted, not called. */
function AgentConsolePaneBody(props: { readonly context: ConsolePaneContext }): ReactNode {
  return renderAgentConsolePane(props.context);
}

/** The deck context a pane is mounted with, about one named agent. */
function paneContext(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
  agentId: string,
): ConsolePaneContext {
  return {
    kind: "agent-console",
    paneId: "pane-agent-console-surface",
    entity: { kind: "agent", id: agentId },
    frameStore: new FrameStore(),
    uiStateStore: UiStateStore.opening(),
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
    // Nothing opened this pane from another: every tier mounts one body directly.
    linkedSourcePaneId: undefined,
    focusHue: undefined,
    bridge,
    sessionStore,
  };
}

/** An open session with no history, folded the way a window folds one. */
function agentsSessionStore(): SessionStore {
  const store = new SessionStore({
    sessionId: SESSION_ID,
    projectors: COMPOSED_CONSOLE_PROJECTORS,
  });
  store.initialise({ cursor: 0, entities: [] });
  return store;
}

/** The pane mounted over the fixture roster, addressed at the agent on `claude`. */
async function mountAgentsPane(): Promise<{
  readonly container: HTMLElement;
  readonly bridge: ConsoleBridge;
}> {
  const bridge = createFixtureBridge({ scenario: unscriptedScenario("agents-screenshot") });
  const context = paneContext(bridge, agentsSessionStore(), AGENT_ON_CLAUDE.agentId);
  const { container } = await renderSettled(<AgentConsolePaneBody context={context} />);
  await settleReads(bridge);
  // Deliberately NOT inside `act`: the roster read resolves in a promise React knows
  // nothing about, and an `act` scope holds the resulting commit back until it exits,
  // so a wait placed inside one waits for a render its own scope prevents.
  await waitFor(() => {
    if (container.querySelector(".meridian-agent-card") === null) {
      throw new Error("the roster read has not landed yet");
    }
  });
  return { container, bridge };
}

/** The whole agent console pane, chrome and column, over the fixture roster. */
export async function mountAgentConsolePane(): Promise<HTMLElement> {
  const { container } = await mountAgentsPane();
  return requireRendered(container, ".meridian-pane");
}
