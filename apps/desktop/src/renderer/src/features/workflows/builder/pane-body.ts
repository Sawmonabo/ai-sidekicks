// The workflow builder pane's body, as the pane layout's registry loads it, in its own chunk so
// a session that never authors a workflow does not pay for it.

import { createElement } from "react";

import { WorkflowBuilderPane } from "./WorkflowBuilderPane.js";
import { paneBodyForKind } from "#renderer/registries/panes/body-for-kind.js";
import { type PaneContext } from "#renderer/registries/panes/context.js";

/** The builder pane, narrowed to its own address arm before the body sees it. */
export const Body: (context: PaneContext) => React.ReactNode = paneBodyForKind(
  "workflow-builder",
  (context) => createElement(WorkflowBuilderPane, { context }),
);
