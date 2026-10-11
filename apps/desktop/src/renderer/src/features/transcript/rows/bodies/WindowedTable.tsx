// A markdown table in a transcript viewport's reply, whatever the reply's length. A short one is
// drawn whole, its columns laid out by the browser from every row. A long one draws only the rows
// near the conversation's viewport, inside one real table whose columns are held at the widths
// automatic layout gives the whole table, so no column moves as rows come and go; a spacer row
// holds the room of each run of undrawn rows.

import { type MarkdownTableOffer } from "#renderer/components/Markdown/table-offer.js";
import {
  MARKDOWN_FIRST_UNDRAWN_ROW_ATTRIBUTE,
  MARKDOWN_LAST_UNDRAWN_ROW_ATTRIBUTE,
  MARKDOWN_TABLE_KEY_ATTRIBUTE,
  MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE,
} from "../markdown/block-window/markers.js";
import { WHOLE_TABLE_MAX_BODY_ROWS } from "../markdown/table-window/long-tables.js";
import { useTableWindow } from "./hooks/useTableWindow.js";
import { TableSampleFrame } from "./TableSampleFrame.js";

/** What a viewport's table is drawn from. */
export interface WindowedTableProps {
  /** The table, and the markdown renderer's drawing of each of its parts. */
  readonly offer: MarkdownTableOffer;
}

/** One table in a transcript viewport, its rows windowed once it is long. */
export function WindowedTable(props: WindowedTableProps): React.ReactNode {
  const { offer } = props;
  return offer.bodyRowCount <= WHOLE_TABLE_MAX_BODY_ROWS ? (
    offer.drawWhole()
  ) : (
    <LongTable offer={offer} />
  );
}

/**
 * A long table drawn as a window over its rows, under a head that is always drawn; drawn whole
 * until its first columns are measured, and as it last stood while it is measured again.
 */
function LongTable(props: { readonly offer: MarkdownTableOffer }): React.JSX.Element {
  const { offer } = props;
  const tableWindow = useTableWindow(offer);
  const { heldColumns, measuring } = tableWindow;
  return (
    <>
      {measuring === undefined ? null : (
        <TableSampleFrame
          offer={offer}
          frame={measuring}
          readFrame={tableWindow.readMeasuringFrame}
        />
      )}
      {tableWindow.drawsWhole ? offer.drawWhole() : null}
      {heldColumns === undefined
        ? null
        : offer.drawFrame({
            bodyRef: tableWindow.attachBody,
            columns: heldColumns,
            // The head row counts as the first row; a body row's place follows it.
            rowCount: offer.bodyRowCount + 1,
            headRow: offer.drawHeadRow({ "aria-rowindex": 1 }),
            bodyRows: tableWindow.rows.map((row) =>
              row.kind === "row"
                ? offer.drawBodyRow(row.index, {
                    ref: tableWindow.attachRow,
                    [MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE]: row.index,
                    "aria-rowindex": row.index + 2,
                  })
                : offer.drawSpacerRow(row.key, row.heightPx, {
                    [MARKDOWN_TABLE_KEY_ATTRIBUTE]: tableWindow.tableKey,
                    [MARKDOWN_FIRST_UNDRAWN_ROW_ATTRIBUTE]: row.firstIndex,
                    [MARKDOWN_LAST_UNDRAWN_ROW_ATTRIBUTE]: row.lastIndex,
                  }),
            ),
          })}
    </>
  );
}
