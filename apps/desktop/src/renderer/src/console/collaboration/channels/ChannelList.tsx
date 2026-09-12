// Every channel in this session, main first, state legible without opening it — and
// the four acts the console can perform on one.
//
// ONE READ, AND IT IS THE LIST. `channel.list` IS the directory: its rows are the
// channels, and its refusal is the whole surface failing.
//
// ELIGIBILITY IS THE DAEMON'S. Mute, unmute and archive are offered on every live row
// and the daemon's refusal renders beside the row it names. Nothing here computes a
// permission, reads a role, or hides a control to avoid provoking an answer. The one
// thing a row gates on is its own wire STATE — a muted row offers Unmute, an active
// one offers Mute, an archived one offers nothing, because archival is terminal and an
// unmute affordance there would suggest the channel could come back.
//
// A SERVED RECEIPT MOVES THE ROW IT NAMES, AND ONLY UNTIL THE READ MOVES. A mute, an
// unmute and an archive each answer with the state the daemon put the channel in, and
// the directory only catches up when the matching `channel.*` event drives a fresh
// read — so the row rendered its prior state in between and offered the same control
// again, inviting a second press the daemon would answer with nothing. The overlay
// that closes that window, and every other thing this list holds in order to offer an
// act at all, is `use-channel-lifecycle.ts`; what is left here is the drawing.
//
// TWO REFUSALS MOVE A ROW AND THE REST DO NOT. `channel.not_found` says the channel is
// gone, so its row goes and the daemon's own sentence stands in its place — leaving a
// row with controls on a channel that no longer exists would offer acts that can only
// fail. `channel.inactive` says the channel is archived, which is a fact about a row
// that is still there, so the row stays and the refusal renders against it.
//
// NO PAUSE-CHANNEL CONTROL IS OFFERED, because that verb exists nowhere in the corpus,
// and no configuration-update control is offered either — every `ChannelConfig` member
// is create-time-immutable, which is what the create panel below says out loud.
//
// ARCHIVED ROWS SINK AND COLLAPSE. Archival is terminal, so that region only grows; it
// lives behind one disclosure, closed by default. The disclosure renders EVERY
// archived row: its height is bounded by the region's own scroll box, never by a
// slice, because the summary above it counts what the read carried and a count the
// list will not show is a lie the person cannot even page past — no channel read
// carries a cursor.

import { useCallback } from "react";

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../../bridge/index.js";
import {
  DerivedFigure,
  InlineRefusal,
  Nothing,
  RefusalCard,
  WireFigure,
  formatCount,
} from "../../primitives/index.js";
import type { PushDrivenReadState, SidebarSectionContext } from "../../seats/index.js";
import { type ActivityIndicatorRegistry, type ChannelActivityLabels } from "../activity-model.js";
import type { ChannelDirectoryReading } from "./channel-model.js";
import { useChannelLifecycle } from "./use-channel-lifecycle.js";
import { CreateChannel } from "./CreateChannel.js";
import { ChannelListRow } from "./ChannelListRow.js";

export interface ChannelListProps {
  readonly state: PushDrivenReadState<ChannelDirectoryReading>;
  readonly bridge: ConsoleBridge;
  /** The session these channels belong to. `undefined` means nothing was asked. */
  readonly sessionId: string | undefined;
  /**
   * How a row opens its channel — the opener the sidebar section was handed.
   *
   * Typed off the seat rather than imported as its own symbol: the deck that owns
   * the opener is the one that mounted this list, and an auxiliary window's deck is
   * a different deck. Taking the type from the context is what keeps the two in
   * step without this file holding a second name for the same callback.
   */
  readonly openPane: SidebarSectionContext["openPane"];
  readonly activity: ActivityIndicatorRegistry;
  readonly labels: ChannelActivityLabels;
  /**
   * True while the session's projection is known-incomplete.
   *
   * The list still renders from the last read — a partitioned node shows what it
   * last knew rather than going blank — under one line saying channel state is
   * catching up. One line for the whole list, never a mark per row: the projection
   * is degraded as a whole, and per-row noise would suggest the console knows which
   * rows are stale.
   */
  readonly isCatchingUp: boolean;
  /**
   * Re-open the channel stream after a refusal. Rendered only on the failed arm.
   *
   * The read's own trigger rather than a rebuild of this session's models: a refusal
   * on one stream says nothing about the others, and this section is the only way back
   * into a directory that refused.
   */
  readonly onReopen: () => void;
}

