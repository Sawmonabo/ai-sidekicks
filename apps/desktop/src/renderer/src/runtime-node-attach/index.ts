// Barrel for the runtime-node-attach renderer views (Plan-003 Phase 5 —
// directory complete: T5.1 NodeRoster, T5.2 AttachFlow + CapabilityDeclaration,
// T5.3 MixedVersionStatus; T5.4 is the manual smoke and adds no files).
// Mirrors the minimal `session-bootstrap/index.ts` idiom (re-export via a
// `.js` specifier) and additionally re-exports each view's consumer-facing
// props type — plus the `RuntimeNodeAttachDraft` request-draft alias — which
// the prop-less `SessionBootstrap` has no need for: these are the prop
// contracts a future Plan-023 router/deep-link needs to render the views. The
// `.js` extension matches the shipped barrel; TypeScript's extension
// substitution resolves it to `.tsx` under the renderer's
// `moduleResolution: "bundler"` graph as well.
//
// `@public` on each line below, added by Plan-023 T-023p-1C-1. That task is the
// first consumer this barrel has ever had — the console mounts `NodeRoster` on its
// `agent-console` slot — and making the file reachable is exactly what exposed the
// other three views to the dead-code gate, which had nothing to report while
// nobody imported the barrel at all. The three are not dead: they are the rest of
// the attach flow, waiting on the console surfaces that mount them, which is the
// same thing the paragraph above already says about the props types. `@public`
// records that as API rather than letting a later reader delete a shipped family's
// views because a gate called them unused.

/** @public Plan-003 T5.2; mounted by a later Plan-023 console surface. */
export { AttachFlow, type AttachFlowProps, type RuntimeNodeAttachDraft } from "./AttachFlow.js";
/** @public Plan-003 T5.2; mounted by a later Plan-023 console surface. */
export { CapabilityDeclaration, type CapabilityDeclarationProps } from "./CapabilityDeclaration.js";
/** @public Plan-003 T5.3; mounted by a later Plan-023 console surface. */
export { MixedVersionStatus, type MixedVersionStatusProps } from "./MixedVersionStatus.js";
/** @public Plan-003 T5.1; mounted by the console's `agent-console` slot. */
export { NodeRoster, type NodeRosterProps, type NodeRosterReads } from "./NodeRoster.js";
