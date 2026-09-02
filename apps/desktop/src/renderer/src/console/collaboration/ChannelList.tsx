// Every channel this participant may see, main first, state legible without
// opening it.
//
// WHAT IS OFFERED, AND WHY IT IS ONE THING. Opening a channel is renderer-local:
// the row hands the deck a timeline pane scoped to the channel entity, which is the
// registered pane kind and the registered entity kind. Mute, unmute, archive, and
// create are NOT offered, because `channel.mute`, `channel.unmute`,
// `channel.archive`, and `channel.create` are registered on no transport — not as a
// daemon method, not as a control-plane procedure, and not as a growth-port
// operation with a slate row behind it. An offered control with no wire behind it
// claims a capability the console does not have, and drawing it disabled is the
// same claim with a tooltip. The list says so once, in a line under the rows, so a
// person knows the absence is the console's honesty rather than their permissions.
//
// WHAT IS NOT RENDERED, BECAUSE THE WIRE DOES NOT CARRY IT. `ChannelListResponse-
// Channel` is `{id, name?, state, participantCount}`. There is no audience field,
// no kind discriminator, and no member pair, so there is no audience badge and no
// pair-labelled row here. Audience is a daemon obligation and never renderer
// etiquette: deriving one from the members would be the console asserting a fact
// nobody sent it, and getting it wrong would put an agent in a room that was
// supposed to have none.
//
// THE NON-DISCLOSURE FILTER IS INVISIBLE ON PURPOSE. A channel the caller may not
// see is omitted from the response, and this list has no concept of a hidden row
// and shows no count of one. Rendering "3 more you cannot see" would leak exactly
// what the omission protects.
//
// ARCHIVED ROWS SINK AND COLLAPSE. Archival is terminal, so that region only grows;
// it lives behind one disclosure, closed by default, and carries no unmute
// affordance — there is nothing to unmute, and offering it would suggest the row
// could come back.

import { useCallback, useMemo } from "react";

import type { ChannelListResponseChannel } from "@ai-sidekicks/contracts";

import {
  Chip,
  DerivedFigure,
  Nothing,
  RefusalCard,
  WireFigure,
  formatCount,
} from "../primitives/index.js";
import type { SidebarSectionContext } from "../workspace/seats/index.js";
import {
  useChannelActivity,
  type ActivityIndicatorRegistry,
  type ChannelActivityLabels,
} from "./activity-model.js";
import { orderChannelRows, type ChannelRow } from "./channel-model.js";
import { ARCHIVED_CHANNEL_VISIBLE_CAP } from "./constants.js";
import { CreateChannel } from "./CreateChannel.js";
import type { PushDrivenReadState } from "./push-driven-read.js";
import { TypingActivity } from "./TypingActivity.js";

export interface ChannelListProps {
  readonly state: PushDrivenReadState<readonly ChannelListResponseChannel[]>;
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
}

/** How a channel's wire state reads as a chip. Total over the closed three. */
const STATE_LABEL: Readonly<Record<string, string>> = {
  active: "active",
  muted: "muted",
  archived: "archived",
};

