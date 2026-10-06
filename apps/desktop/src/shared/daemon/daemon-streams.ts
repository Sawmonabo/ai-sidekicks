// The daemon subscriptions the app opens, closed. The daemon runs whatever method a subscription
// names, so main opens a subscription for a page only under one of these names and refuses every
// other before anything is sent. The renderer's `session-event-streams.ts` routes each one, and the
// preload names the machine settings feed from here.
//
// The names are written as strings so the sandboxed preload loads none of the contract's schemas;
// the set is checked against the daemon's method map, so each must be one of its subscriptions.

import type { DaemonEvent } from "@ai-sidekicks/contracts/daemon/methods";

/** The subscription name for a session's whole event stream. */
export const SESSION_EVENT_STREAM = "session.subscribe";

/** The registered subscription name for a run's state-transition stream. */
export const RUN_STATE_EVENT_STREAM = "run.subscribeState";

/** The registered subscription name for a session's queue-projection stream. */
export const RUN_QUEUE_EVENT_STREAM = "run.subscribeQueue";

/** The subscription name for the devices connected to this machine; it belongs to the machine. */
export const PRESENCE_EVENT_STREAM = "presence.subscribe";

/** The subscription name for the machine's MCP binding edits and governance events. */
export const MCP_NOTICE_STREAM = "mcp.subscribe";

/** The subscription name for the machine's provider-account registry changes. */
export const PROVIDER_ACCOUNT_NOTICE_STREAM = "providerAccount.subscribe";

/** The subscription name for the machine's workflow runs, steps, schedules and start hold. */
export const WORKFLOW_NOTICE_STREAM = "workflow.subscribe";

/** The subscription name for the machine's settings file: the file, then each written change. */
export const MACHINE_SETTINGS_STREAM = "daemon.machineSettingsSubscribe";

/** One daemon subscription the app opens, each a subscription of the daemon's method map. */
export type DaemonStream = Extract<
  | typeof SESSION_EVENT_STREAM
  | typeof RUN_STATE_EVENT_STREAM
  | typeof RUN_QUEUE_EVENT_STREAM
  | typeof PRESENCE_EVENT_STREAM
  | typeof MCP_NOTICE_STREAM
  | typeof PROVIDER_ACCOUNT_NOTICE_STREAM
  | typeof WORKFLOW_NOTICE_STREAM
  | typeof MACHINE_SETTINGS_STREAM,
  DaemonEvent
>;

/** Whether `name` is one of the daemon subscriptions the app opens. */
export function isDaemonStream(name: string): name is DaemonStream {
  return Object.hasOwn(OPENED_STREAMS, name);
}

/** Keyed by every stream, so a name missing here, or one the method map lacks, fails the build. */
const OPENED_STREAMS: Readonly<Record<DaemonStream, true>> = {
  [SESSION_EVENT_STREAM]: true,
  [RUN_STATE_EVENT_STREAM]: true,
  [RUN_QUEUE_EVENT_STREAM]: true,
  [PRESENCE_EVENT_STREAM]: true,
  [MCP_NOTICE_STREAM]: true,
  [PROVIDER_ACCOUNT_NOTICE_STREAM]: true,
  [WORKFLOW_NOTICE_STREAM]: true,
  [MACHINE_SETTINGS_STREAM]: true,
};
