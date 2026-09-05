// What is waiting, in the daemon's order, with a way to take one back.
//
// THIS SURFACE'S OWN DENSITY RULE, because no committed document states it: one
// line per item, with anything secondary one click away and never expanded by
// default — the shape `Spec-023 §Meridian, the design language` rule 7 gives every
// console surface, where "secondary controls live one click away — a row's hover
// footer or its context menu". Here there is nothing secondary to fold: the
// registered summary carries no payload and no run member, so the line carries what
// the wire supplies — id, state, priority, channel, and the two timestamps — and
// nothing it does not.
//
// THE ORDER IS RENDERED, NEVER REORDERED. `bridge/queue-feed.ts` owns the fold that keeps
// the snapshot's canonical FIFO order; this file maps over it. There is no sort
// here, no drag handle, no priority stepper, and no "move to front" — V1 defers
// queue priority overrides, so front-inserting is not an available remedy anywhere.
//
// A CANCELED ROW STAYS. A queue row is durable and never-evented — drained but
// never deleted — so every one of the five states renders as a row rather than as
// an absence. Cancel is offered on the one state that can still be taken back.
//
// AND A PARTIAL READING SAYS SO BESIDE THE ROWS. A tail delivery this build could
// not read changed no row, which is exactly why the rows alone cannot show it: the
// list looks like a queue that has not moved. The feed's own count and its parse
// refusal render above the list rather than in place of it — the rows are still the
// best reading there is, and they are no longer offered as a complete one.

import {
  Chip,
  DerivedFigure,
  Nothing,
  PartialRead,
  RefusalCard,
  WireFigure,
  unreadableDeliveryReading,
} from "../../primitives/index.js";
import { formatCount, InlineRefusal } from "../../primitives/index.js";
import type { QueueItemSummary } from "@ai-sidekicks/contracts";
import { QUEUE_ROWS_RENDERED_CAP } from "./runs-bounds.js";
import type { ReadingState } from "../../primitives/index.js";
import type { QueueFeed } from "../../bridge/index.js";

/** The one state a queue item can still be taken back from. */
const CANCELLABLE_STATE = "queued";

/**
 * The tone each of the five states takes. Total over the closed set, so a sixth
 * state fails to compile rather than rendering in whichever tone a fallback picked.
 */
const QUEUE_STATE_TONES: Readonly<
  Record<QueueItemSummary["state"], "neutral" | "accent" | "attention">
> = {
  queued: "accent",
  admitted: "neutral",
  superseded: "attention",
  canceled: "neutral",
  expired: "attention",
};

export interface QueueContentsProps {
  readonly feed: QueueFeed;
}

export function QueueContents(props: QueueContentsProps): React.JSX.Element {
  const { feed } = props;
  // Derived once and branched on twice, so the reading the notice renders and the
  // reading that decides whether the empty arm may reassure are the same one.
  const deliveries = deliveryReading(feed);

  if (feed.phase === "refused") {
    return feed.readRefusal === undefined ? (
      <Nothing
        kind="error"
        placement="surface"
        title="The queue could not be read."
        detail="The daemon refused the read and named no reason the console could render."
      />
    ) : (
      <RefusalCard code={feed.readRefusal.code} detail={feed.readRefusal.detail} />
    );
  }

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
    return deliveries.kind !== "served" ? (
      // An empty list and an unreadable delivery are both true at once, and the
      // reassuring arm is unavailable: a row this build could not read is a row
      // whose existence is unknown, never one known to be absent.
      <div className="meridian-queue">
        <PartialRead states={[deliveries]} subject="the queue" />
      </div>
    ) : (
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
      <PartialRead states={[deliveries]} subject="the queue" />
      <ol className="meridian-queue__rows">
        {rendered.map((item) => (
          <QueueRow
            key={item.id}
            item={item}
            isCancelPending={feed.pendingCancelIds.has(item.id)}
            cancelRefusal={feed.cancelRefusalByItemId.get(item.id)}
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

/**
 * The tail's deliveries, in the console's one reading vocabulary.
 *
 * What stood here was this file's own notice component — its own box, its own two
 * sentences, and a name that shadowed the primitive it duplicated. The count-to-state
 * step is the model's (`primitives/partial-read.ts`), the sentence is the model's, and
 * a count of zero answers `served`, which renders nothing: the surface no longer has
 * to ask whether it is partial before deciding whether to mount the notice.
 */
function deliveryReading(feed: QueueFeed): ReadingState {
  return unreadableDeliveryReading(feed.unreadableDeliveryCount, feed.unreadableRefusal);
}

/** One queued item: its state, its figures, and cancel where cancel applies. */
function QueueRow(props: {
  readonly item: QueueItemSummary;
  readonly isCancelPending: boolean;
  readonly cancelRefusal: { readonly code: string; readonly detail: string } | undefined;
  readonly onCancel: (queueItemId: string) => void;
}): React.JSX.Element {
  const { item } = props;
  return (
    <li className="meridian-queue__row">
      <div className="meridian-queue__identity">
        <Chip tone={QUEUE_STATE_TONES[item.state]} label={item.state} mono />
        <WireFigure value={item.id} />
      </div>
      <dl className="meridian-queue__figures">
        <div className="meridian-queue__figure">
          <dt>Priority</dt>
          <dd>
            <WireFigure value={String(item.priority)} />
          </dd>
        </div>
        {item.channelId === undefined ? null : (
          <div className="meridian-queue__figure">
            <dt>Channel</dt>
            <dd>
              <WireFigure value={item.channelId} />
            </dd>
          </div>
        )}
        <div className="meridian-queue__figure">
          <dt>Created</dt>
          <dd>
            <WireFigure value={item.createdAt} />
          </dd>
        </div>
        <div className="meridian-queue__figure">
          <dt>Updated</dt>
          <dd>
            <WireFigure value={item.updatedAt} />
          </dd>
        </div>
      </dl>
      {item.state === CANCELLABLE_STATE ? (
        <button
          type="button"
          className="meridian-queue__cancel"
          disabled={props.isCancelPending}
          aria-busy={props.isCancelPending}
          onClick={() => {
            props.onCancel(item.id);
          }}
        >
          Cancel
        </button>
      ) : null}
      {props.cancelRefusal === undefined ? null : (
        <InlineRefusal code={props.cancelRefusal.code} detail={props.cancelRefusal.detail} />
      )}
    </li>
  );
}
