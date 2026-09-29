// The workflows destination's body, as the screen registry loads it, and the root of
// its chunk.
//
// A loader-backed screen. `#/workflows` is a rail destination: nothing paints it until a
// person presses the rail or types the address, which is the test `apps/desktop/AGENTS.md`
// states for the loader form. The feature's pane kinds are loader-backed registrations of
// their own, so a session that opens the destination and never a pane pays for neither.
//
// THE FEATURE'S SHARED CHROME ENTERS HERE, on the run page body's reasoning.
//
// Named `Body` because `components/LazyBody/lazy-body.ts` fixes the export name a loader resolves.

import "./components/WorkflowStateStrip.css";

import { createElement } from "react";

import type { ScreenContext } from "@renderer/registries/screens/screen-context.js";
import { WorkflowsScreen } from "./WorkflowsScreen.js";

/**
 * The workflows screen, at the route the frame committed. It takes the whole context
 * because a pane body is composed from it: a bridge, both stores, the window store and the
 * pane's own address.
 */
export const Body: (context: ScreenContext) => React.ReactNode = (context) =>
  createElement(WorkflowsScreen, { context });
