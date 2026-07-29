// @ai-sidekicks/runtime-daemon — public API surface.
//
// Plan-001 PR #3 ships the session storage + projection slice:
//   * SessionService — append + replay over Local SQLite (append guarded
//     test-only since 2026-07-28 per the `Plan-006 §T3.1 — Append-path service writing integrity columns + Plan-022 Path 1 shred callback`
//     precondition — durable production writes belong to EventLogService)
//   * session projector — pure-functional fold from event stream to
//     `DaemonSessionSnapshot`
//   * 0001-initial migration (inlined SQL) + runner + canonical
//     `openDatabase` factory
//   * pragma application helper
//
// Plan-001 PR #5 will add a contracts-to-internal mapping layer that
// translates wire-format `SessionEvent` from `@ai-sidekicks/contracts`
// to/from the daemon's `AppendableEvent` and `DaemonSessionSnapshot`.

export * from "./session/index.js";
