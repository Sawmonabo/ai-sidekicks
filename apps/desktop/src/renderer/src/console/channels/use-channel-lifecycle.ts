// Everything the channel list HOLDS in order to offer three acts on a row.
//
// A HOOK RATHER THAN A RENDER BODY, which is this package's standing rule and here is
// also its file-size one: the coordinator, the pending action, the two subject-scoped
// maps and the derivations they feed are one job — what a lifecycle move does to the
// directory on screen — and `ChannelList.tsx` does the other, which is drawing it.
//
// EVERY PIECE OF STATE HERE IS SUBJECT-SCOPED, and that is the property the module
// turns on: a settlement arriving after the list has re-addressed names a row of a
// session that is no longer on screen, so it publishes nowhere rather than moving a
// stranger's row. The coordinator is keyed the same way and superseded on teardown,
// because a dropped reference is still able to settle into the list that replaced it.
//
// A SERVED RECEIPT MOVES THE ROW IT NAMES, AND ONLY UNTIL A LATER READ IS ISSUED. The
// rules that keep that from becoming a second source of truth live in `channel-model.ts`
// beside the overlay itself; what lives here is the one write — applied to the channel
// the receipt names, recorded in that directory's settlement order so every read already
// on the wire is behind it, and never on the refused or superseded arm.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ConsoleBridge } from "../bridge/index.js";
import type { ConsoleRefusal } from "../core/index.js";
import { useSubjectScopedState } from "../store/index.js";
import { WireMutationCoordinator, useWireMutation } from "./mutation-coordinator.js";
import {
  applyAppliedStates,
  channelStateFromReceipt,
  orderChannelRows,
  retainUncaughtUpStates,
  type AppliedChannelStates,
  type ChannelDirectoryReading,
  type ChannelRow,
} from "./channel-model.js";
import {
  CHANNEL_NOT_FOUND_CODE,
  channelLifecycleMutation,
  type ChannelLifecycleAction,
  type ChannelLifecycleRequest,
} from "./channel-writes.js";
import { type ChannelRowLifecycle } from "./ChannelRowControls.js";

/**
 * Hold one session's lifecycle state and hand back the directory to draw.
 *
 * `reading` is what the read served — its rows and the position it was issued at — and
 * `undefined` before it has served anything, which is why the regions come back empty
 * rather than absent: the caller draws a skeleton or a refusal on those arms and calls
 * this unconditionally, so no arm of that branch changes which hooks run.
 */
