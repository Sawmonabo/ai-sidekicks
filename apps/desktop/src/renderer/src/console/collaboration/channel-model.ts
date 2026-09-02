// The channel directory: what `channel.list` served, ordered for the eye.
//
// TWO HALVES, AND THE SPLIT IS THE POINT. The pure half orders and classifies rows
// and is what the tests drive; the impure half is one factory that binds the read
// and its refresh signal. Ordering that lived inside the model would only be
// reachable through a bridge, and the ordering rules are where the mistakes are.
//
// WHAT THE WIRE ACTUALLY CARRIES, WHICH IS LESS THAN THE SURFACE WANTS.
// `ChannelListResponseChannel` (`packages/contracts/src/channels.ts`) is exactly
// `{id, name?, state, participantCount}`. There is no audience field, no kind
// discriminator, and no member pair — so this module classifies rows by the two
// things it is actually given, `state` and whether the row is the bootstrap
// channel, and renders nothing about audience or pairing. The console does not
// derive an audience from a participant count; audience is a daemon obligation and
// a renderer that guessed at one would be asserting a fact nobody sent.
//
// THE NON-DISCLOSURE FILTER IS THE DAEMON'S, AND IT IS INVISIBLE HERE ON PURPOSE.
// A channel the caller may not see is omitted from the response, not blanked, and
// this module has no concept of a hidden row and therefore no way to count one.
// That is the property, stated structurally: there is no `hiddenCount`, and adding
// one would be the leak the filter exists to prevent.

import type { ChannelListResponse, ChannelListResponseChannel } from "@ai-sidekicks/contracts";

import type { ConsoleClock } from "../core/index.js";
import type { ConsoleBridge } from "../bridge/index.js";
import type { SessionStore } from "../store/index.js";
import { MAIN_CHANNEL_NAME } from "./constants.js";
import { PushDrivenRead, callDaemonMethod } from "../seats/index.js";

/** The daemon method the directory reads. Named once; the family's only speller. */
const CHANNEL_LIST_METHOD = "channel.list";

/**
 * The four events that change this list.
 *
 * Every one is a registered `SessionEventType` under the `session_lifecycle`
 * category (`packages/contracts/src/event.ts`), so the set is the wire's and not a
 * guess. The console answers all four the same way — with a fresh list — because
 * the event is a change SIGNAL and the list is the truth.
 *
 * The signal arrives through the console's own session store rather than through a
 * second bridge subscription. The store is already the one subscriber to the event
 * stream; opening another would be a second copy of the same feed, arriving in a
 * different order, and `Spec-023 §Console Design (Meridian)` puts exactly one thing
 * on the bridge for exactly this reason.
 */
const CHANNEL_LIFECYCLE_EVENT_KINDS: ReadonlySet<string> = new Set([
  "channel.created",
  "channel.muted",
  "channel.unmuted",
  "channel.archived",
]);

/** The refusal origin every channel-directory failure carries. */
export const CHANNEL_DIRECTORY_ORIGIN = "channel-directory";

/** One row, plus the one classification the wire supports. */
export interface ChannelRow {
  readonly channel: ChannelListResponseChannel;
  /**
   * True for the session's bootstrap channel.
   *
   * Recognised by name, which is what the channel-list projection synthesizes it
   * with. It carries no configuration of its own and always sits at the top.
   */
  readonly isMain: boolean;
}

/** The list, split into the two regions the surface renders. */
export interface OrderedChannelRows {
  /** Active and muted rows, main first, otherwise in the order the daemon served. */
  readonly live: readonly ChannelRow[];
  /** Archived rows, below the live ones, in the order the daemon served. */
  readonly archived: readonly ChannelRow[];
}

/**
 * Order what the daemon served.
 *
 * TWO MOVES AND NO MORE. The bootstrap channel is hoisted to the top and archived
 * rows sink below the live ones; everything else keeps the daemon's own order. A
 * renderer that sorted by name or by activity would be imposing an order over one
 * the daemon already chose, and the two would disagree the moment either changed.
 *
 * A muted row stays among the live ones. Mute suppresses attention, not execution —
 * a muted channel still admits runs — so demoting it would misreport what it is.
 */
export function orderChannelRows(
  channels: readonly ChannelListResponseChannel[],
): OrderedChannelRows {
  const rows: ChannelRow[] = channels.map((channel) => ({
    channel,
    isMain: channel.name === MAIN_CHANNEL_NAME,
  }));
  const live = rows.filter((row) => row.channel.state !== "archived");
  const archived = rows.filter((row) => row.channel.state === "archived");
  return {
    live: [...live.filter((row) => row.isMain), ...live.filter((row) => !row.isMain)],
    archived,
  };
}

/** The read the channel list is built on, with its refresh already bound. */
export type ChannelDirectory = PushDrivenRead<readonly ChannelListResponseChannel[]>;

/**
 * Build the directory for one session.
 *
 * Constructed by whoever owns its lifetime — a sidebar section, never a render
 * body — and disposed with that owner. The refresh signal is the session event
 * stream rather than a timer: the four channel-lifecycle events are the only thing
 * that changes this list, and they are already on the wire.
 */
export function createChannelDirectory(options: {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
  readonly clock: ConsoleClock;
}): ChannelDirectory {
  const { bridge, sessionStore, clock } = options;
  return new PushDrivenRead<readonly ChannelListResponseChannel[]>({
    clock,
    origin: CHANNEL_DIRECTORY_ORIGIN,
    read: async () => {
      const response = await callDaemonMethod<{ readonly sessionId: string }, ChannelListResponse>(
        bridge,
        CHANNEL_LIST_METHOD,
        { sessionId: sessionStore.sessionId },
      );
      return response.channels;
    },
    subscribe: (onChangeSignal) => subscribeToChannelLifecycle(sessionStore, onChangeSignal),
  });
}

/**
 * Signal on every store transition that admitted a channel-lifecycle event.
 *
 * Keyed on the store's own `cursor` so the same event is never counted twice, and
 * scoped to the four kinds so a busy run does not re-read the channel list on every
 * token. A transition that admitted nothing this list cares about produces no
 * signal at all — which is what keeps the coalescing window honest rather than
 * permanently full.
 */
function subscribeToChannelLifecycle(
  sessionStore: SessionStore,
  onChangeSignal: () => void,
): () => void {
  let lastSeenCursor = sessionStore.snapshot().cursor;
  return sessionStore.readable.subscribe((state) => {
    const previousCursor = lastSeenCursor;
    if (state.cursor <= previousCursor) {
      return;
    }
    lastSeenCursor = state.cursor;
    const admitted = state.timeline.filter((event) => event.sequence > previousCursor);
    if (admitted.some((event) => CHANNEL_LIFECYCLE_EVENT_KINDS.has(event.kind))) {
      onChangeSignal();
    }
  });
}
