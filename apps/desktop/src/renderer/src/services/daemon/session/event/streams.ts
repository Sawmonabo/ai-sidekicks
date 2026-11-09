// The routing every `daemon.subscribe` stream goes through. The closed set of stream names the app
// opens is `#shared/daemon/streams.ts` (main admits a window's subscription by the generated
// method tables, `WINDOW_METHOD_DESCRIPTORS`); this table says what each of the renderer's streams
// carries. The app's subscribers take their stream names from that module and
// `scenario/subscriptions.fixture.ts` routes by this table, so the fixture answers as the daemon
// would; a second copy would let them drift and deliver nothing to a subscriber, indistinguishable
// from a quiet session.
//
// The kind lists for narrowed streams are composed from `stream-kinds.ts`. Rows:
// `session.event.subscribe` (the whole session log), `agent.run.subscribe` and
// `agent.queueItem.subscribe` (narrowed projections), `presence.subscribe` (the connected devices),
// and `mcp.subscribe`, `provider.account.subscribe`, `provider.subscribe`, `workflow.subscribe`,
// `session.subscribe` and `project.subscribe` (the machine's notices), `terminal.subscribe` and
// `terminal.output.subscribe` (a session's shells), `agent.subscribe` (a session's agents),
// `session.draft.subscribe` (a session's unsent draft), and `skill.subscribe` and
// `agent.command.subscribe` (the skills and a session's running commands). The last thirteen are
// not session-event streams, but still `daemon.subscribe` names. The machine settings feed has no
// row: the settings page reads it through the bridge's own `machineSettings` member. The table
// and each row are frozen because a mutation would re-route every subscription in the renderer.

import { readFrozenRecord } from "#renderer/lib/frozen-record.js";
import {
  AGENT_LIST_STREAM,
  MCP_NOTICE_STREAM,
  PRESENCE_EVENT_STREAM,
  PROJECT_LIST_STREAM,
  PROVIDER_ACCOUNT_NOTICE_STREAM,
  PROVIDER_NOTICE_STREAM,
  RUN_QUEUE_EVENT_STREAM,
  RUN_STATE_EVENT_STREAM,
  RUNNING_COMMAND_STREAM,
  SESSION_DRAFT_STREAM,
  SESSION_EVENT_STREAM,
  SESSION_LIST_STREAM,
  SKILL_LIST_STREAM,
  TERMINAL_LIST_STREAM,
  TERMINAL_OUTPUT_STREAM,
  WORKFLOW_NOTICE_STREAM,
  type DaemonStream,
  type MACHINE_SETTINGS_STREAM,
} from "#shared/daemon/streams.js";
import { RUN_QUEUE_STREAM_CARRIED_KINDS, RUN_STATE_STREAM_CARRIED_KINDS } from "./stream-kinds.js";

/**
 * A stream that carries a session's whole event log. It lists no kinds because the entire census
 * would pull the taxonomy into the bundle, and a rule that accepts every kind needs no set.
 */
export interface WholeSessionEventStream {
  readonly scope: "whole-session";
}

/** A stream that carries a named projection of the session's kinds. */
export interface NarrowedSessionEventStream {
  readonly scope: "selected-kinds";
  /**
   * This stream's kinds, frozen where they are declared in `stream-kinds.ts`. Typed
   * as strings because a subscriber's event `kind` arrives wire-verbatim.
   */
  readonly carriedKinds: readonly string[];
}

/**
 * A stream whose deliveries are the machine's device list rather than frames. It is a separate
 * scope, not a flag on the narrowed row, because `scenario/subscriptions.fixture.ts` routes on it.
 */
export interface MachinePresenceStream {
  readonly scope: "machine-presence";
}

/**
 * A stream whose deliveries are the machine's live notices: wire-only frames no session log
 * carries, each the consequence of a call such as an edit or a sign-in. The fixture delivers
 * the ones its scripted replies push.
 */
export interface MachineNoticeStream {
  readonly scope: "machine-notices";
}

/**
 * A stream of a session's shells: their list, or one shell's output. It carries no session-event
 * kind; the fixture delivers the shells a scenario scripts.
 */
export interface ShellStream {
  readonly scope: "shell";
}

/**
 * A stream of a session's agents: the list, then each agent as it changes. It carries no
 * session-event kind, and the fixture scripts no agent, so it delivers nothing there.
 */
export interface SessionAgentsStream {
  readonly scope: "session-agents";
}

/**
 * A stream of a session's unsent draft: the draft held now, then each saved change. It carries no
 * session-event kind; the fixture holds no saved draft, so it delivers the empty draft at open.
 */
export interface SessionDraftStream {
  readonly scope: "session-draft";
}

/**
 * A stream of what the composer offers and aims at: the skills, or a session's running commands.
 * It carries no session-event kind, and the fixture scripts neither, so it delivers nothing there.
 */
