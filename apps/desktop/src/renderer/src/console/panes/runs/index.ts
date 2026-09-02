// The runs pane's door: one kind claimed, one body behind it.
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

import { type ConsolePaneRegistry } from "../../workspace/index.js";
import { RunsPane } from "./RunsPane.js";

/**
 * Claim the `runs` kind.
 *
 * `openInWindow: true` — the runs list is a read over session state with no
 * main-process view and no process lease behind it, so it follows a tear-off
 * without its owning plan having to say how.
 */
export function registerRunsPane(registry: ConsolePaneRegistry): void {
  registry.register({
    kind: "runs",
    owner: "runs-pane",
    // `createElement` rather than JSX: this is a `.ts` module, and the naming rule
    // reserves `.tsx` for a single PascalCase component per file.
    render: (context) => createElement(RunsPane, context),
    openInWindow: true,
  });
}
