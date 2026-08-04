// Public surface of the @ai-sidekicks/control-plane package.
//
// Plan-001 PR #4 shipped the SessionDirectoryService + the migration runner.
// Plan-008 Phase 1 (PR #?) adds the HTTP/SSE substrate built on tRPC v11 +
// `@trpc/server/adapters/fetch` and deployable as a Cloudflare Worker — the
// `buildControlPlaneFetchHandler` factory + its dep + env types are the
// public boundary used by the integration test in client-sdk
// (per F-008b-1-09 / §T-008b-1-T12) and by future production wiring.
//
// pg 8.20+ remains a workspace dep (per ADR-022 upper-tier Node 24 target)
// and is consumed at the production wiring boundary; under I-008-3 #1 the
// router CRUD + SSE factories take their dependencies via constructor
// injection so neither the public types nor the live source touch `pg`
// directly — see eslint.config.mjs `no-restricted-imports` for the dual-layer
// enforcement of I-008-3 #2.

export {
  SessionDirectoryService,
  type CreateSessionInput,
  type JoinSessionInput,
} from "./sessions/session-directory-service.js";
// Runtime-node host-construction surface (Plan-003 Phase 3) — the two backing
// service classes the runtime-node router closes over, parallel to
// `SessionDirectoryService` above. Consumed by the client-sdk integration
// fixtures (which construct throwing-querier instances for the never-reached
// posture) and by future Tier-5 production wiring of the runtime-node host.
export { AttachService } from "./runtime-nodes/attach-service.js";
export { HeartbeatService } from "./runtime-nodes/heartbeat-service.js";
// Plan-006 T3.3 (CP-006-2) — the anchor store the `eventanchor.upload`
// procedure closes over, exported for the same reason the two runtime-node
// services above are: `ControlPlaneDeps` requires it, so every out-of-package
// constructor of `buildControlPlaneFetchHandler` (the client-sdk integration
// fixtures, future Tier-5 production wiring) must be able to construct one, and
// the class is nominal — a structural stub cannot stand in for it.
export { EventLogAnchorStore } from "./event-anchors/anchor-store.js";
export { applyMigrations, type Querier } from "./sessions/migration-runner.js";
export { INITIAL_MIGRATION_SQL } from "./migrations/0001-initial.js";
export { SESSION_INVITES_MIGRATION_SQL } from "./migrations/0002-session-invites.js";

// Plan-008 Phase 1 — HTTP/SSE substrate. The handler factory is the
// integration boundary the F-008b-1-09 unblock test (T-008b-1-T12) drives
// against, and the type slots are the deps + env shape future Tier 5 wiring
// will satisfy. `SessionEventStreamProvider` is the abstract producer
// signature used by `session.subscribe` — Tier 5 supplies a Plan-006-backed
// implementation; Phase 1 tests supply scripted in-memory providers.
//
// `ControlPlaneHandlerOptions` is exported even though no Phase 1 test or
// production caller imports it from this barrel — Tier 5 production wiring
// (Plan-008-remainder, see §I-008-2) will pass a non-default
// `requestIdGenerator` for OTel trace-context propagation and a non-default
// `refusalLogger` to route gate-refusal lines to the structured-logging
// sink. Pruning now would force re-export when Tier 5 lands; labeling here
// keeps the public surface stable across the deferral boundary.
export {
  buildControlPlaneFetchHandler,
  type ControlPlaneDeps,
  type ControlPlaneEnv,
  type ControlPlaneHandlerOptions,
} from "./server/host.js";
export type { SessionEventStreamProvider } from "./sessions/session-subscribe-sse.js";
