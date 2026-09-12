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
// AND A DIRECTORY ANSWER CARRIES WHEN IT WAS ASKED. A lifecycle receipt is the daemon's
// newest word about one row, and the read that catches up to it is a second call whose
// reply can arrive from a request that predates it. So the answer this module produces is
// not the row array alone: it is the rows plus the POSITION the read took in this
// session's settlement order, and the overlay below compares order rather than state.
// `channel-settlement-order.ts` beside this file owns that order and says why the state
// comparison it replaced could not tell a stale reply from a third party's move.
//
// THE NON-DISCLOSURE FILTER IS THE DAEMON'S, AND IT IS INVISIBLE HERE ON PURPOSE.
// A channel the caller may not see is omitted from the response, not blanked, and
// this module has no concept of a hidden row and therefore no way to count one.
// That is the property, stated structurally: there is no `hiddenCount`, and adding
// one would be the leak the filter exists to prevent.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";
import type {
  ChannelListResponseChannel,
  ChannelState,
  SessionEventType,
} from "@ai-sidekicks/contracts";

import type { ConsoleClock } from "../../core/index.js";
import { callDaemon, heldIdAsWireId, type ConsoleBridge } from "../../bridge/index.js";
import { subscribeToSessionEventKinds, type SessionStore } from "../../store/index.js";
import { PushDrivenRead, servedValueOrRaise } from "../../seats/index.js";
import {
  ChannelSettlementOrder,
  type ChannelSettlementPosition,
} from "./channel-settlement-order.js";

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
 * different order, and exactly one thing belongs on the bridge for exactly this
 * reason.
 */
const CHANNEL_LIFECYCLE_EVENT_KINDS: readonly SessionEventType[] = [
  "channel.created",
  "channel.muted",
  "channel.unmuted",
  "channel.archived",
];

/** The refusal origin every channel-directory failure carries. */
export const CHANNEL_DIRECTORY_ORIGIN = "channel-directory";

