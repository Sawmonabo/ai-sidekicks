// One queued item in the runs pane's queue list.
//
// Split from `QueueContents.tsx`, which owns the read, the delivery reading, and
// the empty case, while this owns one row.
//
// CANCELLABILITY IS THE WIRE'S ANSWER, NOT A LOOK. The state a row may be
// cancelled from is a closed set kept here beside the control it gates, so the
// control and the rule that admits it cannot drift apart; the tone table sits with
// it for the same reason.

import { Chip, WireFigure } from "../../primitives/index.js";
import { InlineRefusal } from "../../primitives/index.js";
import type { QueueItemSummary } from "@ai-sidekicks/contracts";

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

/** One queued item: its state, its figures, and cancel where cancel applies. */
export function QueueRow(props: {
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