export function useChannelLifecycle(
  bridge: ConsoleBridge,
  sessionId: string | undefined,
  reading: ChannelDirectoryReading | undefined,
): ChannelDirectoryView {
  // The states a served lifecycle move has reported and this list's read predates.
  const { value: appliedStates, publish: publishApplied } =
    useSubjectScopedState<AppliedChannelStates>(bridge, sessionId, () => new Map());
  // The channels a lifecycle move found gone, holding the refusal rather than a bare
  // flag so the notice standing in the row's place says what the daemon said rather
  // than a sentence this file wrote.
  const { value: goneChannels, publish: publishGone } = useSubjectScopedState<
    ReadonlyMap<string, ConsoleRefusal>
  >(bridge, sessionId, () => new Map());

  const ordered = useMemo(
    () =>
      reading === undefined
        ? undefined
        : orderChannelRows(applyAppliedStates(reading, appliedStates)),
    [reading, appliedStates],
  );

  // Which of the three the row in flight is performing, and which row that is. Read
  // only while that row is the pending one, so it is never stale: the coordinator is
  // rebuilt when the subject moves, and its fresh snapshot names no pending row.
  const [pendingAct, setPendingAct] = useState<PendingChannelAct | undefined>(undefined);

  const lifecycleCoordinator = useMemo(() => {
    const performLifecycle = channelLifecycleMutation(bridge);
    return new WireMutationCoordinator({
      // The move is recorded HERE and nowhere else, because this is the one place the
      // coordinator reaches only once its single-flight latch is held: a press it
      // answers under that rule never runs this, so it cannot name the row that does
      // hold the latch. Recording it at the press instead put the console's own
      // reading of that rule in a second place, and the two disagreed on exactly the
      // frame the rule is for.
      perform: async (request: ChannelLifecycleRequest) => {
        setPendingAct({ channelId: request.channelId, action: request.action });
        return await performLifecycle(request);
      },
      describeWhat: "The channel",
    });
    // Keyed on the SUBJECT and not only on the transport: what is in flight and whose
    // refusal stands is about ONE session's rows, and a session's list inheriting
    // another's is what closes every control on the frame after a move.
  }, [bridge, sessionId]);
  const lifecycle = useWireMutation(lifecycleCoordinator);

  useEffect(() => {
    // The coordinator being retired is superseded rather than dropped: dropping the
    // reference leaves its unsettled call able to publish into a list now on screen.
    return () => {
      lifecycleCoordinator.supersede();
    };
  }, [lifecycleCoordinator]);

  useEffect(() => {
    // The overlay's whole lifetime, in one place, and keyed on the READ rather than on
    // the event that provoked it: the event is only a signal, and the read is what says
    // whether the daemon's answer has arrived here yet. Every one of the four channel
    // events produces one.
    //
    // Keyed on the reading and not on the applied map, which is why a receipt landing
    // under a reading already on screen never retires itself: this runs when the
    // directory answers, and the retirement it performs is that answer's to make.
    if (reading === undefined) {
      return;
    }
    publishApplied((held) => retainUncaughtUpStates(reading, held));
  }, [reading, publishApplied]);

  const actOnChannel = useCallback(
    (channelId: string, action: ChannelLifecycleAction) => {
      // The order this act's answer will be recorded in, taken at the press. It is the
      // directory's own — one register per read line — so a reply already on the wire is
      // measured against the same serial the receipt below advances.
      const settlements = reading?.settlements;
      void lifecycleCoordinator.run(channelId, { channelId, action }).then((settlement) => {
        // `undefined` is the refused arm — and the superseded one, where the subject
        // moved while the call was unsettled. The daemon's answer is on the
        // coordinator's snapshot in the first case and gone in the second, which is
        // why the code is read from there rather than carried out of this closure.
        if (settlement !== undefined) {
          // The receipt names its own channel, and one naming ANOTHER is dropped rather
          // than applied: a lifecycle move is about one row, and a console that wrote a
          // stranger's id here would be learning from the wire that a mute is
          // session-wide. The state is read through the contract's own schema, so an
          // unregistered one leaves the row exactly as the read has it.
          const appliedState =
            settlement.channelId === channelId
              ? channelStateFromReceipt(settlement.state)
              : undefined;
          if (appliedState !== undefined && settlements !== undefined) {
            // RECORDED IN THE ORDER FIRST, then published. The order is what makes a
            // directory read already on the wire older than this receipt, and a publish
            // that ran ahead of it would leave that read able to retire an overlay it
            // was issued before.
            settlements.noteSettled(channelId);
            publishApplied((held) => new Map([...held, [channelId, appliedState]]));
          }
          return;
        }
        const refusal = lifecycleCoordinator.snapshot().refusalByKey[channelId];
        if (refusal?.code !== CHANNEL_NOT_FOUND_CODE) {
          return;
        }
        publishGone((held) => new Map([...held, [channelId, refusal]]));
      });
    },
    [reading, lifecycleCoordinator, publishApplied, publishGone],
  );

  const lifecycleFor = useCallback(
    (row: ChannelRow): ChannelRowLifecycle | undefined => {
      if (row.channel.state === "archived") {
        return undefined;
      }
      const channelId = row.channel.id;
      return {
        // The latch's own row AND the move recorded when it was taken. The two are
        // written in one act, so the second read is a check on the first rather than
        // a second opinion about which row is in flight.
        pendingAction:
          lifecycle.pendingKey === channelId && pendingAct?.channelId === channelId
            ? pendingAct.action
            : undefined,
        // Every row's controls close while ANY move is unsettled, not only the one
        // being moved: the coordinator behind them applies one at a time.
        isAnyPending: lifecycle.pendingKey !== undefined,
        refusal: lifecycle.refusalByKey[channelId],
        onAct: (action) => {
          actOnChannel(channelId, action);
        },
        onDismissRefusal: () => {
          lifecycleCoordinator.dismiss(channelId);
        },
      };
    },
    [actOnChannel, lifecycle, lifecycleCoordinator, pendingAct],
  );

  const rows = ordered ?? { live: [], archived: [] };
  return {
    live: rows.live.filter((row) => !goneChannels.has(row.channel.id)),
    archived: rows.archived.filter((row) => !goneChannels.has(row.channel.id)),
    // Only for a row the read still carries: a notice about a channel this directory
    // never mentioned is a sentence with nothing to stand in the place of.
    goneNotices: [...goneChannels.entries()]
      .filter(([channelId]) =>
        [...rows.live, ...rows.archived].some((row) => row.channel.id === channelId),
      )
      .map(([channelId, refusal]) => ({ channelId, refusal })),
    lifecycleFor,
  };
}

/** One row a lifecycle move found GONE, with the daemon's own words for it. */
interface GoneChannelNotice {
  readonly channelId: string;
  readonly refusal: ConsoleRefusal;
}

/**
 * The move the coordinator's latch is actually held for, and the row it names.
 *
 * ONE VALUE RATHER THAN TWO REGISTERS. The action used to be held on its own beside
 * the coordinator's pending key, written at the press: a second press arriving before
 * the first render had shut the controls replaced it, the coordinator then answered
 * that press under its single-flight rule, and the row still holding the latch
 * rendered the neighbour's verb — a mute in flight reading “Archiving…”. Which row a
 * move belongs to is a fact about the move, so it travels with it.
 */
interface PendingChannelAct {
  readonly channelId: string;
  readonly action: ChannelLifecycleAction;
}

/** The directory as the list draws it: two regions, the notices, and the acts. */
interface ChannelDirectoryView {
  /** Active and muted rows, main first, minus any the daemon says is gone. */
  readonly live: readonly ChannelRow[];
  /** Archived rows, same subtraction. */
  readonly archived: readonly ChannelRow[];
  /** The rows that went, each with the sentence that took it away. */
  readonly goneNotices: readonly GoneChannelNotice[];
  /** What one row's controls are wired to, or `undefined` on a terminal row. */
  readonly lifecycleFor: (row: ChannelRow) => ChannelRowLifecycle | undefined;
}
