// The approvals pane's door: one kind claimed, one body behind it.
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
import { ApprovalsPane } from "./ApprovalsPane.js";

// The sheet is imported here, at the pane's single door, for the reason
// `pane-chrome.tsx` gives for its own: every body behind this door renders through
// the registration below, so a body cannot arrive without its CSS, and the seat
// board six branches each replace one line in is never touched.
import "./approvals.css";

/**
 * Claim the `approvals` kind.
 *
 * `openInWindow: true` — an approvals queue is one of the two things a person
 * most wants beside the work rather than on top of it, and the pane holds only a
 * read and two answers, neither of which is bound to this window.
 */
export function registerApprovalsPane(registry: ConsolePaneRegistry): void {
  registry.register({
    kind: "approvals",
    owner: "approvals-pane",
    // `createElement` rather than JSX: this is a `.ts` module, and the naming rule
    // reserves `.tsx` for a single PascalCase component per file.
    render: (context) => createElement(ApprovalsPane, context),
    openInWindow: true,
  });
}
