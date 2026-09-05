// The approvals pane's door: one kind claimed, one body behind it.
//
// THE FAMILY DOOR, and the family's one barrel. The body lives under `pane/` beside
// this file rather than inside `panes/`: that directory is a COMPOSITION SITE, which
// sits above every family by construction, so a body parked there is reachable from a
// sibling family only by an upward import the layering gate cannot see — both
// composition sites are subtracted from its endpoints so `panes/index.ts` may name
// every family. `panes/index.ts` calls the function below; nothing else here is
// reachable from outside this directory.
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

import { type ConsolePaneRegistry } from "../seats/index.js";
import { paneBodyForKind } from "../panes/pane-chrome.js";
import { ApprovalsPane } from "./pane/ApprovalsPane.js";

// The sheet is imported here, at the pane's single door, for the reason
// `pane-chrome.tsx` gives for its own: every body behind this door renders through
// the registration below, so a body cannot arrive without its CSS, and the seat
// board six branches each replace one line in is never touched.
import "./pane/approvals.css";
// The sections this pane hosts carry their own sheet beside the pane's, split at
// the same seam their components are: the rules that address selectors in BOTH
// sheets — the pane-wide control metrics and the one focus ring — stay in
// `approvals.css` as a single declaration rather than being written twice.
import "./pane/approvals-sections.css";

/**
 * Claim the `approvals` kind.
 *
 * The descriptor makes no claim about being torn off. Whether a kind may move into
 * an auxiliary window is `isDetachablePaneKind`'s single answer, derived from the
 * window model rather than advertised by whoever owns the body — and it answers no
 * for this one, because the two auxiliary windows the shell opens are named
 * elsewhere and neither is an approvals queue.
 */
export function registerApprovalsPane(registry: ConsolePaneRegistry): void {
  registry.register({
    kind: "approvals",
    owner: "approvals-pane",
    // Narrowed to this kind's own address arm before the body sees it, so the body
    // reads the entity its kind admits and nothing else. `createElement` rather than
    // JSX: this is a `.ts` module, and the naming rule reserves `.tsx` for a single
    // PascalCase component per file.
    render: paneBodyForKind("approvals", (context) => createElement(ApprovalsPane, context)),
  });
}
