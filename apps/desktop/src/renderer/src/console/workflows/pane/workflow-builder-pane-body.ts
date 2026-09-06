// The workflow builder pane's body, as the deck's registry loads it.
//
// A loader-backed body for `workflow-run-pane-body.ts`'s reason, and the case is
// stronger here: the builder is the console's authoring surface, reached from the rail's
// workflows destination, and a session that never authors a workflow paid for all of it
// on every launch.

import { createElement } from "react";

import { WorkflowBuilderPane } from "./builder/index.js";
import { paneBodyForKind, type ConsolePaneContext } from "../../seats/index.js";

/** The builder pane, on the narrowing the run pane's module explains. */
export const Body: (context: ConsolePaneContext) => React.ReactNode = paneBodyForKind(
  "workflow-builder",
  (context) => createElement(WorkflowBuilderPane, { context }),
);
