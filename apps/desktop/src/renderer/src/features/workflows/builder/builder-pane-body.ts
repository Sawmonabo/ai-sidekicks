// The workflow builder pane's body, as the pane layout's registry loads it, in its own chunk so
// a session that never authors a workflow does not pay for it. The strip's stylesheet is
// imported here because each chunk root imports it rather than relying on another having loaded.

import "../components/WorkflowStateStrip.css";

import { createElement } from "react";

import { WorkflowBuilderPane } from "./WorkflowBuilderPane.js";
import { paneBodyForKind } from "@renderer/registries/panes/pane-body-for-kind.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";

/** The builder pane, narrowed to its own address arm before the body sees it. */
export const Body: (context: PaneContext) => React.ReactNode = paneBodyForKind(
  "workflow-builder",
  (context) => createElement(WorkflowBuilderPane, { context }),
);
