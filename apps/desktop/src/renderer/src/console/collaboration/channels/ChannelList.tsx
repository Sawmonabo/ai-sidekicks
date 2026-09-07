// Every channel this participant may see, main first, state legible without opening
// it — and the four acts the console can perform on one.
//
// TWO READS, AND ONLY ONE OF THEM IS THE LIST. `channel.list` IS the directory: its
// rows are the channels, and its refusal is the whole surface failing. The roster
// beside it carries the three facts that read has never carried — what a channel is
// FOR, which kind it is, and which two humans a `direct` one is between — and it is an
// ENRICHMENT. So a roster refusal is one quiet line under the rows and never a card
// standing where they were: a missing badge is not a missing directory.
//
// ELIGIBILITY IS THE DAEMON'S. Mute, unmute and archive are offered on every live row
// and the daemon's refusal renders beside the row it names. Nothing here computes a
// permission, reads a role, or hides a control to avoid provoking an answer. The one
// thing a row gates on is its own wire STATE — a muted row offers Unmute, an active
// one offers Mute, an archived one offers nothing, because archival is terminal and an
// unmute affordance there would suggest the channel could come back.
//
// AND THE PAIR GATING IS MET BY ABSENCE RATHER THAN BY A CHECK. A `direct` channel the
// caller is outside of is omitted from both replies — omitted, not blanked — so there
// is no row here for a control to sit on, and this list has no concept of a hidden row
// and shows no count of one. A caller-side check would be the console re-deriving a
// filter the daemon already applied, over data it deliberately did not send; rendering
// "3 more you cannot see" would leak exactly what the omission protects.
//
// AUDIENCE IS NEVER DERIVED FROM MEMBERS. `participants` means this session's agents
// read the channel and `humans-only` means no agent ever does; that is a wire field
// and a daemon obligation. A row the roster did not name wears no badge at all rather
// than one the console worked out for itself.
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
// NEITHER A PAUSE-CHANNEL NOR A MUTE-PARTICIPANT CONTROL IS OFFERED, because neither
// verb exists anywhere in the corpus, and no configuration-update control is offered
// either — every `ChannelConfig` member is create-time-immutable, which is what the
// create panel below says out loud.
//
// ARCHIVED ROWS SINK AND COLLAPSE. Archival is terminal, so that region only grows; it
// lives behind one disclosure, closed by default. The disclosure renders EVERY
// archived row: its height is bounded by the region's own scroll box, never by a
// slice, because the summary above it counts what the read carried and a count the
// list will not show is a lie the person cannot even page past — no channel read
// carries a cursor.

import { useCallback, useMemo } from "react";

import { MAIN_CHANNEL_NAME, type ChannelListResponseChannel } from "@ai-sidekicks/contracts";

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
import { rosterEntriesById, rosterRefusal } from "./channel-roster.js";
import { useChannelRoster } from "./channel-roster-read.js";
import { useChannelLifecycle } from "./use-channel-lifecycle.js";
import { CreateChannel } from "./CreateChannel.js";
import { ChannelListRow } from "./ChannelListRow.js";

export interface ChannelListProps {
  readonly state: PushDrivenReadState<readonly ChannelListResponseChannel[]>;
  readonly bridge: ConsoleBridge;
  /** The session these channels belong to. `undefined` means nothing was asked. */
  readonly sessionId: string | undefined;
  /**
   * Which participant this window is, where that has been read.
   *
   * Handed down rather than read here, because the read it comes from is chained to
   * the session store and this component holds no store. `undefined` is an ordinary
   * state — the read may be in flight or refused — and both surfaces below fail
   * closed on it: a `direct` row is labelled with both of its members, and the create
   * form's direct arm says which read it is still waiting on.
   */
  readonly viewerParticipantId: string | undefined;
  /** Who else is in this session, for the direct-channel picker. */
  readonly participantIds: readonly string[];
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
   * The read's own trigger rather than a rebuild of this session's models, for the
   * reason the roster's own prop gives: a refusal on one stream says nothing about
   * the others, and this section is the only way back into a directory that refused.
   */
  readonly onReopen: () => void;
}

export function ChannelList(props: ChannelListProps): React.JSX.Element {
  const { state, bridge, sessionId, openPane, activity, labels, isCatchingUp, onReopen } = props;

  // The rows exactly as the daemon served them, and `undefined` until it has. Read
  // apart from the state that carries it because the hook below takes the rows and
  // draws no conclusion from which arm they came off.
  const readChannels = state.kind === "loaded" ? state.value : undefined;
  const { live, archived, goneNotices, lifecycleFor } = useChannelLifecycle(
    bridge,
    sessionId,
    readChannels,
  );
  // The directory travels INTO the roster read, because it is what tells that read its
  // answer has moved: a channel created while this list stayed mounted arrives here from
  // the directory's own re-read, and the three facts a row wears come from a call that
  // has no wire signal of its own. See `channel-roster-read.ts` for why the trigger is
  // the channel set changing rather than the gap between the two reads.
  const roster = useChannelRoster(bridge, sessionId, readChannels);
  const rosterByChannelId = useMemo(() => rosterEntriesById(roster), [roster]);

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
    // channel — the directory projection composes it from the session's own membership
    // count — so naming it before the read lands asserts nothing the reply can
    // contradict. It carries no id, no state, no member count and no control, because
    // those are the read's to supply and a row that opened a channel whose id the
    // console invented would be a worse answer than a slower list.
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

  const rosterUnavailable = rosterRefusal(roster);

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
          detail="A named channel gives agents a room of one topic, so a side thread does not land in the middle of the main one."
        />
      ) : (
        <ul className="meridian-channels__list">
          {live.map((row) => (
            <ChannelListRow
              key={row.channel.id}
              row={row}
              rosterEntry={rosterByChannelId.get(row.channel.id)}
              viewerParticipantId={props.viewerParticipantId}
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

      {rosterUnavailable === undefined ? null : (
        <p className="meridian-channels__roster-refusal">
          <InlineRefusal code={rosterUnavailable.code} detail={rosterUnavailable.detail} />
        </p>
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
                rosterEntry={rosterByChannelId.get(row.channel.id)}
                viewerParticipantId={props.viewerParticipantId}
                activity={activity}
                labels={labels}
                onOpen={openChannel}
                lifecycle={undefined}
              />
            ))}
          </ul>
        </details>
      )}

      <CreateChannel
        bridge={bridge}
        sessionId={sessionId}
        viewerParticipantId={props.viewerParticipantId}
        participantIds={props.participantIds}
        labels={labels}
      />
    </div>
  );
}
