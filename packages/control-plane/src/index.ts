// Public surface of the @ai-sidekicks/control-plane package.
//
// The schema runner and the HTTP substrate built on tRPC v11 +
// `@trpc/server/adapters/fetch` and deployable as a Cloudflare Worker. The
// `buildControlPlaneFetchHandler` factory with its option and env types is the
// boundary production wiring uses.
//
// Nothing in this package imports `pg`: the schema runner takes a `Querier`,
// which the caller holding the database connection supplies.

export { applyMigrations, type Querier } from "./sessions/migration-runner.js";

export {
  buildControlPlaneFetchHandler,
  type ControlPlaneEnv,
  type ControlPlaneHandlerOptions,
} from "./server/host.js";
