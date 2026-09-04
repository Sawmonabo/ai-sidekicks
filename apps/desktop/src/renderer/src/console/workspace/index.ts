// The workspace family's door.
//
// The family holds the SESSION WORKSPACE itself: the cast bar, the deck that holds
// the panes the seats hand it, the auxiliary-window hand-off, and the new-session
// draft. Those are bodies rather than seams, and they live together because the deck
// and the seat contracts are two halves of one thing — the seats declare what may be
// mounted and the deck is what mounts it.
//
// The seat contracts themselves are NOT here. They live in the `seats/` family, which
// sits directly above `bridge/` and below `frame/`, because a contract two view
// families hand each other may not sit in either of them. This family is a VIEW
// FAMILY at the top of the console DAG: it imports `seats/` and every layer below,
// and no sibling view family imports it. A barrel here that re-exported `seats/`
// would be a chain — the structure gate names that shape and fails it — and would
// also let a sibling reach a seat through a view family's door.
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

export { PaneHeader } from "./deck/PaneHeader.js";

// "+ New" is a control on the all-sessions list rather than inside a session, so it
// leaves the family through the same door the workspace itself does. `families.ts`
// names it and the frame's sessions descriptor mounts it: the frame sits BELOW this
// family in the console DAG and may not import it, so the composition root — which
// is above every family — is the one place that can say which component fills that
// place. No `@consumedBy` marker rides it; its consumer landed in the same change.
export { NewSessionControl } from "./NewSessionControl.js";

export { Workspace } from "./Workspace.js";
