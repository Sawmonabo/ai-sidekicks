// The accessory rail's door.
//
// The composer's trailing rail: the attachment strip and the context meter. Each lives in
// a sub-module directory (`attachments/`, `context-meter/`), and `queue-shelf/` holds the
// rule for which queued rows are waiting. What stays at this level is the rail, the
// timeline folds it performs before handing a figure down, the sheet, and the rail's suite
// and its support.
//
// None of the sub-modules carries a door: only the rail reads into them, a barrel
// re-exporting one component to one importer is a re-export shim, and a specifier that
// names the file says more than one that names a directory.
//
// The stylesheet is imported here and nowhere else, so a surface can never render an
// accessory that arrived without its CSS and the bundler sees one edge into the sheet
// rather than one per component.

import "@renderer/features/composer/components/ComposerToolbar.css";
// `attachments/` carries no door, so its sheet is imported here, after the zone's own,
// which declares the shared control shape those rules extend.
import "@renderer/features/composer/attachments/AttachmentStrip.css";

export { ComposerAccessoryRail } from "@renderer/features/composer/components/ComposerToolbar.js";
