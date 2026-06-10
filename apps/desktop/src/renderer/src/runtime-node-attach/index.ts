// Barrel for the runtime-node-attach renderer views (Plan-003 Phase 5; T5.2 /
// T5.3 extend it with their views). Mirrors the minimal
// `session-bootstrap/index.ts` idiom (re-export via a `.js` specifier) and
// additionally re-exports the consumer-facing props type the prop-less
// `SessionBootstrap` has no need for — `NodeRosterProps` is the prop contract
// a future Plan-023 router/deep-link needs to render the roster. The `.js`
// extension matches the shipped barrel; TypeScript's extension substitution
// resolves it to `.tsx` under the renderer's `moduleResolution: "bundler"`
// graph as well.
export { NodeRoster, type NodeRosterProps } from "./NodeRoster.js";
