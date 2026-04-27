// @ai-sidekicks/runtime-daemon — public API surface.
//
// Plan-001 PR #3 ships the session storage + projection slice:
//   * SessionService — append + replay over Local SQLite
//   * session projector — pure-functional fold from event stream to
//     `DaemonSessionSnapshot`
//   * 0001-initial.sql migration + runner
//   * pragma application helper
//
// Plan-001 PR #5 will add a contracts-to-internal mapping layer that
// translates wire-format `SessionEvent` from `@ai-sidekicks/contracts`
// to/from the daemon's `AppendableEvent` and `DaemonSessionSnapshot`.

export * from "./session/index.js";
