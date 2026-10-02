// Public API of @ai-sidekicks/runtime-daemon: session storage, projection and spawn-cwd
// translation.

export { SessionService } from "./session/session-service.js";
export type { SessionServiceOptions } from "./session/session-service.js";
// `TestSeedingAppendToken` is deliberately not exported: the test-only append opt-in must stay
// unreachable from the package root, so no outside composition root can enable test writes.
export { applyMigrations, applyPragmas, openDatabase } from "./session/migration-runner.js";
export { projectEvent, replay } from "./session/session-projector.js";
export { translateSpawnCwd } from "./session/spawn-cwd-translator.js";
export type {
  DriverStrategy,
  TranslateSpawnCwdInput,
  WrappingShell,
} from "./session/spawn-cwd-translator.js";
export type { DaemonSessionSnapshot, StoredEvent } from "./session/types.js";
