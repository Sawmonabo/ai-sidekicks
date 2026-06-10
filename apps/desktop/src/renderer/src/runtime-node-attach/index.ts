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
export { AttachFlow, type AttachFlowProps, type RuntimeNodeAttachDraft } from "./AttachFlow.js";
export { CapabilityDeclaration, type CapabilityDeclarationProps } from "./CapabilityDeclaration.js";
export { MixedVersionStatus, type MixedVersionStatusProps } from "./MixedVersionStatus.js";
export { NodeRoster, type NodeRosterProps } from "./NodeRoster.js";
