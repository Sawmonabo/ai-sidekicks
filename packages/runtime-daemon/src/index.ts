// Public API of @ai-sidekicks/runtime-daemon: session storage, projection and spawn-cwd
// translation.

export { SessionService } from "./session/session-service.js";
export { applyMigrations, applyPragmas, openDatabase } from "./session/migration-runner.js";
export { projectEvent, replay } from "./session/session-projector.js";
export { translateSpawnCwd } from "./session/spawn-cwd-translator.js";
export type {
  DriverStrategy,
  TranslateSpawnCwdInput,
  WrappingShell,
} from "./session/spawn-cwd-translator.js";
export type { DaemonSessionRecord, StoredEvent } from "./session/types.js";