export function ChannelList(props: ChannelListProps): React.JSX.Element {
  const { state, bridge, sessionId, openPane, activity, labels, isCatchingUp, onReopen } = props;

  // The directory's answer exactly as the daemon served it — its rows, and the position
  // the read that fetched them took in this session's settlement order — and `undefined`
  // until one has landed. Read apart from the state that carries it because the hook
  // below takes the answer and draws no conclusion from which arm it came off.
  const reading = state.kind === "loaded" ? state.value : undefined;
  const { live, archived, goneNotices, lifecycleFor } = useChannelLifecycle(
    bridge,
    sessionId,
    reading,
  );
  const openChannel = useCallback(
    (channelId: string) => {
      // The registered pane kind, scoped to the registered entity kind. There is no
      // `channel` pane kind in the closed eleven, and a channel's content IS its
      // slice of the log, so the timeline pane carrying the channel entity is the
      // address rather than a workaround for a missing one.
      openPane({ kind: "timeline", entity: { kind: "channel", id: channelId } });
    },
    [openPane],
  );

  if (state.kind === "not-loaded") {
    // MAIN RENDERS IMMEDIATELY AND THE REST ARE SKELETONS. That is a claim the console
    // may make about exactly one row and no other: every session has the bootstrap
    // channel, so naming it before the read lands asserts nothing the reply can
    // contradict. It carries no id, no state and no control, because those are the
    // read's to supply and a row that opened a channel whose id the console invented
    // would be a worse answer than a slower list.
    return (
      <div className="meridian-channels">
        <ul className="meridian-channels__list meridian-channels__list--loading">
          <li className="meridian-channel-row meridian-channel-row--main meridian-channel-row--loading">
            <span className="meridian-channel-row__name">
              <WireFigure value={MAIN_CHANNEL_NAME} />
            </span>
          </li>
        </ul>
        <Nothing kind="not-loaded" title="Reading this session's other channels." />
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="meridian-channels">
        <RefusalCard
          code={state.refusal.code}
          detail={state.refusal.detail}
          action={
            <button type="button" onClick={onReopen}>
              Try again
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="meridian-channels">
      {isCatchingUp ? (
        <p className="meridian-channels__degraded" role="status">
          <DerivedFigure text="Channel state is catching up. These rows are the last the console read." />
        </p>
      ) : null}

      {live.length === 0 && goneNotices.length === 0 ? (
        <Nothing
          kind="empty"
          placement="surface"
          title="This session has no channel the console can see."
          detail="A named channel gives sidekicks a room of one topic, so a side thread does not land in the middle of the main one."
        />
      ) : (
        <ul className="meridian-channels__list">
          {live.map((row) => (
            <ChannelListRow
              key={row.channel.id}
              row={row}
              activity={activity}
              labels={labels}
              onOpen={openChannel}
              lifecycle={lifecycleFor(row)}
            />
          ))}
          {goneNotices.map((notice) => (
            <li key={notice.channelId} className="meridian-channels__gone">
              <InlineRefusal code={notice.refusal.code} detail={notice.refusal.detail} />
            </li>
          ))}
        </ul>
      )}

      {archived.length === 0 ? null : (
        <details className="meridian-channels__archive">
          <summary className="meridian-channels__archive-summary">
            <DerivedFigure
              text={`${formatCount(archived.length)} archived ${archived.length === 1 ? "channel" : "channels"}`}
            />
          </summary>
          <ul className="meridian-channels__list meridian-channels__list--archived">
            {archived.map((row) => (
              <ChannelListRow
                key={row.channel.id}
                row={row}
                activity={activity}
                labels={labels}
                onOpen={openChannel}
                lifecycle={undefined}
              />
            ))}
          </ul>
        </details>
      )}

      <CreateChannel bridge={bridge} sessionId={sessionId} />
    </div>
  );
}
