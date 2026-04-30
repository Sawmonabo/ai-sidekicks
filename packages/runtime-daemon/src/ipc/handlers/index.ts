// Re-exports for the four `session.*` JSON-RPC handlers shipped by
// Plan-007 Phase 3 (T-007p-3-1). Plan-001 Phase 5's bootstrap
// orchestrator imports `register*` + `*Deps` from this file to wire
// the four handlers into the daemon's MethodRegistry at process start.
//
// Each handler is registered separately (no aggregated `registerAll`)
// so the bootstrap orchestrator retains explicit control over which
// methods are bound — useful for test harnesses that bind a subset.

export { registerSessionCreate, type SessionCreateDeps } from "./session-create.js";

export { registerSessionRead, type SessionReadDeps } from "./session-read.js";

export { registerSessionJoin, type SessionJoinDeps } from "./session-join.js";

export { registerSessionSubscribe, type SessionSubscribeDeps } from "./session-subscribe.js";
