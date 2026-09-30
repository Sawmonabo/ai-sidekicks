// Public surface of the `session` module: storage, projection and spawn-cwd translation.

export { SessionService } from "./session-service.js";
export type { SessionServiceOptions } from "./session-service.js";
// `TestSeedingAppendToken` is deliberately not re-exported: the test-only append opt-in must
// stay unreachable from the package root, so no outside composition root can enable test writes.
export { applyMigrations, applyPragmas, openDatabase } from "./migration-runner.js";
export { projectEvent, replay } from "./session-projector.js";
export { translateSpawnCwd } from "./spawn-cwd-translator.js";
export type {
  DriverStrategy,
  TranslateSpawnCwdInput,
  WrappingShell,
} from "./spawn-cwd-translator.js";
export type { AppendableEvent, DaemonSessionSnapshot, StoredEvent } from "./types.js";
