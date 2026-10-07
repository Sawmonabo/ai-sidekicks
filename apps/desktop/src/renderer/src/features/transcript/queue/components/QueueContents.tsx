// What is waiting, in the daemon's order, with a way to take one back. One line per item, with only
// what the wire supplies. The order is rendered, never reordered
// (`features/transcript/queue/order.ts` keeps it), and all five states render as rows because queue
// rows are durable and never deleted; cancel is offered only on the state that can still be taken
// back.

import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { findReadRefusal } from "#renderer/lib/reads/wire-state.js";
import type { QueueFeed } from "../reading.js";
import { QueueRow } from "./QueueRow.js";

import "./QueueContents.css";

/**
 * Queue rows rendered before the remainder is folded into a count. A `slice` and a withheld
 * count, so the queue imports no windowing layer. The queue is FIFO and the head is delivered
 * next, so the ceiling truncates the tail, never the front.
 */
const QUEUE_ROWS_RENDERED_CAP = 50;

/** What the waiting queue draws: the feed it reads. */
export interface QueueContentsProps {
  readonly feed: QueueFeed;
}

/** The waiting queue's rows, drawn from the feed it is handed. */
export function QueueContents(props: QueueContentsProps): React.JSX.Element {
  const { feed } = props;
  if (feed.phase === "reading") {
    return (
      <Nothing kind="not-loaded" placement="block" title="Reading what is waiting in the queue." />
    );
  }
  const readRefusal = findReadRefusal(feed);
  if (readRefusal !== undefined) {
    return (
      <Nothing
        kind="error"
        placement="block"
        title={readRefusal.code}
        detail={readRefusal.detail}
      />
    );
  }

  if (feed.items.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="block"
        title="Nothing is waiting."
        detail={
          "The queue is empty. A message sent while a run is working lands " +
          "here and is delivered in the order it arrived."
        }
      />
    );
  }

  const rendered = feed.items.slice(0, QUEUE_ROWS_RENDERED_CAP);
  const withheld = feed.items.length - rendered.length;

  return (
    <div>
      <ol className="meridian-queue__rows">
        {rendered.map((item) => (
          <QueueRow
            key={item.id}
            item={item}
            isCancelPending={feed.pendingCancelIds.has(item.id)}
            onCancel={feed.cancelItem}
          />
        ))}
      </ol>
      {withheld > 0 ? (
        <p className="meridian-queue__withheld">
          <DerivedFigure text={formatCount(withheld)} /> further rows are held by the background
          service and not drawn here. The head of the queue is what is delivered next.
        </p>
      ) : null}
    </div>
  );
}
