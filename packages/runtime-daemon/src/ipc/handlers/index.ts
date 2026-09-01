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
//   * `driver.*` (nine client-facing verbs) — Plan-005 Phase 4. The eight
//     request/response verbs bind from `driver-handlers.ts` (T4.1's six plus
//     T4.9's two console-parity verbs); the ninth,
//     `driver.subscribeEvents`, binds from `driver-subscribe.ts` (T4.4), which
//     is its only registration. The four session/run LIFECYCLE driver
//     operations are deliberately absent from both: they are
//     orchestration-owned and registered nowhere, so a client cannot reach them
//     (Plan-005 §Phase 4 decision #2).
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

export {
  registerDriverApplyIntervention,
  registerDriverCompactContext,
  registerDriverInterruptRun,
  registerDriverListCapabilities,
  registerDriverListModels,
  registerDriverListModes,
  registerDriverListProviderCommands,
  registerDriverRespondToRequest,
  type AgentBindingsResolution,
  type DriverCatalogDeps,
  type DriverCompactContextDeps,
  type DriverDispatchDeps,
  type DriverListCapabilitiesDeps,
  type DriverListProviderCommandsDeps,
  type RunBindingResolution,
} from "./driver-handlers.js";

export {
  registerDriverSubscribeEvents,
  type DriverSubscribeEventsDeps,
} from "./driver-subscribe.js";
