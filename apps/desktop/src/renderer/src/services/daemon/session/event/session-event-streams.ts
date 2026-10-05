// The closed set of `daemon.subscribe` stream names and the routing every subscription goes
// through. `daemon.subscribe` names either a registered stream, which delivers a projection of many
// kinds, or a single event type, which delivers only itself. The app's subscribers take their
// stream names from here and `scenario/subscriptions.fixture.ts` routes by this table, so the
// fixture answers as the daemon would; a second copy would let them drift and deliver nothing to a
// subscriber, indistinguishable from a quiet session.
//
// The kind lists for narrowed streams are composed from `stream-kinds.ts`. Rows:
// `session.subscribe` (the whole session log), `run.subscribeState` and `run.subscribeQueue`
// (narrowed projections), `presence.subscribe` (the connected devices), and `mcp.subscribe`,
// `providerAccount.subscribe` and `workflow.subscribe` (the machine's notices). The last four are
// not session-event streams, but still `daemon.subscribe` names. The table and each row are frozen
// because a mutation would re-route every subscription in the renderer.

import { readFrozenRecord } from "#renderer/lib/frozen-record.js";
import { RUN_QUEUE_STREAM_CARRIED_KINDS, RUN_STATE_STREAM_CARRIED_KINDS } from "./stream-kinds.js";

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

/** One registered subscription this app opens. */
export type SessionEventStream =
  | WholeSessionEventStream
  | NarrowedSessionEventStream
  | MachinePresenceStream
  | MachineNoticeStream;

/** A stream that delivers the machine's notices, named from the constants below. */
export type MachineNoticeStreamName =
  | typeof MCP_NOTICE_STREAM
  | typeof PROVIDER_ACCOUNT_NOTICE_STREAM
  | typeof WORKFLOW_NOTICE_STREAM;

/** One registered stream name, taken from the constants above so the strings are not repeated. */
export type SessionEventStreamName =
  | typeof SESSION_EVENT_STREAM
  | typeof RUN_STATE_EVENT_STREAM
  | typeof RUN_QUEUE_EVENT_STREAM
  | typeof PRESENCE_EVENT_STREAM
  | MachineNoticeStreamName;

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
    [WORKFLOW_NOTICE_STREAM]: Object.freeze({
      scope: "machine-notices",
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
 * daemon. The presence and notice streams carry no session-event kind.
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
  if (stream.scope === "machine-presence" || stream.scope === "machine-notices") {
    return false;
  }
  return stream.carriedKinds.includes(eventKind);
}