export function ChannelList(props: ChannelListProps): React.JSX.Element {
  const { state, openPane, activity, labels, isCatchingUp } = props;

  const ordered = useMemo(
    () => (state.kind === "loaded" ? orderChannelRows(state.value) : undefined),
    [state],
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
    return (
      <div className="meridian-channels">
        <Nothing kind="not-loaded" title="Reading this session's channels." />
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="meridian-channels">
        <RefusalCard code={state.refusal.code} detail={state.refusal.detail} />
      </div>
    );
  }

  const rows = ordered ?? { live: [], archived: [] };

  return (
    <div className="meridian-channels">
      {isCatchingUp ? (
        <p className="meridian-channels__degraded" role="status">
          <DerivedFigure text="Channel state is catching up. These rows are the last the console read." />
        </p>
      ) : null}

      {rows.live.length === 0 ? (
        <Nothing
          kind="empty"
          placement="surface"
          title="This session has no channel the console can see."
          detail="A named channel gives agents a room of one topic, so a side thread does not land in the middle of the main one."
        />
      ) : (
        <ul className="meridian-channels__list">
          {rows.live.map((row) => (
            <ChannelListRow
              key={row.channel.id}
              row={row}
              activity={activity}
              labels={labels}
              onOpen={openChannel}
            />
          ))}
        </ul>
      )}

      {rows.archived.length === 0 ? null : (
        <details className="meridian-channels__archive">
          <summary className="meridian-channels__archive-summary">
            <DerivedFigure
              text={`${formatCount(rows.archived.length)} archived ${rows.archived.length === 1 ? "channel" : "channels"}`}
            />
          </summary>
          <ul className="meridian-channels__list meridian-channels__list--archived">
            {rows.archived.slice(0, ARCHIVED_CHANNEL_VISIBLE_CAP).map((row) => (
              <ChannelListRow
                key={row.channel.id}
                row={row}
                activity={activity}
                labels={labels}
                onOpen={openChannel}
              />
            ))}
          </ul>
        </details>
      )}

      <CreateChannel />
    </div>
  );
}

interface ChannelListRowProps {
  readonly row: ChannelRow;
  readonly activity: ActivityIndicatorRegistry;
  readonly labels: ChannelActivityLabels;
  readonly onOpen: (channelId: string) => void;
}

/**
 * One channel, as a two-line entry.
 *
 * The whole row is the control, because there is exactly one thing to do with a
 * channel and a row carrying one button beside an inert label would be two targets
 * for one action. It is a `<button>` rather than a div with a handler so it is
 * keyboard-reachable and focus-visible without a single attribute of its own.
 */
function ChannelListRow(props: ChannelListRowProps): React.JSX.Element {
  const { row, activity, labels, onOpen } = props;
  const { channel } = row;
  const isArchived = channel.state === "archived";
  const className = [
    "meridian-channel-row",
    row.isMain ? "meridian-channel-row--main" : "",
    channel.state === "muted" ? "meridian-channel-row--muted" : "",
    isArchived ? "meridian-channel-row--archived" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");

  return (
    <li className={className}>
      <button
        type="button"
        className="meridian-channel-row__open"
        onClick={() => {
          onOpen(channel.id);
        }}
      >
        <span className="meridian-channel-row__name">
          {channel.name === undefined ? (
            // An unnamed channel is a real wire shape — `name` is optional, and
            // omission is the signal for a channel with no friendly label. Its id is
            // what it has, so the id is what it wears.
            <WireFigure value={channel.id} />
          ) : (
            <WireFigure value={channel.name} />
          )}
        </span>
        <span className="meridian-channel-row__marks">
          <Chip label={STATE_LABEL[channel.state] ?? channel.state} mono />
          <span className="meridian-channel-row__count">
            <DerivedFigure
              text={`${formatCount(channel.participantCount)} ${channel.participantCount === 1 ? "member" : "members"}`}
            />
          </span>
        </span>
      </button>
      <ChannelRowActivity activity={activity} channelId={channel.id} labels={labels} />
    </li>
  );
}

/**
 * The row's live indicator, subscribed rather than read once.
 *
 * Its own component so the subscription is scoped to the row: a composer appearing
 * in one channel re-renders that row's line and leaves every other row's alone,
 * which is what keeps a busy session from re-rendering the whole list on each
 * keystroke somebody else makes.
 */
function ChannelRowActivity(props: {
  readonly activity: ActivityIndicatorRegistry;
  readonly channelId: string;
  readonly labels: ChannelActivityLabels;
}): React.JSX.Element | null {
  const activity = useChannelActivity(props.activity, props.channelId);
  return <TypingActivity activity={activity} labels={props.labels} />;
}
