// The inspector pane's registration: one kind claimed, one body behind it.
//
// The feature's door publishes the registrar below and `app/registrations.ts` calls it.
// A feature registers through its own registrar and never edits the pane registry or the
// pane-kind set.
//
// The owner string is the KIND's owner rather than the family's. The registry
// refuses a second owner on one kind, and a refusal that named a whole family would
// leave a reader hunting three directories for which body is already there.

// THE SHEET IS NOT IMPORTED HERE — the runs pane's rule, for the runs pane's reason:
// the pane is loader-backed, so `pane/inspector-pane-body.ts` is the directory carrying
// the chunk and therefore the sheet's owner.

import { type ConsolePaneRegistry } from "@renderer/console/seats/index.js";

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
    body: () => import("./inspector-pane-body.js"),
  });
}
