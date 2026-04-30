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
export { applyMigrations, type Querier } from "./sessions/migration-runner.js";
export { INITIAL_MIGRATION_SQL } from "./migrations/0001-initial.js";

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
