// What a waiting message's row carries beyond its words: the line saying it is not delivered yet,
// or not delivered at all with its try-again words, and the acts on it. While it waits it offers
// a grip that moves it, `Edit`, `Remove` and, while a turn runs, `Send now`; once its delivery
// failed the row is red and reads `Not delivered · Retry · Edit` on one line. A send the service
// has not answered yet has no item to act on, so it carries none of them.

import { useState } from "react";

import type { QueueItemState } from "@ai-sidekicks/contracts/run/queue";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { useAnnounceWhenChanged } from "#renderer/hooks/announce/useAnnounceWhenChanged.js";
import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import { type Refusal } from "#renderer/lib/refusal/contract.js";
import type { WaitingRow } from "../placement.js";
import type { WaitingRows } from "../waiting-rows.js";

import "./WaitingRowControls.css";

/** The one state a queue item can still be moved, edited, taken back or sent now from. */
const WAITING_STATE = "queued" satisfies QueueItemState;

/** The one state a message can be sent again from; its literal type narrows the item to it. */
const RETRYABLE_STATE = "notDelivered" satisfies QueueItemState;

/** What a waiting row's line and acts read: the row, its key, and the feed's acts. */
export interface WaitingRowControlsProps {
  readonly rowKey: string;
  readonly waitingRow: WaitingRow;
  readonly waitingRows: WaitingRows;
}

/**
 * The line under a waiting message's words: `Not delivered · Retry · Edit` once its delivery
 * failed, with the hook's own words under it when the person's prompt hook blocked it, and while
 * the service is out of reach `Waiting to be delivered`; nothing otherwise.
 */
export function WaitingRowNotice(props: WaitingRowControlsProps): React.JSX.Element | null {
  const { item } = props.waitingRow;
  const { queue, composerRequests } = props.waitingRows;
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
  if (item?.state === RETRYABLE_STATE) {
    const queueItemId = item.id;
    const words = item.kind === "message" ? item.content : undefined;
    const run = (origin: string, call: () => Promise<void>): void => {
      setRefusal(undefined);
      call().catch((rejection: unknown) => {
        setRefusal(coerceToRefusal(rejection, origin, `${origin}-failed`));
      });
    };
    return (
      <>
        <p className="meridian-waiting-row__notice meridian-waiting-row__notice--failed">
          Not delivered ·{" "}
          <TryAgainButton
            word="Retry"
            onPress={() => {
              run("queue-retry", () => queue.retryItem(queueItemId));
            }}
          />
          {words === undefined ? null : (
            <>
              {" · "}
              <button
                type="button"
                className="meridian-clickable-word"
                onClick={() => {
                  // The row goes first, so its words are never in the draft and the flow at once.
                  run("queue-cancel", async () => {
                    await queue.cancelItem(queueItemId);
                    composerRequests.returnToDraft(words);
                  });
                }}
              >
                Edit
              </button>
            </>
          )}
        </p>
        {item.notDeliveredReason.kind === "refusedByHook" ? (
          <p className="meridian-waiting-row__notice meridian-waiting-row__notice--failed">
            {`Blocked by your UserPromptSubmit hook: ${item.notDeliveredReason.words}`}
          </p>
        ) : null}
        {refusal === undefined ? null : (
          <InlineRefusal code={refusal.code} detail={refusal.detail} />
        )}
      </>
    );
  }
  return props.waitingRows.isServiceUnreachable ? (
    <p className="meridian-waiting-row__notice">Waiting to be delivered</p>
  ) : null;
}

/**
 * The acts on a message still waiting: the grip that moves it, `Edit`, `Remove` and, while a turn
 * runs, `Send now`. A row the draft is editing offers none, since its words are in the draft.
 */
export function WaitingRowControls(props: WaitingRowControlsProps): React.JSX.Element | null {
  const { rowKey, waitingRow, waitingRows } = props;
  const { item } = waitingRow;
  const { queue, composerRequests, drag, moveRow, moveRefusal, lastMove } = waitingRows;
  // The moved row names its new place; the move's own record is its attempt, so a second move to
  // the same place is said again.
  const movedHere = lastMove?.rowKey === rowKey ? lastMove : undefined;
  useAnnounceWhenChanged(movedHere?.sentence, "polite", { attempt: movedHere });
  if (item?.state !== WAITING_STATE || waitingRows.editingRowKey === rowKey) {
    return null;
  }
  const queueItemId = item.id;
  return (
    <span className="meridian-waiting-row__acts">
      <button
        type="button"
        ref={drag.handleRef(rowKey)}
        className="meridian-waiting-row__grip"
        aria-label="Move"
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            moveRow(rowKey, event.key === "ArrowUp" ? -1 : 1);
          }
        }}
      />
      {item.kind === "message" ? (
        <WaitingRowAction
          word="Edit"
          refusalOrigin="queue-edit"
          isPending={false}
          onPress={async () => {
            composerRequests.beginEdit({ rowKey, queueItemId, content: item.content });
          }}
        />
      ) : null}
      <WaitingRowAction
        word="Remove"
        refusalOrigin="queue-cancel"
        isPending={queue.pendingCancelIds.has(queueItemId)}
        onPress={() => queue.cancelItem(queueItemId)}
      />
      {waitingRows.hasActiveTurn ? (
        <WaitingRowAction
          word="Send now"
          refusalOrigin="queue-send-now"
          isPending={false}
          onPress={() => composerRequests.sendNow(queueItemId)}
        />
      ) : null}
      {moveRefusal?.rowKey === rowKey ? (
        <InlineRefusal code={moveRefusal.refusal.code} detail={moveRefusal.refusal.detail} />
      ) : null}
    </span>
  );
}

// One act on the row, a quiet word. A refused call is drawn beside it in the daemon's own words,
// and the act stays to be pressed again.
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
        className="meridian-clickable-word meridian-waiting-row__action"
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
