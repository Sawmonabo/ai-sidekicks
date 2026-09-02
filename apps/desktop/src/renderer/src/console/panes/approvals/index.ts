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

import { type ConsolePaneRegistry } from "../../seats/index.js";
import { paneBodyForKind } from "../pane-chrome.js";
import { ApprovalsPane } from "./ApprovalsPane.js";

// The fold this pane reads, published from the module that declares it. It leaves
// through this door rather than being deep-imported by the composition, because the
// composer family is a different family and a cross-family import goes through the
// door — and it is a SECOND entry point rather than a member of `registerApprovalsPane`
// because the two write into two different boards: one claims a pane kind and the
// other claims event kinds, and a registrar taking both registries would hide which
// of them a caller was composing.
export { registerApprovalFlowProjectors } from "./approval-flow-projector.js";

// The sheet is imported here, at the pane's single door, for the reason
// `pane-chrome.tsx` gives for its own: every body behind this door renders through
// the registration below, so a body cannot arrive without its CSS, and the seat
// board six branches each replace one line in is never touched.
import "./approvals.css";

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
