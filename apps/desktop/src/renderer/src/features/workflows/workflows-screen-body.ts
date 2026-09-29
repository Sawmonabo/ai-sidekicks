// The workflows destination's body, as the surface registry loads it, and the root of
// its chunk.
//
// A loader-backed surface. `#/workflows` is a rail destination: nothing paints it until a
// person presses the rail or types the address, which is the test `apps/desktop/AGENTS.md`
// states for the loader form. The family's pane kinds are loader-backed registrations of
// their own, so a session that opens the destination and never a pane pays for neither.
//
// THE FEATURE'S SHARED CHROME ENTERS HERE, on the run page body's reasoning.
//
// Named `Body` because `seats/lazy-body/lazy-body.ts` fixes the export name a loader resolves.

import "./components/WorkflowStateStrip.css";

import { createElement } from "react";

import type { ConsoleSurfaceContext } from "@renderer/console/seats/index.js";
import { WorkflowsDestination } from "./WorkflowsScreen.js";

/**
 * The workflows screen, at the route the frame committed. It takes the whole context
 * because a pane body is composed from it: a bridge, both stores, the window store and the
 * pane's own address.
 */
export const Body: (context: ConsoleSurfaceContext) => React.ReactNode = (context) =>
  createElement(WorkflowsDestination, { context });
