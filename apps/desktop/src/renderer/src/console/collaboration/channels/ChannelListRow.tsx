import { Chip, DerivedFigure, WireFigure, formatCount } from "../../primitives/index.js";
import type { GrowthChannelRosterEntry } from "../../bridge/index.js";
import { type ActivityIndicatorRegistry, type ChannelActivityLabels } from "../activity-model.js";
import { type ChannelRow } from "./channel-model.js";
import { channelAudienceOf, directChannelLabel } from "./channel-roster.js";
import { ChannelRowActivity } from "./ChannelRowActivity.js";
import { ChannelRowControls, type ChannelRowLifecycle } from "./ChannelRowControls.js";

export interface ChannelListRowProps {
  readonly row: ChannelRow;
  /**
   * What the roster read said about this channel, where it named it.
   *
   * `undefined` is a real and ordinary state, not a gap: the main channel has no
   * channel row at all, so the roster carries no entry for it, and a read still in
   * flight or refused names nothing either. Such a row renders no badge and is not
   * labelled by a pair — never a badge the console decided for itself.
   */
  readonly rosterEntry: GrowthChannelRosterEntry | undefined;
  /** Which participant this window is, where that has been read. See the label rule. */
  readonly viewerParticipantId: string | undefined;
  readonly activity: ActivityIndicatorRegistry;
  readonly labels: ChannelActivityLabels;
  readonly onOpen: (channelId: string) => void;
  /**
   * The three lifecycle moves, or `undefined` where the row takes none.
   *
   * The caller decides that on the row's own wire state and on nothing else: an
   * archived row is terminal, so it is handed no lifecycle at all.
   */
  readonly lifecycle: ChannelRowLifecycle | undefined;
}

/**
 * One channel, as a two-line entry.
 *
 * OPENING IT IS THE ROW; the lifecycle moves are beside it. The name and its marks are
 * one `<button>` rather than a div with a handler, so opening is keyboard-reachable
 * and focus-visible without a single attribute of its own, and the acts that are not
 * "open this" sit outside it — a control inside a control is one target a keyboard
 * cannot separate.
 *
 * WHAT IS ON SCREEN AND WHAT IS ONE HOVER AWAY. The row shows the name, the audience
 * badge, and the state, because those are the three facts that decide whether a person
 * opens it. The participant count rides the row's own tooltip: it is a number nobody
 * scans a list by, and a row carrying it inline reads as three figures with equal
 * weight. There is no last-activity stamp beside it, because `channel.list` carries
 * none and a time the console composed would be a figure nobody sent.
 *
 * A MUTED ROW IS DIMMED AND STILL READABLE. Mute suppresses attention, not execution —
 * a muted channel still admits runs — so it keeps its place among the live rows and
 * its text stays legible.
 */
export function ChannelListRow(props: ChannelListRowProps): React.JSX.Element {
  const { row, rosterEntry, activity, labels, onOpen, lifecycle } = props;
  const { channel } = row;
  const isArchived = channel.state === "archived";
  const audience = channelAudienceOf(rosterEntry);
  const pairLabel = directChannelLabel(rosterEntry, props.viewerParticipantId, labels);
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
        title={`${formatCount(channel.participantCount)} ${channel.participantCount === 1 ? "member" : "members"}`}
        onClick={() => {
          onOpen(channel.id);
        }}
      >
        <span className="meridian-channel-row__name">
          {pairLabel === undefined ? (
            channel.name === undefined ? (
              // An unnamed channel is a real wire shape — `name` is optional, and
              // omission is the signal for a channel with no friendly label. Its id is
              // what it has, so the id is what it wears.
              <WireFigure value={channel.id} />
            ) : (
              <WireFigure value={channel.name} />
            )
          ) : (
            // A `direct` channel is labelled by the human it is with, never by a
            // channel name: its membership is the immutable two-human pair fixed at
            // creation, so the pair IS what the row is. The label is composed by the
            // console out of the ids the roster sent, which is why it reads as a
            // derived figure rather than as a string the wire supplied.
            <DerivedFigure text={pairLabel} />
          )}
        </span>
        <span className="meridian-channel-row__marks">
          {audience === undefined ? null : (
            <span
              className="meridian-channel-row__audience"
              title={
                audience === "participants"
                  ? "This session's agents read this channel."
                  : "No agent ever reads this channel."
              }
            >
              <Chip label={audience} mono />
            </span>
          )}
          <Chip label={STATE_LABEL[channel.state] ?? channel.state} mono />
        </span>
      </button>
      {lifecycle === undefined ? null : (
        <ChannelRowControls
          channelLabel={pairLabel ?? channel.name ?? channel.id}
          isMuted={channel.state === "muted"}
          lifecycle={lifecycle}
        />
      )}
      <ChannelRowActivity activity={activity} channelId={channel.id} labels={labels} />
    </li>
  );
}

/** How a channel's wire state reads as a chip. Total over the closed three. */
const STATE_LABEL: Readonly<Record<string, string>> = {
  active: "active",
  muted: "muted",
  archived: "archived",
};
