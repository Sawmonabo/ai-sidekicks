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
//   * `timeline.*` (four read verbs) — Plan-013. Phase 1 (T1.4) ships the
//     `registerTimelineMethod` BINDER only: it carries the canonical
//     method-to-schema descriptor so a later phase cannot bind a name to the
//     wrong shapes. The handlers themselves arrive with the daemon services
//     they dispatch to, in Plan-013 Phases 2 and 3, so nothing calls the binder
//     at bootstrap yet and no `timeline.*` method is on the wire.
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
  type ResolvedAgentBinding,
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

export { registerTimelineMethod } from "./timeline-methods.js";
