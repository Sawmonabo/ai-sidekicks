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
// AND A PARTIAL READING IS SAID EVEN WHEN NOTHING IS WAITING. A queue delivery this
// build could not read changed no row, which is exactly why the rows alone cannot
// show it: a shelf whose list did not move looks like a queue that did not move. So
// the count and its parse refusal render ABOVE the rows rather than in place of
// them — the rows are still the best reading there is and are no longer offered as a
// complete one — and the hidden-until-an-item-exists rule above yields to it, because
// an empty list beside an unreadable delivery is not the ordinary case the rule
// exists to keep quiet: it is a list whose emptiness is unknown.
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
  /**
   * Queue deliveries that parsed as no registered row since the newest snapshot.
   *
   * The shelf derives whether it is partial FROM this count rather than taking a
   * second flag beside it, exactly as the session queue reading derives its own, so
   * the two can never disagree about whether the rows are complete.
   *
   * Optional at this branch point and nowhere else: the member lands on `QueueFeed`
   * in the session-queue reading's own lane, and `ComposerAccessoryRail` supplies it
   * the moment both are in one tree. Absent means the caller passed no partial
   * reading at all — which this surface renders as the complete arm, because there
   * is no count from which to claim otherwise.
   */
  readonly unreadableDeliveryCount?: number;
  /** The newest unreadable delivery's own parse refusal, rendered beside the count. */
  readonly unreadableRefusal?: ConsoleRefusal;
}

const CANCEL_GLYPH_SIZE = 12;

export function QueueShelf(props: QueueShelfProps): React.JSX.Element | null {
  const unreadableDeliveryCount = props.unreadableDeliveryCount ?? 0;
  const isPartial = unreadableDeliveryCount > 0;
  if (props.items.length === 0 && !isPartial) {
    return null;
  }
  const rendered = props.items.slice(0, QUEUE_SHELF_ROW_CAP);
  const foldedCount = props.items.length - rendered.length;
  return (
    <section className="meridian-queue-shelf" aria-label="Queued messages">
      {isPartial ? (
        <PartialRead
          unreadableDeliveryCount={unreadableDeliveryCount}
          refusal={props.unreadableRefusal}
        />
      ) : null}
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

/**
 * What the shelf says when part of its stream could not be read.
 *
 * Above the rows and never instead of them, and phrased about the SHELF rather than
 * about the wire: a person reading this is deciding whether to trust what they are
 * looking at, and "may be stale" is the consequence, while the delivery's own parse
 * refusal beneath it is the cause for whoever needs it.
 */
function PartialRead(props: {
  readonly unreadableDeliveryCount: number;
  readonly refusal: ConsoleRefusal | undefined;
}): React.JSX.Element {
  return (
    <div className="meridian-queue-shelf__partial" role="status">
      <p className="meridian-queue-shelf__partial-copy">
        <DerivedFigure text={formatCount(props.unreadableDeliveryCount)} />{" "}
        {props.unreadableDeliveryCount === 1 ? "queue delivery" : "queue deliveries"} could not be
        read — the shelf may be stale.
      </p>
      {props.refusal === undefined ? null : (
        <InlineRefusal code={props.refusal.code} detail={props.refusal.detail} />
      )}
    </div>
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
