// A long table's hidden frame: the rows its measurement reads, drawn as the table's cells draw. It
// is read in the resize observation that follows the browser's own layout of it, so reading it
// lays nothing out; each frame is a new table, observed from its first layout.

import { useCallback } from "react";

import { type MarkdownTableOffer } from "#renderer/components/Markdown/table-offer.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";
import { type TableMeasuringFrame } from "../markdown/table-window/measurement.js";
import "./TableSampleFrame.css";

/** What a long table's hidden frame is drawn from and read by. */
export interface TableSampleFrameProps {
  /** The table, and the markdown renderer's drawing of each of its parts. */
  readonly offer: MarkdownTableOffer;
  readonly frame: TableMeasuringFrame;
  /** Reads `frame` from the table it is drawn in, in each observation of that table's layout. */
  readonly readFrame: (frame: TableMeasuringFrame, table: HTMLTableElement) => void;
}

/**
 * The rows a long table's measurement reads, laid out hidden at the body's width: a row of each
 * inline kind, or the head and the body rows holding each column's widest cells.
 */
export function TableSampleFrame(props: TableSampleFrameProps): React.JSX.Element {
  const { offer, frame, readFrame } = props;
  const attachTable = useCallback(
    (element: HTMLTableElement) =>
      observeElementResize(element, () => {
        readFrame(frame, element);
      }),
    [frame, readFrame],
  );
  return (
    <div className="meridian-table-sample-frame" aria-hidden="true" inert>
      {offer.drawFrame({
        tableRef: attachTable,
        columns: undefined,
        rowCount: undefined,
        headRow: frame.kind === "cell-type" ? null : offer.drawHeadRow({}),
        bodyRows:
          frame.kind === "cell-type"
            ? offer.drawTypeSampleRows()
            : frame.sampleRowIndexes.map((index) => offer.drawBodyRow(index, {})),
      })}
    </div>
  );
}
