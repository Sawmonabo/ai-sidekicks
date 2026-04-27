// Public surface of the @ai-sidekicks/control-plane package.
//
// Plan-001 PR #4 ships the SessionDirectoryService + the migration runner.
// PR #5 (client SDK + integration) will compose a `Querier` from `pg.Pool`
// and wire this service through the SDK; nothing here is wire-stable until
// PR #5 lands the IPC binding.
//
// pg 8.20+ remains a workspace dep (per ADR-022 upper-tier Node 24 target)
// and is consumed at the production wiring boundary in PR #5.

export {
  SessionDirectoryService,
  type CreateSessionInput,
  type JoinSessionInput,
} from "./sessions/session-directory-service.js";
export { applyMigrations, type Querier } from "./sessions/migration-runner.js";
export { INITIAL_MIGRATION_SQL } from "./migrations/0001-initial.js";
