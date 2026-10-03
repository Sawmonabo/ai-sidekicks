// How long the main process gives the daemon to finish writing before it stops it.
//
// The quit path holds Electron's quit open while the daemon flushes, and gives up when this
// budget passes so a drain that never settles cannot keep the app from closing.

/** The wall-clock ceiling, in milliseconds, on the graceful daemon shutdown wait. */
export const DAEMON_SHUTDOWN_FLUSH_BUDGET_MS = 10_000;
