// @ai-sidekicks/contracts — public API surface.
//
// The session core:
//   • session.ts — branded ID schemas, shared enums + projection types,
//     SessionCreate / SessionRead / SessionSubscribe payloads
//   • event.ts   — the SessionEvent discriminated union, seeded with the
//                 session creation event; the live roster is
//                 whatever `SESSION_EVENT_TYPES` enumerates, grown additively
//                 (no count is pinned in this header)
//   • error.ts   — resource.limit_exceeded error envelope
//
// Anything re-exported here is a stable cross-package contract.
export * from "./desktop-bridge.js";
export * from "./driver-event.js";
export * from "./error.js";
export * from "./event-anchor.js";
export * from "./event.js";
export * from "./jsonrpc.js";
export * from "./jsonrpc-negotiation.js";
export * from "./jsonrpc-registry.js";
export * from "./jsonrpc-streaming.js";
export * from "./node-id.js";
export * from "./presence.js";
export * from "./provider-account.js";
export * from "./provider-driver.js";
export * from "./pty-host-protocol.js";
export * from "./pty-host.js";
export * from "./repo.js";
export * from "./runControl.js";
export * from "./session.js";
export * from "./timeline/index.js";
export * from "./uuid-canonical.js";
export * from "./worktree.js";
