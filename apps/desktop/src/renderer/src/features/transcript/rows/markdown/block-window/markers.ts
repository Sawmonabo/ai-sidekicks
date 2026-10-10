// What a windowed body marks its block wrappers and a windowed table its rows and spacers with. The
// windows write them; each window's own measurement and selection pins read its index back, a
// selection end is anchored to the innermost marked element holding it, a copy reads a spacer's
// text range, and the markdown sheet reads the final mark to drop a paragraph's last margin only
// where the body ends.

/**
 * The attribute a block wrapper carries its index on. Not `data-index`, which marks the
 * transcript's rows: the copy and the row lookups would read a block as a row.
 */
export const MARKDOWN_BLOCK_INDEX_ATTRIBUTE = "data-markdown-block";

/** The attribute the body's last block carries, the one block whose end is the body's end. */
export const MARKDOWN_FINAL_BLOCK_ATTRIBUTE = "data-markdown-final-block";

/** The attribute a windowed table's drawn body row carries its index among the body rows on. */
export const MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE = "data-markdown-table-row";

/**
 * The attributes a windowed table's spacer row carries the text it stands for on: where its first
 * undrawn row starts and its last ends in the body's text, in UTF-16 code units, so a copy reads
 * those rows from the text rather than waiting for them to draw.
 */
export const MARKDOWN_SOURCE_START_ATTRIBUTE = "data-markdown-source-start";
export const MARKDOWN_SOURCE_END_ATTRIBUTE = "data-markdown-source-end";

/**
 * The attribute a windowed table's spacer row carries the table's column count on, so a copy
 * parses the rows it stands for at the table's width: the spacer draws no cell to count.
 */
export const MARKDOWN_COLUMN_COUNT_ATTRIBUTE = "data-markdown-column-count";

/** Every index attribute a window marks its drawn elements with, outermost window first. */
export const WINDOWED_ELEMENT_INDEX_ATTRIBUTES: readonly string[] = [
  MARKDOWN_BLOCK_INDEX_ATTRIBUTE,
  MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE,
];
