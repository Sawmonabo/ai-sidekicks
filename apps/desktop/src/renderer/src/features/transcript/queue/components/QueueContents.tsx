// What is waiting, in the daemon's order, with a way to take one back.
//
// ONE LINE PER ITEM, with anything secondary one click away and never expanded by
// default. Here there is nothing secondary to fold: the line carries what the wire
// supplies — id, state, priority and the two timestamps — and nothing it does not.
//
// THE ORDER IS RENDERED, NEVER REORDERED. `queue-feed.ts` owns the fold that keeps
// the snapshot's canonical FIFO order; this file maps over it. There is no sort
// here, no drag handle, no priority stepper, and no "move to front" — V1 defers
// queue priority overrides, so front-inserting is not an available remedy anywhere.
//
// A CANCELED ROW STAYS. A queue row is durable and never-evented — drained but
// never deleted — so every one of the five states renders as a row rather than as
// an absence. Cancel is offered on the one state that can still be taken back.

import { DerivedFigure, Nothing, formatCount } from "@renderer/console/primitives/index.js";
import type { QueueFeed } from "../queue-reading.js";
import { QueueRow } from "./QueueRow.js";

import "./QueueContents.css";

/**
 * Queue rows rendered before the remainder is folded into a count.
 *
 * The cap is spent by a `slice` and a withheld count, which is the whole mechanism: the
 * queue windows nothing and imports no windowing layer. Below the cap the list is a plain
 * block; above it the surface says how many rows it is not drawing rather than drawing
 * them all. The queue is FIFO and the head is what matters, so the ceiling truncates the
 * tail and never the front.
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
      <Nothing
        kind="not-loaded"
        placement="surface"
        title="Reading what is waiting in the queue."
      />
    );
  }

  if (feed.items.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="Nothing is waiting."
        detail="The queue is empty. A message sent while a run is working lands here and is delivered in the order it arrived."
      />
    );
  }

  const rendered = feed.items.slice(0, QUEUE_ROWS_RENDERED_CAP);
  const withheld = feed.items.length - rendered.length;

  return (
    <div className="meridian-queue">
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
          <DerivedFigure text={formatCount(withheld)} /> further rows are held by the daemon and not
          drawn here. The head of the queue is what is delivered next.
        </p>
      ) : null}
    </div>
  );
}
