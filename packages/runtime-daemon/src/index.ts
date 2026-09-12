// @ai-sidekicks/runtime-daemon — public API surface.
//
// The session storage and projection slice:
//   * SessionService — append + replay over Local SQLite (append guarded
//     test-only — durable production writes belong to EventLogService)
//   * session projector — pure-functional fold from event stream to
//     `DaemonSessionSnapshot`
//   * 0001-initial migration (inlined SQL) + runner + canonical
//     `openDatabase` factory
//   * pragma application helper
//
// A later slice adds a contracts-to-internal mapping layer that translates
// wire-format `SessionEvent` from `@ai-sidekicks/contracts` to/from
// the daemon's `AppendableEvent` and `DaemonSessionSnapshot`.

export * from "./session/index.js";
