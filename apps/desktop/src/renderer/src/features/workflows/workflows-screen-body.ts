// The workflows destination's body as the screen registry loads it, and the root of its chunk.
// `#/workflows` is a rail destination, so nothing paints it until a person opens it. The
// feature's shared chrome enters here. Named `Body` because `components/LazyBody/lazy-body.ts`
// fixes the export name a loader resolves.

import "./components/WorkflowStateStrip.css";

import { createElement } from "react";

import type { ScreenContext } from "@renderer/registries/screens/screen-context.js";
import { WorkflowsScreen } from "./WorkflowsScreen.js";

/** The workflows screen at the committed route; a pane body is composed from the whole context. */
export const Body: (context: ScreenContext) => React.ReactNode = (context) =>
  createElement(WorkflowsScreen, { context });
