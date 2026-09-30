// The daemon methods the console calls, by name only. Request and reply types come from the
// daemon's method map in `@ai-sidekicks/contracts` and the schemas from each method's descriptor
// (see `daemon-reply-registry.ts`), so a method's shape is stated once, by the contract.

/**
 * Every daemon method the console calls, closed.
 *
 * Each entry must be a query or mutation the daemon's method map names: the reply registry types
 * entries with `DaemonParams` and `DaemonResult`, so a misspelled method or a subscription is a
 * compile error there.
 */
export const REGISTERED_DAEMON_METHODS = [
  "driver.interruptRun",
  "driver.compactContext",
  "driver.listProviderCommands",
  "driver.listCapabilities",
  "driver.listModels",
  "timeline.reasoningSurfaceRead",
  "timeline.childRunExpand",
  "session.create",
  "session.read",
  "presence.read",
  "highlight.read",
] as const;

/** One daemon method the console calls. */
export type RegisteredDaemonMethod = (typeof REGISTERED_DAEMON_METHODS)[number];
