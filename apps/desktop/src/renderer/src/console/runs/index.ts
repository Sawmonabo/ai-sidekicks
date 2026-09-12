// The runs pane's door: one kind claimed, one body behind it.
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

// THE PANE IS LOADER-BACKED AND ITS SHEETS ARE STILL IMPORTED HERE, which is the one
// place this family departs from the rule the other loader-backed panes follow, and
// the departure is measured rather than cautious.
//
// `pane/runs.css` used to declare `.meridian-run-row__failure`, which
// `workflows/runs/run-list.css` also declares — two families, two different components,
// one class name — so while both sheets were on the document the later one decided how
// the WORKFLOWS run list drew a failed run's line, and which was later was a property of
// the import graph rather than of either sheet. THE COLLISION IS SETTLED, and so is the
// borrowed prefix behind it: all seventeen `meridian-run-row__*` names this pane spelled
// are `meridian-runs__*` now, prefixed for `.meridian-runs`, the block this sheet's own
// file declares — two of them as `__detail-section` and `__detail-section-title`, because
// the flat names were already this sheet's own for the pane's top-level sections. Deferring these sheets onto the chunk root can no longer change a
// surface another family owns, so what remains is an ordinary bundle measurement rather
// than a cascade one.
//
// The `.meridian-run-controls` half of that coupling went the same way earlier: the
// workflows run pane's block carries its family's prefix, so this sheet's
// `flex-direction: column` styles this family's controls and nothing else. NOTHING is
// left of the coupling, so what holds these sheets here is the bundle measurement alone.
// The package's module-shape rule is what keeps a NEW one from landing unnoticed.

import { type ConsolePaneRegistry } from "../seats/index.js";

import "./pane/runs.css";
// The intervention surfaces carry their own sheet beside the pane's, split at the
// same seam their components are; rules addressing selectors in both sheets stay
// in `runs.css` as a single declaration, so the two travel together.
import "./pane/interventions/run-interventions.css";

/**
 * Claim the `runs` kind.
 *
 * The descriptor makes no claim about being torn off — `isDetachablePaneKind` is
 * the one answer, read off the window model rather than advertised here, and the
 * runs list is not among the kinds it admits.
 */
export function registerRunsPane(registry: ConsolePaneRegistry): void {
  registry.register({
    kind: "runs",
    owner: "runs-pane",
    // A LOADER AND NOT A `render`: this pane is not on the flagship first paint, so
    // its body, its readers, and its sheets ride the chunk the specifier below names
    // rather than the initial import graph. `apps/desktop/AGENTS.md` states the rule
    // beside the seat-board one.
    body: () => import("./pane/runs-pane-body.js"),
  });
}
