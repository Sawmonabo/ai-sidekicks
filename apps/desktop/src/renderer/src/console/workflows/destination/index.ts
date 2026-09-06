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
// composes leave through here. The stylesheet does not: it enters through
// `workflows.css`, which is the family's one entry point for the sheets it owns.
export { WorkflowsDestination } from "./WorkflowsDestination.js";
export {
  FOLLOWING_WINDOW_RETENTION,
  scopeSessionIdFor,
  type WorkflowsScopeState,
} from "./destination-scope.js";
