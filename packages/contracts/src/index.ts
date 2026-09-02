// @ai-sidekicks/contracts — public API surface.
//
// Plan-001 PR #2 ships the V1 vertical slice for the shared session core:
//   • session.ts — branded ID schemas, shared enums + projection types,
//     SessionCreate / SessionRead / SessionJoin / SessionSubscribe payloads
//   • event.ts   — V1 SessionEvent discriminated union, seeded here with the
//                 session / membership / channel creation events; the live
//                 roster is whatever `SESSION_EVENT_TYPES` enumerates, grown
//                 additively by later plans (no count is pinned in this header)
//   • error.ts   — resource.limit_exceeded error envelope
//
// Subsequent PRs (Plan-002+) will extend each module additively. Anything
// re-exported here is a stable cross-package contract — removing or
// renaming requires the spec edit (api-payload-contracts.md / Spec-001 /
// Spec-006 / error-contracts.md) FIRST per AGENTS.md "doc-first ordering".
export { deriveMainChannelId, MAIN_CHANNEL_NAME } from "./channel-id.js";
export * from "./channels.js";
export * from "./desktop-bridge.js";
export * from "./driver-event.js";
export * from "./error.js";
export * from "./event-anchor.js";
export * from "./event.js";
export * from "./invites.js";
export * from "./jsonrpc.js";
export * from "./jsonrpc-negotiation.js";
export * from "./jsonrpc-registry.js";
export * from "./jsonrpc-streaming.js";
export * from "./memberships.js";
export * from "./presence.js";
export * from "./provider-account.js";
export * from "./provider-driver.js";
export * from "./pty-host-protocol.js";
export * from "./pty-host.js";
export * from "./repo.js";
export * from "./runControl.js";
export * from "./runtime-node.js";
export * from "./session.js";
export * from "./timeline/index.js";
export * from "./uuid-canonical.js";
export * from "./worktree.js";