export interface ComposerOfferStream {
  readonly scope: "composer-offers";
}

/** One registered subscription this app opens. */
export type SessionEventStream =
  | WholeSessionEventStream
  | NarrowedSessionEventStream
  | MachinePresenceStream
  | MachineNoticeStream
  | ShellStream
  | SessionAgentsStream
  | SessionDraftStream
  | ComposerOfferStream;

/** A stream that delivers the machine's notices. */
export type MachineNoticeStreamName =
  | typeof MCP_NOTICE_STREAM
  | typeof PROVIDER_ACCOUNT_NOTICE_STREAM
  | typeof PROVIDER_NOTICE_STREAM
  | typeof WORKFLOW_NOTICE_STREAM
  | typeof SESSION_LIST_STREAM
  | typeof PROJECT_LIST_STREAM;

/** One stream this table routes: every daemon stream the app opens but the settings feed. */
export type SessionEventStreamName = Exclude<DaemonStream, typeof MACHINE_SETTINGS_STREAM>;

/**
 * Every stream the app can subscribe to; the one authority on which name routes where. Keyed
 * by name, so a stream without a row, or a row nothing registers, fails the compile.
 */
export const SESSION_EVENT_STREAMS: Readonly<Record<SessionEventStreamName, SessionEventStream>> =
  Object.freeze({
    [SESSION_EVENT_STREAM]: Object.freeze({
      scope: "whole-session",
    } satisfies SessionEventStream),
    [RUN_STATE_EVENT_STREAM]: Object.freeze({
      scope: "selected-kinds",
      carriedKinds: RUN_STATE_STREAM_CARRIED_KINDS,
    } satisfies SessionEventStream),
    [RUN_QUEUE_EVENT_STREAM]: Object.freeze({
      scope: "selected-kinds",
      carriedKinds: RUN_QUEUE_STREAM_CARRIED_KINDS,
    } satisfies SessionEventStream),
    [PRESENCE_EVENT_STREAM]: Object.freeze({
      scope: "machine-presence",
    } satisfies SessionEventStream),
    [MCP_NOTICE_STREAM]: Object.freeze({
      scope: "machine-notices",
    } satisfies SessionEventStream),
    [PROVIDER_ACCOUNT_NOTICE_STREAM]: Object.freeze({
      scope: "machine-notices",
    } satisfies SessionEventStream),
    [PROVIDER_NOTICE_STREAM]: Object.freeze({
      scope: "machine-notices",
    } satisfies SessionEventStream),
    [WORKFLOW_NOTICE_STREAM]: Object.freeze({
      scope: "machine-notices",
    } satisfies SessionEventStream),
    [SESSION_LIST_STREAM]: Object.freeze({
      scope: "machine-notices",
    } satisfies SessionEventStream),
    [PROJECT_LIST_STREAM]: Object.freeze({
      scope: "machine-notices",
    } satisfies SessionEventStream),
    [TERMINAL_LIST_STREAM]: Object.freeze({
      scope: "shell",
    } satisfies SessionEventStream),
    [TERMINAL_OUTPUT_STREAM]: Object.freeze({
      scope: "shell",
    } satisfies SessionEventStream),
    [AGENT_LIST_STREAM]: Object.freeze({
      scope: "session-agents",
    } satisfies SessionEventStream),
    [SESSION_DRAFT_STREAM]: Object.freeze({
      scope: "session-draft",
    } satisfies SessionEventStream),
    [SKILL_LIST_STREAM]: Object.freeze({
      scope: "composer-offers",
    } satisfies SessionEventStream),
    [RUNNING_COMMAND_STREAM]: Object.freeze({
      scope: "composer-offers",
    } satisfies SessionEventStream),
  });

/** The registered stream this subscription name is, or `undefined` if it is not one. */
export function sessionEventStreamFor(subscriptionName: string): SessionEventStream | undefined {
  return readFrozenRecord(SESSION_EVENT_STREAMS, subscriptionName);
}

/**
 * Whether a subscriber that named `subscriptionName` hears an event of this kind.
 *
 * A registered stream delivers what its row carries and any other name is an event type that
 * delivers only itself. A name that is neither, such as a typo, matches nothing, as with the
 * daemon. The presence, notice, shell, agent, draft and composer streams carry no session-event
 * kind.
 */
export function subscriptionDeliversEventKind(
  subscriptionName: string,
  eventKind: string,
): boolean {
  const stream = sessionEventStreamFor(subscriptionName);
  if (stream === undefined) {
    return eventKind === subscriptionName;
  }
  if (stream.scope === "whole-session") {
    return true;
  }
  return stream.scope === "selected-kinds" && stream.carriedKinds.includes(eventKind);
}
