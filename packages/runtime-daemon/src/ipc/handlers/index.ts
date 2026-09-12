// Re-exports for the daemon's JSON-RPC handler binders. The bootstrap
// orchestrator imports `register*` + `*Deps` from this file to wire each
// handler into the daemon's MethodRegistry at process start.
//
//   * `session.*` (`create` / `read` / `subscribe`).
//   * `presence.*` (`subscribe` / `read`) — per-device liveness of the one
//     user's linked devices. The `presence.subscribe` binder pushes
//     `PresenceUpdate` values over the streaming primitive; see
//     `presence-subscribe.ts` for the rationale.
//   * `driver.*` (nine client-facing verbs). The eight request/response verbs
//     bind from `driver-handlers.ts` (the six plus the two console-parity
//     verbs); the ninth, `driver.subscribeEvents`, binds from
//     `driver-subscribe.ts`, which is its only registration. The four
//     session/run LIFECYCLE driver operations are deliberately absent from
//     both: they are orchestration-owned and registered nowhere, so a client
//     cannot reach them.
//   * `timeline.*` (four read verbs). Phase 1 ships the BINDERS only:
//     `registerTimelineMethod` for the three queries and
//     `registerTimelineSubscription` for `timeline.subscribe`. BOTH are
//     exported, because the query binder is TYPED to refuse the subscription
//     and the subscription's per-emission schema is consumed nowhere else — a
//     bootstrap that could reach only the query binder could register three of
//     the four methods and would have to bypass this barrel for the fourth,
//     which is the convention this file exists to state. Each carries the
//     canonical method-to-schema descriptor so a later phase cannot bind a name
//     to the wrong shapes. The handlers themselves arrive with the daemon
//     services they dispatch to Phases 2 and 3, so nothing calls either binder
//     at bootstrap yet and no `timeline.*` method is on the wire.
//
// Each handler is registered separately (no aggregated `registerAll`)
// so the bootstrap orchestrator retains explicit control over which
// methods are bound — useful for test harnesses that bind a subset.

export { registerSessionCreate, type SessionCreateDeps } from "./session-create.js";

export { registerSessionRead, type SessionReadDeps } from "./session-read.js";

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

export {
  registerTimelineMethod,
  registerTimelineSubscription,
  TimelineSubscriptionScopeError,
  type TimelineMethodRegistration,
  type TimelineSubscriptionFactory,
  type TimelineSubscriptionRegistration,
} from "./timeline-methods.js";
