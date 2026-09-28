// Public surface of the @ai-sidekicks/control-plane package.
//
// The schema runner, the event-log anchor store, and the HTTP substrate built on
// tRPC v11 + `@trpc/server/adapters/fetch` and deployable as a Cloudflare Worker.
// The `buildControlPlaneFetchHandler` factory with its dependency and env types
// is the boundary production wiring uses.
//
// Nothing in this package imports `pg`: the anchor store and the schema runner
// take a `Querier`, which the caller holding the database connection supplies.

// `ControlPlaneDeps` requires the anchor store, and the class is nominal, so
// every constructor of `buildControlPlaneFetchHandler` outside this package must
// be able to build one.
export { EventLogAnchorStore } from "./event-anchors/anchor-store.js";
export { applyMigrations, type Querier } from "./sessions/migration-runner.js";

export {
  buildControlPlaneFetchHandler,
  type ControlPlaneDeps,
  type ControlPlaneEnv,
  type ControlPlaneHandlerOptions,
} from "./server/host.js";
