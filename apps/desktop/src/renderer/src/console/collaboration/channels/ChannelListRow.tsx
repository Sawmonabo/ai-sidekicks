import { Chip, DerivedFigure, WireFigure, formatCount } from "../../primitives/index.js";
import { type ActivityIndicatorRegistry, type ChannelActivityLabels } from "../activity-model.js";
import { type ChannelRow } from "./channel-model.js";
import { ChannelRowActivity } from "./ChannelRowActivity.js";

export interface ChannelListRowProps {
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
export function ChannelListRow(props: ChannelListRowProps): React.JSX.Element {
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

export /** How a channel's wire state reads as a chip. Total over the closed three. */
const STATE_LABEL: Readonly<Record<string, string>> = {
  active: "active",
  muted: "muted",
  archived: "archived",
};
