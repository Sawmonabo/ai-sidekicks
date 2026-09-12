// Barrel for the runtime-node-attach renderer views: NodeRoster, AttachFlow +
// CapabilityDeclaration, and MixedVersionStatus.
//
// Mirrors the minimal `session-bootstrap/index.ts` idiom (re-export via a
// `.js` specifier) and additionally re-exports each view's consumer-facing
// props type — plus the `RuntimeNodeAttachDraft` request-draft alias, taken
// from `attach-request.ts`, which declares it — which the prop-less
// `SessionBootstrap` has no need for: these are the prop contracts a router or
// deep-link needs to render the views. The `.js` extension matches the shipped
// barrel; TypeScript's extension substitution resolves it to `.tsx` under the
// renderer's `moduleResolution: "bundler"` graph as well.
//
// `@public` on each line below. The console mounts `NodeRoster` through
// `console/seats/surface/absorbed-surfaces.ts`, in the agent console and on the
// runtime-nodes settings page, and making the file reachable is exactly what
// exposed the other three views to the dead-code gate, which had nothing to
// report while nobody imported the barrel at all. The three are not dead: they
// are the rest of the attach flow, waiting on the console surfaces that mount
// them, which is the same thing the paragraph above already says about the props
// types. `@public` records that as API rather than letting a later reader delete
// a shipped family's views because a gate called them unused.

/** @public Mounted by a later console surface. */
export { AttachFlow, type AttachFlowProps } from "./AttachFlow.js";
/** @public The request draft, declared beside the request it composes. */
export { type RuntimeNodeAttachDraft } from "./attach-request.js";
/** @public The attach seam every mount may supply; declared beside the call it names. */
export { type RuntimeNodeAttachReads } from "./attach-request.js";
/** @public Composes that seam over a host's own bridge, so the procedure name has one home. */
export { attachReadsOverControlPlane, type ControlPlaneAttachCall } from "./attach-request.js";
/** @public Mounted by a later console surface. */
export { CapabilityDeclaration, type CapabilityDeclarationProps } from "./CapabilityDeclaration.js";
/** @public Mounted by a later console surface. */
export { MixedVersionStatus, type MixedVersionStatusProps } from "./MixedVersionStatus.js";
/** @public Mounted by the agent console and the runtime-nodes page. */
export { NodeRoster, type NodeRosterProps } from "./NodeRoster.js";
/** @public The read seam every mount supplies; declared beside the read it names. */
export { type NodeRosterReads } from "./node-roster-reads.js";
