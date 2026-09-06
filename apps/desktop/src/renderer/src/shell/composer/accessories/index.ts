// The accessory rail's door.
//
// One of the composer's zones: the context meter, the quota chips, the
// compaction control, the queue shelf, the `+` menu with the attachment picker
// inside it, and the two seats other plans fill. Behind its own barrel so the lane
// that fills it edits a directory no sibling lane touches.
//
// AND EACH OF THOSE IS A SUB-MODULE DIRECTORY, not a file at this level. The zone had
// grown to forty files in one flat pile while the same delta grouped the runs pane's
// bodies, and the lines were already drawn by the file names: `context-meter/`,
// `quotas/`, `compaction/`, `queue-shelf/`, and `plus-menu/`, each holding its own
// bodies, its own model, and its own cases. What stays at this level is what the
// zone itself owns — the rail, the bounds it spends, the timeline folds it performs
// before handing a figure down, the sheet, its own two suites and their support, and
// the one seat that has no sub-module to sit in.
//
// NONE OF THE FIVE CARRIES A DOOR, deliberately. `apps/desktop/AGENTS.md` admits a
// sub-module barrel and admits deep intra-family specifiers, and outside this zone
// only the rail reads into them: a barrel re-exporting one component to one importer
// is a re-export shim, and a specifier that names the file says more than one that
// names a directory.
//
// The stylesheet is imported here and nowhere else, so a surface can never render
// an accessory that arrived without its CSS and the bundler sees one edge into the
// sheet rather than one per component.

import "./accessories.css";

export { ComposerAccessoryRail } from "./ComposerAccessoryRail.js";
