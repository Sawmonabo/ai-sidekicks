// Public surface of the @ai-sidekicks/control-plane package.
//
// The SessionDirectoryService + the migration runner, plus the HTTP/SSE
// substrate built on tRPC v11 + `@trpc/server/adapters/fetch` and deployable as
// a Cloudflare Worker — the `buildControlPlaneFetchHandler` factory + its dep +
// env types are the public boundary used by the client-sdk integration test and
// by production wiring.
//
// pg 8.20+ remains a workspace dep and is consumed at the production wiring
// boundary; the router CRUD + SSE factories take their dependencies via
// constructor injection so neither the public types nor the live source touch
// `pg` directly — see eslint.config.mjs `no-restricted-imports` for the
// dual-layer enforcement.

export {
  SessionDirectoryService,
  type CreateSessionInput,
} from "./sessions/session-directory-service.js";
// Runtime-node host-construction surface — the two backing service classes
// the runtime-node router closes over, parallel to `SessionDirectoryService`
// above. Consumed by the client-sdk integration fixtures (which construct
// throwing-querier instances for the never-reached posture) and by future
// production wiring of the runtime-node host.
export { AttachService } from "./runtime-nodes/attach-service.js";
export { HeartbeatService } from "./runtime-nodes/heartbeat-service.js";
// The anchor store the `eventanchor.upload` procedure closes over, exported for
// the same reason the two runtime-node services above are: `ControlPlaneDeps`
// requires it, so every out-of-package constructor of
// `buildControlPlaneFetchHandler` (the client-sdk integration fixtures, future
// production wiring) must be able to construct one, and the class is
// nominal — a structural stub cannot stand in for it.
export { EventLogAnchorStore } from "./event-anchors/anchor-store.js";
export { applyMigrations, type Querier } from "./sessions/migration-runner.js";
export { INITIAL_MIGRATION_SQL } from "./migrations/0001-initial.js";

// The handler factory is the integration boundary unblock test drives
// against, and the type slots are the deps + env shape future production wiring
// will satisfy.
//
// `ControlPlaneHandlerOptions` is exported even though no Phase 1 test or
// production caller imports it from this barrel — production wiring
// (-remainder) will pass a non-default `requestIdGenerator` for OTel
// trace-context propagation and a non-default `refusalLogger` to route
// gate-refusal lines to the structured-logging sink. Pruning now would
// force re-export when that wiring lands; labeling here keeps the public surface
// stable across the deferral boundary.
export {
  buildControlPlaneFetchHandler,
  type ControlPlaneDeps,
  type ControlPlaneEnv,
  type ControlPlaneHandlerOptions,
} from "./server/host.js";
export type { SessionEventStreamProvider } from "./sessions/session-subscribe-sse.js";
