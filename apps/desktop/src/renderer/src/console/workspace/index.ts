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
// SEVEN SUB-MODULES AND THE WORKSPACE ITSELF. `cast-bar/` is who is in the session and
// what still waits on a person, with the chip press that follows an actor; `deck/` is
// the pane board, its drag, and its rect discipline; `sidebar/` is the session's own
// list of sections; `layout/` is how a deck and a sidebar are written down and read
// back; `auxiliary/` is a pane moved into a window of its own and the signal that says
// its window died; `new-session/` is the draft and the control that sends it; and
// `banners/` is what the surface says when something is wrong with the session as a
// whole. `Workspace.tsx` composes them and owns nothing else.
//
// The root held all of that as one list of forty-three modules, each one `./` from
// every other, which recorded nothing about which of them were allowed to know about
// which — the condition `ledger/pane/index.ts` says the DAG rule exists to prevent,
// one level down and with no rule reaching it. `ledger/view-family-directory-shape.test.ts`
// now reads this family too, at the same ceiling.
//
// NONE OF THE SEVEN CARRIES A DOOR, which is a decision rather than an omission. A
// sub-module door is permitted and not required, and this family's two oldest
// sub-modules do without one: `deck/` is read by five modules outside itself and is
// reached deep, module by module, every time. A door on the five this split created
// would have made one family speak two conventions, and it would have
// published a wider surface than any caller asked for — a barrel exports whatever it
// lists, whether or not anything imports it. Every reader here names the module it
// wants.
//
// The family's stylesheets are imported HERE and nowhere else, so a surface can never
// render a workspace element that arrived without its rules. There are four of them —
// the shell, the cast bar, the deck, and the sidebar — each beside the modules it
// styles, and imported together so the family's rules stay one contiguous block in
// the bundle's cascade.
//
// WHAT THE DOOR CARRIES IS WHAT LEAVES THE FAMILY, AND NOTHING MORE. The deck's
// layout, its snapshot grammar, its density presets, its rect discipline, the
// hand-off, and the draft are all reached from inside this family by their own
// modules; re-exporting them here would publish a surface no consumer has asked
// for, and the dead-code gate reports exactly that. A view family that needs one
// adds its line in the commit that imports it.

import "./workspace.css";
import "./cast-bar/cast-bar.css";
import "./deck/deck.css";
import "./sidebar/sidebar.css";

// "+ New" is a control on the all-sessions list rather than inside a session, so it
// leaves the family through the same door the workspace itself does. `families.ts`
// names it and the frame's sessions descriptor mounts it: the frame sits BELOW this
// family in the console DAG and may not import it, so the composition root — which
// is above every family — is the one place that can say which component fills that
// place. No `@consumedBy` marker rides it; its consumer landed in the same change.
export { NewSessionControl } from "./new-session/NewSessionControl.js";

export { Workspace } from "./Workspace.js";
