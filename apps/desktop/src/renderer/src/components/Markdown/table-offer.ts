import type { Table } from "mdast";

/**
 * What a line of a table cell can hold that sets its height apart: plain text, a code span, a
 * footnote marker, an ideograph in its fallback font. A caller reads each one's line from the type
 * sample rows, drawn in this order.
 */
export type TableLineKind = (typeof TABLE_LINE_KINDS)[number];

/**
 * One table a body draws, offered to a body that draws long tables itself: the parsed table, and
 * the markdown renderer's own drawing of each of its parts, so a caller choosing which rows to draw
 * draws them exactly as the whole table would.
 */
export interface MarkdownTableOffer {
  readonly table: Table;
  /** How many rows the table holds below its head row. */
  readonly bodyRowCount: number;
  /** How many columns its delimiter line declares. */
  readonly columnCount: number;
  /** The table drawn whole: every row, its columns sized to their cells by automatic layout. */
  readonly drawWhole: () => React.ReactNode;
  /** The table's element around rows the caller chose, held at given column widths when given. */
  readonly drawFrame: (frame: MarkdownTableFrame) => React.ReactNode;
  /**
   * Body rows drawn as this table's cells draw them, for a caller reading how its cells set text:
   * one whose one cell holds plain, bold, italic and code text and a footnote marker, then a row of
   * one line for each of `TABLE_LINE_KINDS`, in order.
   */
  readonly drawTypeSampleRows: () => React.ReactNode;
  /** The head row, with `attributes` on its `<tr>`. */
  readonly drawHeadRow: (attributes: MarkdownTableRowAttributes) => React.ReactNode;
  /**
   * Body row `index`, counted from the first row below the head, with `attributes` on it and keyed
   * by its place in the text, so a list of drawn rows needs no key of its own.
   */
  readonly drawBodyRow: (index: number, attributes: MarkdownTableRowAttributes) => React.ReactNode;
  /**
   * A row keyed `key` holding `heightPx` of room for rows not drawn, hidden from assistive
   * technology. It draws no cell and no border, so it is never mistaken for rows.
   */
  readonly drawSpacerRow: (
    key: string,
    heightPx: number,
    attributes: MarkdownTableRowAttributes,
  ) => React.ReactNode;
}

/** What a caller puts in a table's frame. */
export interface MarkdownTableFrame {
  readonly tableRef?: React.Ref<HTMLTableElement>;
  readonly bodyRef?: React.Ref<HTMLTableSectionElement>;
  /** The widths the columns are held at; `undefined` lays them out from the rows drawn. */
  readonly columns: HeldTableColumns | undefined;
  /** Every row of the table, the head row included, for assistive technology; or `undefined`. */
  readonly rowCount: number | undefined;
  readonly headRow: React.ReactNode;
  readonly bodyRows: React.ReactNode;
}

/** A table's column widths and its own width, in CSS pixels, as automatic layout gave them. */
export interface HeldTableColumns {
  readonly widthsPx: readonly number[];
  readonly tableWidthPx: number;
}

/** What a caller puts on one drawn row: its ref, its marks and its place for ARIA. */
export type MarkdownTableRowAttributes = React.ComponentProps<"tr"> & {
  readonly [dataAttribute: `data-${string}`]: string | number | undefined;
};

/** Each kind of line a table's type sample rows measure, in the order they are drawn. */
export const TABLE_LINE_KINDS = ["plain", "code", "footnote", "ideograph"] as const;
