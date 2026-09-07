// The workflow run pane's body, as the deck's registry loads it, and the root of its
// chunk.
//
// A LOADER-BACKED BODY. A run pane opens from the workflows destination's run list and
// from a run address; nothing paints it before a person asks for one. What rides behind
// the boundary with it is this pane's whole subtree — the run snapshot, the control
// dispatch, the park surfaces, the version chain, and the operator controls' own
// stylesheet — none of which a session that never opens a run has any use for.
//
// IT STAYED STATIC FOR ONE ROUND, AND THE REASON IS WORTH KEEPING. `run-controls.css`
// declared `.meridian-run-controls`, and so did `runs/pane/runs.css` — two families, two
// components, one class name — so deferring this body moved this sheet to the end of the
// cascade and changed how a surface in THIS family laid its controls out, with nothing in
// the diff naming either sheet. The fix was not to keep the body eager: it was to give the
// class one owner. This family's block is `meridian-workflow-run-controls` now, the runs
// family keeps the unprefixed name it was already declaring, and
// `test/console/architecture/stylesheet-selector-owners.test.ts` holds the census that
// keeps a second collision from landing unnoticed.
//
// THE FAMILY'S CHROME ENTERS HERE, beside the pane's own sheet one directory down. Every
// workflows body is loader-backed now, so `workflows.css` reaches no session from the
// family door and each chunk root names it instead — `agents/agent-console`'s precedent:
// this root and the destination's are two independent first paints of one family's
// chrome, and one of them relying on the other having run is a coupling with no name.
//
// Named `Body` because `seats/lazy-body.ts` fixes the export name a loader resolves.

import "../workflows.css";

import { createElement } from "react";

import { WorkflowRunPane } from "./run/index.js";
import { paneBodyForKind, type ConsolePaneContext } from "../../seats/index.js";

/**
 * The run pane, at an address the deck resolved.
 *
 * Narrowed to this kind's own address arm before the body sees it, so the body reads the
 * entity its kind admits and nothing else. `createElement` rather than JSX: this is a
 * `.ts` module, and the naming rule reserves `.tsx` for a single PascalCase component per
 * file.
 */
export const Body: (context: ConsolePaneContext) => React.ReactNode = paneBodyForKind(
  "workflow-run",
  (context) => createElement(WorkflowRunPane, { context }),
);
