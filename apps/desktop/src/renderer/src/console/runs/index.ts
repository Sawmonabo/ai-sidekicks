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
// `pane/runs.css` declares `.meridian-run-controls`, and so does
// `workflows/pane/run/run-controls.css` — two families, two different components,
// one class name, disjoint children. While both sheets were on the initial document
// this one loaded second and its `flex-direction: column` decided how the WORKFLOWS
// run pane's operator controls lay out. Moving these sheets onto the chunk root took
// that sheet off the document for any session that never opens a runs pane, which is
// the whole point of the boundary — and it silently changed a surface belonging to
// another family: the workflow-run pane's committed screenshot reference is 1440×1751
// with the controls stacked, and without this sheet it renders 1440×1172 with them
// side by side (measured 2026-09-06, `test/console/screenshot/workflows.test.tsx`).
//
// So the sheets stay on the door. A bundle-boundary change must not decide how another
// family's surface looks, and the collision itself is the thing to fix — deliberately,
// with whichever layout the console actually wants and a regenerated reference — rather
// than as a side effect here. `test/console/architecture/stylesheet-selector-owners.test.ts`
// holds the collision census so a SECOND one cannot land unnoticed.

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
