// The workflow run pane's body and the root of its chunk: the whole subtree (snapshot, park
// cards) loads only when a run pane opens. `WorkflowStateStrip.css` is imported here so no chunk relies on another root having
// loaded it. Named `Body` because `components/LazyBody/lazy-body.ts` fixes the export name.

import "../components/WorkflowStateStrip.css";

import { createElement } from "react";

import { RunPage } from "./RunPage.js";
import { paneBodyForKind } from "@renderer/registries/panes/pane-body-for-kind.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";

/**
 * The run pane, at an address the pane layout resolved and narrowed to this kind's arm.
 * Uses `createElement` because this is a `.ts` module.
 */
export const Body: (context: PaneContext) => React.ReactNode = paneBodyForKind(
  "workflow-run",
  (context) => createElement(RunPage, { context }),
);
