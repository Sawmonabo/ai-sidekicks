// How long this shell gives the daemon to finish writing before it stops it.
//
// The quit path holds Electron's quit open while the daemon flushes, and gives up when
// this budget passes so a drain that never settles cannot keep the app from closing.
// The console's restart confirmation quotes the same figure to a person, so the
// sentence and the cap cannot disagree.
//
// It lives in `src/shared/` because main and the renderer both need it, and neither
// may import the other. The console reaches it through `console/core/index.ts`, which
// re-publishes it the way it re-publishes `lossyStringify` from `wire-errors.ts`.

/**
 * The wall-clock ceiling (milliseconds) on the graceful daemon shutdown wait.
 *
 * Read by the quit path, which races the drain against it, and quoted by the console's
 * restart confirmation, which renders it as a derived figure.
 */
export const DAEMON_SHUTDOWN_FLUSH_BUDGET_MS = 10_000;
