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

// THE STYLESHEETS ARE NOT IMPORTED HERE. The pane is loader-backed, so the directory
// that owns its sheets is the one carrying the chunk — `pane/approvals-pane-body.ts` —
// and a sheet on this door would put an unopened queue's rules on the initial document
// of every session. `apps/desktop/AGENTS.md` keys the rule on ownership rather than on
// depth, which is what makes the chunk root the owner here.

import { type ConsolePaneRegistry } from "../seats/index.js";

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
    // A LOADER AND NOT A `render`: this pane is not on the flagship first paint, so
    // its body, its readers, and its sheets ride the chunk the specifier below names
    // rather than the initial import graph. `apps/desktop/AGENTS.md` states the rule
    // beside the seat-board one.
    body: () => import("./pane/approvals-pane-body.js"),
  });
}
