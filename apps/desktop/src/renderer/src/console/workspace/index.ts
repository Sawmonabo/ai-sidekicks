// The workspace family's door.
//
// The family holds the session workspace's shared vocabulary — today, the seats
// through which the six view families hand each other panes, a composer, sidebar
// sections, timeline rows, and inline cards. A barrel and nothing else: the
// declarations live in `seats/`, which has its own barrel because a caller
// reaching for a seat is reaching for the seam and should say so in the import
// path.
//
// The family sits above `bridge/` and below the view families in the console's
// DAG, and it imports nothing from `frame/` or `palette/` — a seat that needed the
// frame would be a mount rather than a seam.
//
// It now also holds the SESSION WORKSPACE itself: the cast bar, the deck that holds
// the panes those seats hand it, the auxiliary-window hand-off, and the new-session
// draft. Those are bodies rather than seams, and they live here rather than in a
// seventh directory because the deck and the seats are two halves of one thing —
// the seats declare what may be mounted and the deck is what mounts it, and a
// family split between two doors would make every consumer pick.
//
// The family's stylesheet is imported HERE and nowhere else, so a surface can never
// render a workspace element that arrived without its rules.
//
// WHAT THE DOOR CARRIES IS WHAT LEAVES THE FAMILY, AND NOTHING MORE. The deck's
// layout, its snapshot grammar, its density presets, its rect discipline, the
// hand-off, and the draft are all reached from inside this family by their own
// modules; re-exporting them here would publish a surface no consumer has asked
// for, and the dead-code gate reports exactly that. A view family that needs one
// adds its line in the commit that imports it.

import "./workspace.css";

export * from "./seats/index.js";

export { PaneHeader } from "./deck/PaneHeader.js";

// "+ New" is a control on the all-sessions list rather than inside a session, so it
// leaves the family through the same door the workspace itself does. `families.ts`
// names it and the frame's sessions descriptor mounts it: the frame sits BELOW this
// family in the console DAG and may not import it, so the composition root — which
// is above every family — is the one place that can say which component fills that
// place. No `@consumedBy` marker rides it; its consumer landed in the same change.
export { NewSessionControl } from "./NewSessionControl.js";

export { Workspace } from "./Workspace.js";
