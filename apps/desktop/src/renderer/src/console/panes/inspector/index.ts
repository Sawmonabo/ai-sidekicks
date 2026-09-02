// The inspector pane's door: one kind claimed, one body behind it.
//
// A pane family registers through its own barrel and never edits the pane registry
// or the pane-kind set — `panes/index.ts` says why, and the short version is that a
// registry six branches edit at once is a merge that resolves cleanly while
// dropping someone's registration.
//
// The owner string is the KIND's owner rather than the family's. The registry
// refuses a second owner on one kind, and a refusal that named a whole family would
// leave a reader hunting three directories for which body is already there.

import { createElement } from "react";

// The sheet, imported from this subtree's door and from nowhere else — the runs
// pane's rule, for the runs pane's reason.
import "./inspector.css";

import { type ConsolePaneRegistry } from "../../workspace/index.js";
import { InspectorPane } from "./InspectorPane.js";

/**
 * Claim the `inspector` kind.
 *
 * `openInWindow: true` — the inspector is a read over one entity, so a torn-off
 * inspector is the same pane in another window and nothing follows it.
 */
export function registerInspectorPane(registry: ConsolePaneRegistry): void {
  registry.register({
    kind: "inspector",
    owner: "inspector-pane",
    // `createElement` rather than JSX: this is a `.ts` module, and the naming rule
    // reserves `.tsx` for a single PascalCase component per file.
    render: (context) => createElement(InspectorPane, context),
    openInWindow: true,
  });
}
