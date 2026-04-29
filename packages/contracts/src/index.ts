// @ai-sidekicks/contracts — public API surface.
//
// Plan-001 PR #2 ships the V1 vertical slice for the shared session core:
//   • session.ts — branded ID schemas, shared enums + projection types,
//     SessionCreate / SessionRead / SessionJoin / SessionSubscribe payloads
//   • event.ts   — V1 SessionEvent discriminated union
//                 (session.created, membership.joined, channel.created)
//   • error.ts   — resource.limit_exceeded error envelope
//
// Subsequent PRs (Plan-002+) will extend each module additively. Anything
// re-exported here is a stable cross-package contract — removing or
// renaming requires the spec edit (api-payload-contracts.md / Spec-001 /
// Spec-006 / error-contracts.md) FIRST per AGENTS.md "doc-first ordering".
export * from "./error.js";
export * from "./event.js";
export * from "./jsonrpc.js";
export * from "./jsonrpc-negotiation.js";
export * from "./jsonrpc-registry.js";
export * from "./jsonrpc-streaming.js";
export * from "./session.js";
