// The subject-scoped sub-module's door.
//
// A SUB-MODULE door and not a second family door: it publishes to `store/` only,
// it is reached by deep intra-family specifiers, and `store/index.ts` re-exports
// every one of these symbols from the module that DECLARES it rather than through
// this file (`console-no-barrel-chain`).
//
// It exists because three sibling sub-modules read this one: `read/` takes the
// resource hook and the subject key for its cancellation seam, `act/` takes both
// for its controller, and `session/` takes the state hook for its rebinding. The
// holder's own internals and the deadline wake are read only from inside this
// directory or from the family door, so they are not published here.

export type { SubjectKey } from "./subject-scoped-holder.js";
export {
  useSubjectScopedResource,
  type SubjectScopedDisposal,
  type SubjectScopedTerminalDisposal,
} from "./subject-scoped-resource.js";
export type { SubjectScopedState } from "./subject-scoped-state.js";
