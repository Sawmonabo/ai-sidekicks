// Public API of @ai-sidekicks/runtime-daemon: session storage, projection and spawn-cwd
// translation.

export { SessionService } from "./session/service.js";
export { applyMigrations, applyPragmas, openDatabase } from "./session/migration-runner.js";
export { projectEvent, rebuildSession } from "./session/projector.js";
export { translateSpawnCwd } from "./session/spawn-cwd-translator.js";
export type {
  DriverStrategy,
  TranslateSpawnCwdInput,
  WrappingShell,
} from "./session/spawn-cwd-translator.js";
export type { DaemonSessionRecord, StoredEvent } from "./session/records.js";
