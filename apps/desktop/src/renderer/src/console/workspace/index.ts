// The workspace family's door.
//
// The family holds the SESSION WORKSPACE itself: the session header, the deck that holds
// the panes the seats hand it, and the new-session draft. Those are bodies rather than
// seams, and they live together because the deck and the seat contracts are two halves of
// one thing — the seats declare what may be mounted and the deck is what mounts it.
//
// The seat contracts themselves are NOT here. They live in the `seats/` family, which
// sits directly above `bridge/` and below `frame/`, because a contract two view
// families hand each other may not sit in either of them. This family is a VIEW
// FAMILY at the top of the console DAG: it imports `seats/` and every layer below,
// and no sibling view family imports it. A barrel here that re-exported `seats/`
// would be a chain — the structure gate names that shape and fails it — and would
// also let a sibling reach a seat through a view family's door.
//
// FIVE SUB-MODULES AND THE WORKSPACE ITSELF. `session-header/` is which session this is;
// `deck/` is the pane board, its drag, and its rect discipline; `layout/` is how a deck
// is written down and read back; `new-session/` is the draft and the control that sends
// it; and `banners/` is what the surface says when something is wrong with the session
// as a whole. `Workspace.tsx` composes them and owns nothing else.
//
// NONE OF THE FIVE CARRIES A DOOR, which is a decision rather than an omission. A
// sub-module door is permitted and not required, and a barrel exports whatever it lists,
// whether or not anything imports it. Every reader here names the module it wants.
//
// The family's stylesheets are imported HERE and nowhere else, so a surface can never
// render a workspace element that arrived without its rules. There are three of them —
// the shell, the session header, and the deck — each beside the modules it styles, and
// imported together so the family's rules stay one contiguous block in the bundle's
// cascade.
//
// WHAT THE DOOR CARRIES IS WHAT LEAVES THE FAMILY, AND NOTHING MORE. The deck's
// layout, its snapshot grammar, its density presets, its rect discipline, and the draft
// are all reached from inside this family by their own modules; re-exporting them here
// would publish a surface no consumer has asked for, and the dead-code gate reports
// exactly that. A view family that needs one adds its line in the commit that imports it.

import "./workspace.css";
import "@renderer/features/sessions/session-header/components/SessionHeader.css";
import "@renderer/features/sessions/pane-layout/components/pane-layout.css";

// "+ New" is a control on the all-sessions list rather than inside a session, so it
// leaves the family through the same door the workspace itself does. The frame sits
// BELOW this family in the console DAG and may not import it, so the composition
// root — which is above every family — is the one place that can mount it.
//
// Its PROPS leave through no door here at all. They are the seam two view families
// meet on — this one declares the control, the sessions family mounts it — so they
// live in `seats/slots/new-session-seat.ts` and both sides import them from there.
export {
  /** @consumedBy the all-sessions list, which mounts "+ New" */
  NewSessionControl,
} from "@renderer/features/sessions/new-session/components/NewSessionControl.js";

export {
  /** @consumedBy the session header's title */
  useSessionHeaderIdentity,
} from "@renderer/features/sessions/session-header/hooks/useSessionIdentity.js";

export { Workspace } from "./Workspace.js";
