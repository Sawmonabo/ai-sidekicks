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
//
// AND THE RUN BINDING IS A PROJECTION, NEVER A DERIVATION — the same claim the runs
// pane's row makes, because the two are two surfaces over one reading. The registered
// summary carries no run member at all, so the durable binding arrives as its own
// growth-port projection folded onto the feed, and a row draws the run it was handed
// and NOTHING where it was handed none. Absent means the read named no binding for
// this row, which is the column's nullable arm.
//
// THE TARGET IS CLIPPED AND NEVER SHORTENED. A run id is a wire figure and renders
// verbatim (rule 4); what keeps the shelf's one-line-per-item density is the CSS
// clamp on the slot around it, with the whole value in the DOM and on the row's own
// tooltip. A truncation composed here would be the console formatting a wire string,
// which `wire-figures.ts` is the only module allowed to do.

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
  /**
   * The run this item is bound to, where the binding read named one.
   *
   * `undefined` is the unbound row and the not-yet-answered read alike, and the row
   * draws neither as a target: the shelf carries the read's own refusal above the
   * rows, which is where a reader learns the difference.
   */
  readonly targetRunId: string | undefined;
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
      {props.targetRunId === undefined ? null : (
        <span className="meridian-queue-shelf__run" title={props.targetRunId}>
          <span className="meridian-visually-hidden">Bound to run</span>
          <WireFigure value={props.targetRunId} />
        </span>
      )}
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
