// What a waiting message's row carries beyond its words: the line saying it is not delivered yet
// or not delivered at all, and the acts on it. `Remove` is offered only while the item can still be
// taken back and `Retry` only once its delivery failed; a send the service has not answered yet
// has no item to act on, so it carries neither.

import { useState } from "react";

import type { QueueItemState } from "@ai-sidekicks/contracts/run/queue";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import { type Refusal } from "#renderer/lib/refusal/contract.js";
import type { WaitingRow } from "../placement.js";
import type { WaitingRows } from "../waiting-rows.js";

import "./WaitingRowControls.css";

/** The one state a queue item can still be taken back from. */
const CANCELABLE_STATE: QueueItemState = "queued";

/** The one state a message can be sent again from. */
const RETRYABLE_STATE: QueueItemState = "notDelivered";

/** What a waiting row's line and acts read: the row, and the feed's acts and connection. */
export interface WaitingRowControlsProps {
  readonly waitingRow: WaitingRow;
  readonly waitingRows: WaitingRows;
}

/**
 * The line under a waiting message's words: `Not delivered` once its delivery failed, and while
 * the service is out of reach `Waiting to be delivered`; nothing otherwise.
 */
export function WaitingRowNotice(props: WaitingRowControlsProps): React.JSX.Element | null {
  if (props.waitingRow.state === RETRYABLE_STATE) {
    return (
      <p className="meridian-waiting-row__notice meridian-waiting-row__notice--failed">
        Not delivered
      </p>
    );
  }
  return props.waitingRows.isServiceUnreachable ? (
    <p className="meridian-waiting-row__notice">Waiting to be delivered</p>
  ) : null;
}

/** The acts on a waiting message: `Remove` while it waits, `Retry` once its delivery failed. */
export function WaitingRowControls(props: WaitingRowControlsProps): React.JSX.Element | null {
  const { queueItemId, state } = props.waitingRow;
  const { queue } = props.waitingRows;
  if (queueItemId === undefined) {
    return null;
  }
  if (state === CANCELABLE_STATE) {
    return (
      <WaitingRowAction
        word="Remove"
        refusalOrigin="queue-cancel"
        isPending={queue.pendingCancelIds.has(queueItemId)}
        onPress={() => queue.cancelItem(queueItemId)}
      />
    );
  }
  if (state === RETRYABLE_STATE) {
    return (
      <WaitingRowAction
        word="Retry"
        refusalOrigin="queue-retry"
        isPending={queue.pendingRetryIds.has(queueItemId)}
        onPress={() => queue.retryItem(queueItemId)}
      />
    );
  }
  return null;
}

// One act on the row. A refused call is drawn beside it in the daemon's own words, and the act
// stays to be pressed again.
function WaitingRowAction(props: {
  readonly word: string;
  /** The origin a refusal is reported under; with `-failed` added, the code of one naming none. */
  readonly refusalOrigin: string;
  readonly isPending: boolean;
  readonly onPress: () => Promise<void>;
}): React.JSX.Element {
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
  return (
    <>
      <button
        type="button"
        className={
          "meridian-waiting-row__action meridian-action-button " +
          "meridian-action-button--small meridian-action-button--raised"
        }
        disabled={props.isPending}
        aria-busy={props.isPending}
        onClick={() => {
          setRefusal(undefined);
          props.onPress().catch((rejection: unknown) => {
            setRefusal(
              coerceToRefusal(rejection, props.refusalOrigin, `${props.refusalOrigin}-failed`),
            );
          });
        }}
      >
        {props.word}
      </button>
      {refusal === undefined ? null : <InlineRefusal code={refusal.code} detail={refusal.detail} />}
    </>
  );
}
