// The accessory rail's door.
//
// One of the composer's three zones: the context meter, the quota chips, the
// compaction control, the queue shelf, the `+` menu with the attachment picker
// inside it, and the two seats other plans fill. Behind its own barrel so the lane
// that fills it edits a directory no sibling lane touches.
//
// The stylesheet is imported here and nowhere else, so a surface can never render
// an accessory that arrived without its CSS and the bundler sees one edge into the
// sheet rather than one per component.

import "./accessories.css";

export { ComposerAccessoryRail } from "./ComposerAccessoryRail.js";

// `StepIn` leaves through this door because the surface that mounts it is the runs
// pane rather than the rail: pausing a run and taking the floor is one act, and the
// place a person meets a run they want to take over is the row that lists it. The
// door is what keeps that a barrel import rather than a reach into this directory.
export { StepIn } from "./StepIn.js";
