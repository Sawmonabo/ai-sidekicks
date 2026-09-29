// The workflow builder pane's body, as the deck's registry loads it.
//
// A loader-backed body for `workflow-run-pane-body.ts`'s reason, and the case is
// stronger here: the builder is the console's authoring surface, reached from the rail's
// workflows destination, and a session that never authors a workflow paid for all of it
// on every launch.
//
// THE FEATURE'S SHARED CHROME ENTERS HERE, on the run page body's reasoning.

import "../components/WorkflowStateStrip.css";

import { createElement } from "react";

import { WorkflowBuilderPane } from "./WorkflowBuilderPane.js";
import { paneBodyForKind, type PaneContext } from "@renderer/console/seats/index.js";

/** The builder pane, on the narrowing the run pane's module explains. */
export const Body: (context: PaneContext) => React.ReactNode = paneBodyForKind(
  "workflow-builder",
  (context) => createElement(WorkflowBuilderPane, { context }),
);
