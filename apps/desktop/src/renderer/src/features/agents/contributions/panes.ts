// The Agents pane's registration, called from `app/registrations.ts`.

import { type PaneRegistry } from "#renderer/registries/panes/pane-registry.js";

/** The owner string this body's claim carries, so a hot reload replaces. */
const AGENTS_PANE_OWNER = "agents";

/**
 * Claims the `agents` pane kind with a loader-backed body wearing the shared chrome. The body
 * module composes the chrome from the pane's address (session and agent reference); it passes
 * no head actions and no host controls, since close and tear-off are the pane layout's and
 * reach the chrome through context.
 */
export function registerAgentsPane(registry: PaneRegistry): void {
  registry.register({
    kind: "agents",
    owner: AGENTS_PANE_OWNER,
    // A loader, not a `render`, so the body stays off the initial import graph.
    body: () => import("../pane/agents-pane-body.js"),
  });
}
