// Mounting the pane over a store and a bridge a case owns, for the suites that need one.
//
// Separate from `agent-console.test-support.ts` for one reason: this renders, and a
// module with JSX in it is a `.tsx`. What is shared with that module — the session id,
// the read fixtures, and the settle — is imported from it rather than restated, so the
// directory has one session and one settle rather than one per file.
//
// THE STORE CARRIES THE WINDOW'S OWN PROJECTORS. A pane keyed by a run reads that run
// out of the projected partition, so a store with no projectors would leave every
// linkage case asserting against a partition nothing ever writes to.

import { render } from "@testing-library/react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { RUN_LIFECYCLE_PROJECTORS } from "../../frame/run-lifecycle-projector.js";
import { SessionStore } from "../../store/index.js";
import { PROJECTION_SESSION_ID } from "./agent-console.test-support.js";
import { AgentConsoleBody } from "./AgentConsoleBody.js";

/** The agent every owned-pane case is pointed at. */
export const OWNED_AGENT_ID = "agent-scout";

/** A store with the window's own projectors, so a run beat projects a run row. */
export function projectingStore(): SessionStore {
  const sessionStore = new SessionStore({
    sessionId: PROJECTION_SESSION_ID,
    projectors: RUN_LIFECYCLE_PROJECTORS,
  });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return sessionStore;
}

/** Mount the pane over a store and a bridge the case owns. */
export function renderOwnedPane(bridge: ConsoleBridge, sessionStore?: SessionStore): HTMLElement {
  const { container } = render(
    <AgentConsoleBody
      sessionId={PROJECTION_SESSION_ID}
      agentId={OWNED_AGENT_ID}
      bridge={bridge}
      sessionStore={sessionStore}
    />,
  );
  return container;
}
