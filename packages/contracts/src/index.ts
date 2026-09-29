// @ai-sidekicks/contracts — public API surface.
//
// The session core:
//   • session.ts — branded ID schemas, shared enums + projection types,
//     SessionCreate / SessionRead / SessionSubscribe payloads
//   • event.ts   — the SessionEvent discriminated union, seeded with the
//                 session creation event; the live roster is
//                 whatever `SESSION_EVENT_TYPES` enumerates, grown additively
//                 (no count is pinned in this header)
//   • error.ts   — the error envelopes and their codes
//
// Anything re-exported here is a stable cross-package contract.
export * from "./agent-provider-binding.js";
export * from "./artifacts/index.js";
export * from "./attention.js";
export * from "./daemon-methods.js";
export * from "./driver-event.js";
export * from "./error.js";
export * from "./event-anchor.js";
export * from "./event.js";
export * from "./jsonrpc.js";
export * from "./jsonrpc-negotiation.js";
export * from "./jsonrpc-registry.js";
export * from "./jsonrpc-streaming.js";
export * from "./mcp.js";
export * from "./node-id.js";
export * from "./presence.js";
export * from "./preview.js";
export * from "./provider-account.js";
export * from "./provider-driver.js";
export * from "./pty-host-protocol.js";
export * from "./pty-host.js";
export * from "./pty.js";
export * from "./repo.js";
export * from "./run-control.js";
export * from "./session.js";
export * from "./session-cost.js";
export * from "./timeline/index.js";
export * from "./uuid-canonical.js";
export * from "./workflow-definition.js";
export * from "./workflow-run.js";
export * from "./worktree.js";
