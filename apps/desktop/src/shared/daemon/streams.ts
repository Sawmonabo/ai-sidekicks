// The daemon subscriptions the app opens, closed. The renderer's
// `services/daemon/session/event/streams.ts` routes each one, and the preload and main name the
// machine settings feed from here.
//
// The names are written as strings so the sandboxed preload loads none of the generated checks;
// each is checked against the generated method tables, so it must be one of their subscriptions.

import type { DaemonStreamMethod } from "./method-bindings.js";

/** `Name`, which must be a subscription of the generated tables or the declaration fails. */
type Subscription<Name extends DaemonStreamMethod> = Name;

/** The subscription name for a session's whole event stream. */
export const SESSION_EVENT_STREAM: Subscription<"session.event.subscribe"> =
  "session.event.subscribe";

/** The subscription name for a session's runs and each run's state changes. */
export const RUN_STATE_EVENT_STREAM: Subscription<"agent.run.subscribe"> = "agent.run.subscribe";

/** The subscription name for a session's queued items. */
export const RUN_QUEUE_EVENT_STREAM: Subscription<"agent.queueItem.subscribe"> =
  "agent.queueItem.subscribe";

/** The subscription name for the devices connected to this machine; it belongs to the machine. */
export const PRESENCE_EVENT_STREAM: Subscription<"presence.subscribe"> = "presence.subscribe";

/** The subscription name for the machine's MCP binding edits and governance events. */
export const MCP_NOTICE_STREAM: Subscription<"mcp.subscribe"> = "mcp.subscribe";

/** The subscription name for the machine's provider-account registry changes. */
export const PROVIDER_ACCOUNT_NOTICE_STREAM: Subscription<"provider.account.subscribe"> =
  "provider.account.subscribe";

/** The subscription name for the machine's providers: each one's whole section as it changes. */
export const PROVIDER_NOTICE_STREAM: Subscription<"provider.subscribe"> = "provider.subscribe";

/** The subscription name for the machine's workflow runs, steps, schedules and start hold. */
export const WORKFLOW_NOTICE_STREAM: Subscription<"workflow.subscribe"> = "workflow.subscribe";

/** The subscription name for the sessions on this machine: the list, then each change to it. */
export const SESSION_LIST_STREAM: Subscription<"session.subscribe"> = "session.subscribe";

/** The subscription name for the machine's projects: the whole list, then again on each change. */
export const PROJECT_LIST_STREAM: Subscription<"project.subscribe"> = "project.subscribe";

/** The subscription name for a session's shells: the whole list, then again on each change. */
export const TERMINAL_LIST_STREAM: Subscription<"terminal.subscribe"> = "terminal.subscribe";

/** The subscription name for a session's agents: the list, then each agent as it changes. */
export const AGENT_LIST_STREAM: Subscription<"agent.subscribe"> = "agent.subscribe";

/** The subscription name for one shell's output: its scrollback window, then what it writes. */
export const TERMINAL_OUTPUT_STREAM: Subscription<"terminal.output.subscribe"> =
  "terminal.output.subscribe";

/** The subscription name for a session's unsent draft: the draft held now, then each change. */
export const SESSION_DRAFT_STREAM: Subscription<"session.draft.subscribe"> =
  "session.draft.subscribe";

/** The subscription name for the machine's skills: the whole list again on each change. */
export const SKILL_LIST_STREAM: Subscription<"skill.subscribe"> = "skill.subscribe";

/** The subscription name for a session's running commands: the whole set, then its output. */
export const RUNNING_COMMAND_STREAM: Subscription<"agent.command.subscribe"> =
  "agent.command.subscribe";

/** The subscription name for the machine's settings file: the file, then each written change. */
export const MACHINE_SETTINGS_STREAM: Subscription<"machine.settings.subscribe"> =
  "machine.settings.subscribe";

/** One daemon subscription the app opens, each a subscription of the generated method tables. */
export type DaemonStream =
  | typeof SESSION_EVENT_STREAM
  | typeof RUN_STATE_EVENT_STREAM
  | typeof RUN_QUEUE_EVENT_STREAM
  | typeof PRESENCE_EVENT_STREAM
  | typeof MCP_NOTICE_STREAM
  | typeof PROVIDER_ACCOUNT_NOTICE_STREAM
  | typeof PROVIDER_NOTICE_STREAM
  | typeof WORKFLOW_NOTICE_STREAM
  | typeof SESSION_LIST_STREAM
  | typeof PROJECT_LIST_STREAM
  | typeof TERMINAL_LIST_STREAM
  | typeof TERMINAL_OUTPUT_STREAM
  | typeof AGENT_LIST_STREAM
  | typeof SESSION_DRAFT_STREAM
  | typeof SKILL_LIST_STREAM
  | typeof RUNNING_COMMAND_STREAM
  | typeof MACHINE_SETTINGS_STREAM;
