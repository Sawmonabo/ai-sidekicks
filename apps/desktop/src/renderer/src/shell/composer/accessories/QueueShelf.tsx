// The queue shelf: what this participant has waiting, and where it is bound.
//
// Hidden until an item exists. That is not a styling choice — an empty shelf and a
// shelf nobody has read yet are both "no rows", and a strip that said so would sit
// above the composer forever announcing the ordinary case. When there IS something
// queued the shelf appears, and its appearing is the signal.
//
// NO REORDER CONTROL EXISTS. Not disabled, not hidden behind a menu: the wire has
// no reorder verb, so offering the gesture at all would be the console promising an
// operation the daemon cannot perform. Priority is the daemon's and is shown as it
// was sent.
//
// A CANCEL IN FLIGHT DISABLES ITS OWN ROW AND NO OTHER. The shelf renders the state
// the reading publishes rather than holding its own: the same set the runs pane's
// queue reads, so two surfaces over one reading never disagree about which row is
// going. The row is `disabled` and `aria-busy` while its id is pending — the
// authoritative single-flight is the reading's own chokepoint, and this is what a
// person sees of it.

import {
  DerivedFigure,
  Glyph,
  InlineRefusal,
  WireFigure,
  formatClockTime,
  formatCount,
} from "../../../console/primitives/index.js";
import type { QueueItemSummary } from "@ai-sidekicks/contracts";
import type { ConsoleRefusal } from "../../../console/core/index.js";
import { QUEUE_SHELF_ROW_CAP } from "./accessory-bounds.js";

export interface QueueShelfProps {
  readonly items: readonly QueueItemSummary[];
  /** The ids whose cancel is in flight, straight off the session's one reading. */
  readonly pendingCancelIds: ReadonlySet<string>;
  readonly cancelRefusalByItemId: ReadonlyMap<string, ConsoleRefusal>;
  readonly onCancel: (queueItemId: string) => void;
}

const CANCEL_GLYPH_SIZE = 12;

export function QueueShelf(props: QueueShelfProps): React.JSX.Element | null {
  if (props.items.length === 0) {
    return null;
  }
  const rendered = props.items.slice(0, QUEUE_SHELF_ROW_CAP);
  const foldedCount = props.items.length - rendered.length;
  return (
    <section className="meridian-queue-shelf" aria-label="Queued messages">
      <ul className="meridian-queue-shelf__rows">
        {rendered.map((item) => (
          <QueueShelfRow
            key={item.id}
            item={item}
            isCancelPending={props.pendingCancelIds.has(item.id)}
            refusal={props.cancelRefusalByItemId.get(item.id)}
            onCancel={props.onCancel}
          />
        ))}
      </ul>
      {foldedCount > 0 ? (
        <p className="meridian-queue-shelf__fold">
          <DerivedFigure text={`+${formatCount(foldedCount)} more waiting`} />
        </p>
      ) : null}
    </section>
  );
}

interface QueueShelfRowProps {
  readonly item: QueueItemSummary;
  readonly isCancelPending: boolean;
  readonly refusal: ConsoleRefusal | undefined;
  readonly onCancel: (queueItemId: string) => void;
}

function QueueShelfRow(props: QueueShelfRowProps): React.JSX.Element {
  const { item } = props;
  return (
    <li className="meridian-queue-shelf__row">
      <WireFigure value={item.state} />
      <span className="meridian-queue-shelf__channel">
        {item.channelId === undefined ? (
          <DerivedFigure text="session" />
        ) : (
          <WireFigure value={item.channelId} />
        )}
      </span>
      <WireFigure value={formatClockTime(item.createdAt)} title={item.createdAt} />
      <button
        type="button"
        className="meridian-queue-shelf__cancel"
        disabled={props.isCancelPending}
        aria-busy={props.isCancelPending}
        onClick={() => {
          props.onCancel(item.id);
        }}
      >
        <Glyph name="close" size={CANCEL_GLYPH_SIZE} />
        <span className="meridian-visually-hidden">
          Cancel the message queued at {formatClockTime(item.createdAt)}
        </span>
      </button>
      {props.refusal === undefined ? null : (
        <InlineRefusal code={props.refusal.code} detail={props.refusal.detail} />
      )}
    </li>
  );
}