/** One row, plus the one classification the wire supports. */
export interface ChannelRow {
  readonly channel: ChannelListResponseChannel;
  /**
   * True for the session's bootstrap channel.
   *
   * The main channel has no row of its own — the channel-list projection composes
   * it from the session's own membership count — so the console recognises it by
   * the one thing the wire carries: `MAIN_CHANNEL_NAME`, imported from the
   * contracts package that the projection itself emits under, so both sides of the
   * seam move together. Recognising it by position would make the ordering rule
   * depend on the order it is trying to impose. It carries no configuration of its
   * own and always sits at the top.
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
 * One directory answer, and where it sits in this session's settlement order.
 *
 * THE POSITION TRAVELS WITH THE ANSWER because it is a fact about the READ and not
 * about the surface holding it: the read was issued at a moment, and which lifecycle
 * receipts it could not have seen is settled then. Recomputed at the render that
 * consumes it, the answer would be "all of them", which is precisely the mistake.
 *
 * The order itself rides along too, so the one surface that records receipts reaches
 * it through the answer it is correcting rather than through a prop chain of its own —
 * and there is exactly one order per directory, which is the property that makes a
 * receipt and a read comparable at all.
 */
export interface ChannelDirectoryReading {
  /** The rows exactly as `channel.list` served them. */
  readonly channels: readonly ChannelListResponseChannel[];
  /** The settlement order this read is measured against, for whoever records one. */
  readonly settlements: ChannelSettlementOrder;
  /** Where this read was issued in that order. */
  readonly position: ChannelSettlementPosition;
}

/**
 * The states a lifecycle receipt reported that this list's last read predates.
 *
 * Keyed by channel id, and EMPTY is the ordinary state: an entry exists only between
 * the daemon answering a move and the first directory read ISSUED after it, which is a
 * window measured in one round trip. It is not a cache and never a second source of
 * truth — {@link retainUncaughtUpStates} drops an entry the moment a read issued after
 * that receipt lands, and drops one whose channel has left the read altogether, so the
 * map is bounded by the directory it overlays.
 */
export type AppliedChannelStates = ReadonlyMap<string, ChannelState>;

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

/**
 * The three states the wire declares, enumerated where the console can read them.
 *
 * `packages/contracts` ships `ChannelState` as a TYPE and enumerates its members only
 * inside a Zod schema, and that door stays closed: a console surface never parses a
 * wire value itself, so that schema is not importable here and the daemon's own
 * replies are parsed at `callDaemon` instead. Keying a record by the contract's OWN
 * union is what keeps this from being a second declaration of the set — a member added
 * upstream stops this literal compiling rather than quietly becoming a state this file
 * drops on the floor.
 */
const CHANNEL_STATES: Readonly<Record<ChannelState, ChannelState>> = {
  active: "active",
  muted: "muted",
  archived: "archived",
};

/** The read the channel list is built on, with its refresh already bound. */
export type ChannelDirectory = PushDrivenRead<ChannelDirectoryReading>;

/**
 * Read a lifecycle receipt's state as one of the three the wire declares.
 *
 * `GrowthChannelLifecycleReceipt.state` is typed `string` — that plane is the
 * console's own stand-in for a wire the bridge does not carry yet — and this list
 * classifies rows on `ChannelState`. A receipt naming anything else answers
 * `undefined` and the row keeps what the read said, which is the fail-closed arm: a
 * state nobody registered is not a state this surface may put a person's channel into.
 */
export function channelStateFromReceipt(reported: string): ChannelState | undefined {
  return Object.values(CHANNEL_STATES).find((state) => state === reported);
}

/**
 * Overlay the states a lifecycle receipt has already reported onto the read's rows.
 *
 * WHY A RECEIPT IS APPLIED AT ALL, on a surface whose whole discipline is that the
 * READ is the truth. A lifecycle move answers with the state the daemon put the
 * channel in — that is the answer to the act, not a guess — and the directory catches
 * up only when the matching `channel.*` event drives a fresh read. Between the two the
 * row rendered its PRIOR state and offered the same control again, so a person who had
 * just muted a channel was invited to mute it a second time and the press that would
 * have done nothing was the surface's own suggestion.
 *
 * It is still not a second source of truth, and the rule that keeps it honest is here
 * rather than in the caller — ONE rule, shared with {@link retainUncaughtUpStates}: the
 * overlay carries only what the daemon said, and it applies exactly while the reading
 * on screen was ISSUED BEFORE that receipt. A reading issued after it is strictly newer
 * news — the daemon caught up, or somebody else moved the channel again — and newer
 * news wins, so this cannot leave a row wearing a state a later read has contradicted.
 *
 * The comparison is order and never state, and `channel-settlement-order.ts` says why:
 * a read that predates a receipt can report the state that receipt superseded, and read
 * as a state comparison that reply is indistinguishable from a third party having moved
 * the row back.
 *
 * Applied BEFORE ordering, because state is what decides which region a row belongs
 * to — an archived receipt that only changed a chip would leave a terminal row sitting
 * among the live ones, still wearing controls.
 */
export function applyAppliedStates(
  reading: ChannelDirectoryReading,
  appliedStateByChannelId: AppliedChannelStates,
): readonly ChannelListResponseChannel[] {
  if (appliedStateByChannelId.size === 0) {
    // The overwhelmingly common case, and it returns the read's own array rather than
    // a copy so the memo above this keeps its identity across every render that has no
    // receipt outstanding.
    return reading.channels;
  }
  return reading.channels.map((channel) => {
    const applied = appliedStateByChannelId.get(channel.id);
    if (applied === undefined || reading.position.postdatesSettlementFor(channel.id)) {
      return channel;
    }
    return applied === channel.state ? channel : { ...channel, state: applied };
  });
}

/**
 * Drop every overlay entry a read issued after it has now landed for, or has no row for.
 *
 * The clearing rule is the applying rule read the other way round, which is why the two
 * live beside each other: an entry survives exactly as long as the reading on screen
 * predates it. The first reading from a read ISSUED after the receipt has seen that
 * move — whether it agrees with it or reports something newer still — so the row goes
 * back to rendering from the directory alone. A channel the read no longer carries loses
 * its entry too: its row is gone, so an overlay for it is a state with nothing to be
 * about, and keeping one would be the unbounded half of a map that is otherwise the
 * width of one directory.
 *
 * Returns the SAME map when nothing is dropped, so a caller publishing the result
 * writes nothing: the subject-scoped holder compares by identity and a fresh map per
 * render would wake every subscriber on every read.
 */
export function retainUncaughtUpStates(
  reading: ChannelDirectoryReading,
  appliedStateByChannelId: AppliedChannelStates,
): AppliedChannelStates {
  if (appliedStateByChannelId.size === 0) {
    return appliedStateByChannelId;
  }
  const readChannelIds = new Set<string>(reading.channels.map((channel) => channel.id));
  const retained = new Map(
    [...appliedStateByChannelId].filter(
      ([channelId]) =>
        readChannelIds.has(channelId) && !reading.position.postdatesSettlementFor(channelId),
    ),
  );
  return retained.size === appliedStateByChannelId.size ? appliedStateByChannelId : retained;
}

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
  // One order per directory, minted here because this is where the read line is: the
  // receipts a list records and the reads this model performs are the two things being
  // ordered, and they are comparable only while both measure against one register.
  const settlements = new ChannelSettlementOrder();
  return new PushDrivenRead<ChannelDirectoryReading>({
    clock,
    origin: CHANNEL_DIRECTORY_ORIGIN,
    read: async (signal: AbortSignal) => {
      // Taken BEFORE the request, which is the whole of the ordering: from here on any
      // receipt that lands is newer than this read, whatever order the two answers
      // arrive in.
      const position = settlements.openRead();
      const reply = await callDaemon(
        bridge,
        CHANNEL_LIST_METHOD,
        {
          sessionId: heldIdAsWireId(sessionStore.sessionId),
        },
        { signal },
      );
      return { channels: servedValueOrRaise(reply).channels, settlements, position };
    },
    subscribe: (onChangeSignal) =>
      subscribeToSessionEventKinds(sessionStore, CHANNEL_LIFECYCLE_EVENT_KINDS, onChangeSignal),
  });
}
