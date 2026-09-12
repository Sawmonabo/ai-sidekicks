// Public surface of the runtime-daemon `session` module.
//
// The storage + projection slice. The control-plane directory and the
// client SDK consume these exports over IPC; nothing here is wire-stable
// until the IPC contract translation layer says so.

export { SessionService } from "./session-service.js";
export type { SessionServiceOptions } from "./session-service.js";
// `UnsignedPlaceholderAppendToken` is deliberately NOT re-exported: the
// test-only append opt-in must stay unreachable from the package root, so
// out-of-package composition roots cannot enable placeholder-signed writes.
// In-package tests import it relatively from `session-service.js`.
export { applyMigrations, applyPragmas, openDatabase } from "./migration-runner.js";
export { projectEvent, replay } from "./session-projector.js";
export { translateSpawnCwd } from "./spawn-cwd-translator.js";
export type {
  DriverStrategy,
  TranslateSpawnCwdInput,
  WrappingShell,
} from "./spawn-cwd-translator.js";
export type {
  AppendableEvent,
  ChannelProjection,
  DaemonSessionSnapshot,
  StoredEvent,
} from "./types.js";
