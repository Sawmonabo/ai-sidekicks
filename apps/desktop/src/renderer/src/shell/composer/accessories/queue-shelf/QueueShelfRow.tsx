// One queued directive, as the composer's shelf shows it.
//
// Split from `QueueShelf.tsx`, which owns what the shelf as a whole can say — the
// snapshot's own reading, the deliveries it could not read — while this owns one
// row of it.
//
// THE ROW RENDERS THE ITEM AND JUDGES NOTHING. Whether a queue was read at all,
// and whether anything is missing from it, are the shelf's questions and are
// answered above; a row that also had an opinion about them would be a second
// answer a reader has no way to reconcile.

import {
  DerivedFigure,
  Glyph,
  InlineRefusal,
  WireFigure,
  formatClockTime,
} from "../../../../console/primitives/index.js";
import type { QueueItemSummary } from "@ai-sidekicks/contracts";
import type { ConsoleRefusal } from "../../../../console/core/index.js";
import { GLYPH_SIZE_ROW } from "../../../../console/tokens/index.js";

interface QueueShelfRowProps {
  readonly item: QueueItemSummary;
  readonly isCancelPending: boolean;
  readonly refusal: ConsoleRefusal | undefined;
  readonly onCancel: (queueItemId: string) => void;
}

export function QueueShelfRow(props: QueueShelfRowProps): React.JSX.Element {
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
        <Glyph name="close" size={GLYPH_SIZE_ROW} />
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
