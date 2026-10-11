// One queued item in the queue list, split from `QueueContents.tsx`, which owns the read and
// the empty case. The state a row may be canceled from and the one it may be retried from sit
// beside the controls they gate, so the two cannot drift; the tone table sits with them for the
// same reason.

import { useState } from "react";

import { Chip, type ChipTone } from "#renderer/components/Chip/Chip.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { codeWords } from "#renderer/lib/code-words.js";
import { formatAge, formatZonedDateTime } from "#renderer/lib/wire/figures.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import { type Refusal } from "#renderer/lib/refusal/contract.js";
import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";

/** The one state a queue item can still be taken back from. */
const CANCELABLE_STATE: QueueItemSummary["state"] = "queued";

/** The one state a queue item can be sent again from. */
const RETRYABLE_STATE: QueueItemSummary["state"] = "not_delivered";

/**
 * The tone each of the five states takes. A failed delivery is red; a replaced or canceled message
 * needs nobody, so it takes no hue. Total over the closed set, so a sixth state fails to compile
 * rather than rendering in whichever tone a fallback picked.
 */
const QUEUE_STATE_TONES: Readonly<Record<QueueItemSummary["state"], ChipTone>> = {
  queued: "accent",
  admitted: "neutral",
  superseded: "neutral",
  canceled: "neutral",
  not_delivered: "failure",
};

/**
 * One queued item: its state, its figures, `Remove`, which cancels it, where cancel applies, and
 * `Retry`, which sends it again in its own words, where it was not delivered.
 */
export function QueueRow(props: {
  readonly item: QueueItemSummary;
  readonly isCancelPending: boolean;
  readonly onCancel: (queueItemId: string) => Promise<void>;
  readonly isRetryPending: boolean;
  readonly onRetry: (queueItemId: string) => Promise<void>;
  /** The instant the row's ages are drawn against, on the list's one beat. */
  readonly nowMilliseconds: number;
}): React.JSX.Element {
  const { item } = props;
  const clockLocale = useClockLocale();
  return (
    <li className="meridian-queue__row">
      <div className="meridian-queue__identity">
        <Chip tone={QUEUE_STATE_TONES[item.state]} label={codeWords(item.state)} />
        <WireFigure value={item.id} />
      </div>
      <dl className="meridian-queue__figures">
        <div className="meridian-queue__figure">
          <dt>Created</dt>
          <dd>
            <WireFigure
              value={formatAge(item.createdAt, props.nowMilliseconds)}
              hoverLabel={formatZonedDateTime(item.createdAt, clockLocale)}
            />
          </dd>
        </div>
        <div className="meridian-queue__figure">
          <dt>Updated</dt>
          <dd>
            <WireFigure
              value={formatAge(item.updatedAt, props.nowMilliseconds)}
              hoverLabel={formatZonedDateTime(item.updatedAt, clockLocale)}
            />
          </dd>
        </div>
      </dl>
      {item.state === CANCELABLE_STATE ? (
        <QueueRowAction
          word="Remove"
          className="meridian-queue__cancel"
          refusalOrigin="queue-cancel"
          isPending={props.isCancelPending}
          onPress={() => props.onCancel(item.id)}
        />
      ) : null}
      {item.state === RETRYABLE_STATE ? (
        <QueueRowAction
          word="Retry"
          className="meridian-queue__retry"
          refusalOrigin="queue-retry"
          isPending={props.isRetryPending}
          onPress={() => props.onRetry(item.id)}
        />
      ) : null}
    </li>
  );
}

// One row control. A refused call is drawn beside it in the daemon's own words, and the control
// stays to be pressed again.
function QueueRowAction(props: {
  readonly word: string;
  readonly className: string;
  /** The origin a refusal is reported under; its code, when the rejection named none, adds `-failed`. */
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
          `${props.className} meridian-action-button ` +
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
