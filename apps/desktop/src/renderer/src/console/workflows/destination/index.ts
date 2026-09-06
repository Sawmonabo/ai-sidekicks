// The workflows destination: the surface a route resolves to, and the scope it is
// read under.
//
// A DIRECTORY BECAUSE THE SCOPE IS HALF THE SUBJECT. `destination-scope.ts` is the
// state the destination is addressed by — which sessions it offers, which one a
// following window retains — and the component and that state were two files at the
// zone level with nothing saying they were one reading.
//
// THE DOOR EXISTS BECAUSE A SIBLING TAKES FROM IT. `WorkflowsPaneHost.tsx` mounts the
// destination and holds its scope, so the component and the three scope names it
// composes leave through here.
//
// AND THE STYLESHEET ENTERS HERE, because this directory has a door and therefore an
// owner of its own. `workflows.css` used to `@import` it, which is a sheet in one
// directory made the reason another is styled at all — the shape the family sheet's
// own header calls forbidden, and which its three sibling doors (`pane/builder/`,
// `pane/run/`, `pane/run/phase-graph/`) already avoid by importing theirs.
import "./workflows-destination.css";

export { WorkflowsDestination } from "./WorkflowsDestination.js";
export {
  FOLLOWING_WINDOW_RETENTION,
  scopeSessionIdFor,
  type WorkflowsScopeState,
} from "./destination-scope.js";
