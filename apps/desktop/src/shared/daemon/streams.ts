// The daemon subscriptions the app opens, closed. The renderer's
// `services/daemon/session/event/streams.ts` routes each one, and the preload and main name the
// machine settings feed from here.
//
// The names are written as strings so the sandboxed preload loads none of the contract's schemas;
// the set is checked against the daemon's method map, so each must be one of its subscriptions.

import type { DaemonEvent } from "@ai-sidekicks/contracts/daemon/method-map";

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

/** The subscription name for the sessions on this machine: the list, then each change to it. */
export const SESSION_LIST_STREAM = "session.list";

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
  | typeof SESSION_LIST_STREAM
  | typeof MACHINE_SETTINGS_STREAM,
  DaemonEvent
>;
