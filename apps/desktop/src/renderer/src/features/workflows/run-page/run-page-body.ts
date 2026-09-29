// The workflow run pane's body, as the pane layout's registry loads it, and the root of its
// chunk.
//
// A LOADER-BACKED BODY. A run pane opens from the workflows destination's run list and
// from a run address; nothing paints it before a person asks for one. What rides behind
// the boundary with it is this pane's whole subtree — the run snapshot, the control
// dispatch, the park surfaces, the version chain, and the operator controls' own
// stylesheet — none of which a session that never opens a run has any use for.
//
// THE CONTROLS' CLASS HAS ONE OWNER. This family's block is
// `meridian-workflow-run-controls`, so deferring this body cannot change how its
// controls lay out by moving its sheet in the cascade, and the module-shape rule in
// `apps/desktop/AGENTS.md` is what keeps a collision from landing unnoticed.
//
// THE FEATURE'S SHARED CHROME ENTERS HERE. `WorkflowStateStrip.css` styles every workflows
// body, and each chunk root imports it rather than relying on another root having loaded.
//
// Named `Body` because `seats/lazy-body/lazy-body.ts` fixes the export name a loader resolves.

import "../components/WorkflowStateStrip.css";

import { createElement } from "react";

import { RunPage } from "./RunPage.js";
import { paneBodyForKind, type PaneContext } from "@renderer/console/seats/index.js";

/**
 * The run pane, at an address the pane layout resolved.
 *
 * Narrowed to this kind's own address arm before the body sees it, so the body reads the
 * entity its kind admits and nothing else. `createElement` rather than JSX: this is a
 * `.ts` module, and the naming rule reserves `.tsx` for a single PascalCase component per
 * file.
 */
export const Body: (context: PaneContext) => React.ReactNode = paneBodyForKind(
  "workflow-run",
  (context) => createElement(RunPage, { context }),
);
