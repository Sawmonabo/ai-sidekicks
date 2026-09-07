// The inspector pane's door: one kind claimed, one body behind it.
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

// THE SHEET IS NOT IMPORTED HERE — the runs pane's rule, for the runs pane's reason:
// the pane is loader-backed, so `pane/inspector-pane-body.ts` is the directory carrying
// the chunk and therefore the sheet's owner.

import { type ConsolePaneRegistry } from "../seats/index.js";

/**
 * Claim the `inspector` kind.
 *
 * The descriptor makes no claim about being torn off — `isDetachablePaneKind` is
 * the one answer, read off the window model rather than advertised here, and the
 * inspector is not among the kinds it admits.
 */
export function registerInspectorPane(registry: ConsolePaneRegistry): void {
  registry.register({
    kind: "inspector",
    owner: "inspector-pane",
    // A LOADER AND NOT A `render`: this pane is not on the flagship first paint, so
    // its body, its readers, and its sheets ride the chunk the specifier below names
    // rather than the initial import graph. `apps/desktop/AGENTS.md` states the rule
    // beside the seat-board one.
    body: () => import("./pane/inspector-pane-body.js"),
  });
}
