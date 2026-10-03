// Public surface of the control-plane package: the schema runner and the Worker fetch handler.
// Nothing here imports `pg`; the caller holding the database connection supplies a `Querier`.

export { applyMigrations, type Querier } from "./database/migration-runner.js";

export {
  buildControlPlaneFetchHandler,
  type ControlPlaneEnv,
  type ControlPlaneHandlerOptions,
} from "./server/host.js";
