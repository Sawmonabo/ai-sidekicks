// The workflows destination's body, as the surface registry loads it, and the root of
// its chunk.
//
// A loader-backed surface. `#/workflows` is a rail destination: nothing paints it until a
// person presses the rail or types the address, which is the test `apps/desktop/AGENTS.md`
// states for the loader form. The family's pane kinds are loader-backed registrations of
// their own, so a session that opens the destination and never a pane pays for neither.
//
// `workflows.css` is the chrome every workflows body stands in, and every body is behind a
// loader, so each chunk root names it. `definitions/definitions-browser.css` travels with
// this chunk alone. The family door imports `runs/run-list.css` and `parks/park-badge.css`
// itself, so this chunk does not.
//
// Named `Body` because `seats/lazy-body/lazy-body.ts` fixes the export name a loader resolves.

import "./components/WorkflowStateStrip.css";
import "./definitions/components/DefinitionListItem.css";

import { createElement } from "react";

import type { ConsoleSurfaceContext } from "@renderer/console/seats/index.js";
import { WorkflowsPaneHost } from "@renderer/console/workflows/WorkflowsPaneHost.js";

/**
 * The workflows destination, at the route the frame committed.
 *
 * The host rather than the destination alone, because the destination opens panes and the
 * slot needs a place to put one. It takes the whole context because a pane body is composed
 * from it: a bridge, both stores, the window store and the pane's own address.
 */
export const Body: (context: ConsoleSurfaceContext) => React.ReactNode = (context) =>
  createElement(WorkflowsPaneHost, { context });
