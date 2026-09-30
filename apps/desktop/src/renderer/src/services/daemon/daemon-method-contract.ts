// The console's daemon call set: which methods the console calls, and nothing about
// their shapes.
//
// The declaration half of the reply registry beside it. Each method's request and
// reply types come from the daemon's method map in `@ai-sidekicks/contracts`
// (`DaemonParams`, `DaemonResult`), and its schemas from that method's descriptor,
// which `daemon-reply-registry.ts` looks up. This file holds only the names, so a
// method's shape is stated once, by the contract that owns it.

/**
 * Every daemon method the console calls, closed.
 *
 * Each entry must be a query or mutation the daemon's method map names: the reply
 * registry types every entry with `DaemonParams` and `DaemonResult`, which accept only
 * a `DaemonMethod`, so a misspelled method or a subscription is a compile error there.
 * Grouped by namespace: driver, timeline, session and presence.
 */
export const REGISTERED_DAEMON_METHODS = [
  "driver.interruptRun",
  "driver.compactContext",
  "driver.listProviderCommands",
  "driver.listCapabilities",
  "driver.listModels",
  "driver.respondToRequest",
  "timeline.reasoningSurfaceRead",
  "timeline.childRunExpand",
  "session.create",
  "session.read",
  "presence.read",
] as const;

/** One daemon method the console calls. */
export type RegisteredDaemonMethod = (typeof REGISTERED_DAEMON_METHODS)[number];
