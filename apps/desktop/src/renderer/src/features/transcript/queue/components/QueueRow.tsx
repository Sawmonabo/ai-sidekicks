// One queued item in the queue list, split from `QueueContents.tsx`, which owns the read and
// the empty case. The states a row may be canceled from are a closed set kept beside the
// control they gate, so the two cannot drift; the tone table sits with it for the same reason.

import { Chip } from "@renderer/components/Chip/Chip.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import type { QueueItemSummary } from "@ai-sidekicks/contracts";

/** The one state a queue item can still be taken back from. */
const CANCELABLE_STATE = "queued";

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
  not_delivered: "attention",
};

/** One queued item: its state, its figures, and cancel where cancel applies. */
export function QueueRow(props: {
  readonly item: QueueItemSummary;
  readonly isCancelPending: boolean;
  readonly onCancel: (queueItemId: string) => Promise<void>;
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
      {item.state === CANCELABLE_STATE ? (
        <button
          type="button"
          className="meridian-queue__cancel meridian-action-button meridian-action-button--small meridian-action-button--raised"
          disabled={props.isCancelPending}
          aria-busy={props.isCancelPending}
          onClick={() => {
            void props.onCancel(item.id);
          }}
        >
          Cancel
        </button>
      ) : null}
    </li>
  );
}
