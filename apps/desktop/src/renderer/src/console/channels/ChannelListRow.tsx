import { Chip, WireFigure } from "../primitives/index.js";
import { type ActivityIndicatorRegistry, type ChannelActivityLabels } from "./activity-model.js";
import { type ChannelRow } from "./channel-model.js";
import { ChannelRowActivity } from "./ChannelRowActivity.js";
import { ChannelRowControls, type ChannelRowLifecycle } from "./ChannelRowControls.js";

export interface ChannelListRowProps {
  readonly row: ChannelRow;
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
 * WHAT IS ON SCREEN. The row shows the name and the state, because those are the two
 * facts that decide whether a person opens it. There is no last-activity stamp beside
 * them, because `channel.list` carries none and a time the console composed would be a
 * figure nobody sent.
 *
 * A MUTED ROW IS DIMMED AND STILL READABLE. Mute suppresses attention, not execution —
 * a muted channel still admits runs — so it keeps its place among the live rows and
 * its text stays legible.
 */
export function ChannelListRow(props: ChannelListRowProps): React.JSX.Element {
  const { row, activity, labels, onOpen, lifecycle } = props;
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
        </span>
      </button>
      {lifecycle === undefined ? null : (
        <ChannelRowControls
          channelLabel={channel.name ?? channel.id}
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
