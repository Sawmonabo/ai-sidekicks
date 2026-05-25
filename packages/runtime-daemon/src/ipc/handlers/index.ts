// Re-exports for the daemon's JSON-RPC handler binders. The bootstrap
// orchestrator (Plan-001 Phase 5) imports `register*` + `*Deps` from this
// file to wire each handler into the daemon's MethodRegistry at process
// start.
//
//   * `session.*` (`create` / `read` / `join` / `subscribe`) — Plan-007
//     Phase 3 (T-007p-3-1).
//   * `presence.*` (`subscribe` / `read`) — Plan-002 Phase 3 (T3.3). The
//     `presence.subscribe` binder pushes `PresenceUpdate` values over the
//     streaming primitive; see `presence-subscribe.ts` for the rationale.
//
// Each handler is registered separately (no aggregated `registerAll`)
// so the bootstrap orchestrator retains explicit control over which
// methods are bound — useful for test harnesses that bind a subset.

export { registerSessionCreate, type SessionCreateDeps } from "./session-create.js";

export { registerSessionRead, type SessionReadDeps } from "./session-read.js";

export { registerSessionJoin, type SessionJoinDeps } from "./session-join.js";

export { registerSessionSubscribe, type SessionSubscribeDeps } from "./session-subscribe.js";

export { registerPresenceSubscribe, type PresenceSubscribeDeps } from "./presence-subscribe.js";

export { registerPresenceRead, type PresenceReadDeps } from "./presence-read.js";
