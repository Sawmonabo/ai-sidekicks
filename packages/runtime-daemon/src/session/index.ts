// Public surface of the runtime-daemon `session` module.
//
// Plan-001 PR #3 ships the storage + projection slice. PR #4 (control-
// plane directory) and PR #5 (client SDK + IPC) consume these exports
// over IPC; nothing here is wire-stable until PR #5 lands the IPC
// contract translation layer.

export { SessionService } from "./session-service.js";
export { applyMigrations, applyPragmas } from "./migration-runner.js";
export { projectEvent, replay } from "./session-projector.js";
export type {
  AppendableEvent,
  ChannelProjection,
  DaemonSessionSnapshot,
  MembershipProjection,
  StoredEvent,
} from "./types.js";
