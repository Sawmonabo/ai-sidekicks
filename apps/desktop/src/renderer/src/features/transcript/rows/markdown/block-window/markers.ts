// What a windowed body marks its block wrappers and a windowed table its rows and spacers with. The
// windows write them; each window's own measurement and selection pins read its index back, a
// selection end is anchored to the innermost marked element holding it, a copy reads a spacer's
// table and rows, and the markdown sheet reads the final mark to drop a paragraph's last margin
// only where the body ends.

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
 * The attribute a windowed table's spacer row carries its table's key on, under which the feed
 * holds the table it draws, so a copy reads the rows the spacer stands for from the table's parse
 * rather than waiting for them to draw.
 */
export const MARKDOWN_TABLE_KEY_ATTRIBUTE = "data-markdown-table";

/**
 * The attributes a windowed table's spacer row carries the first and last body row it stands for
 * on, counted as `MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE` counts drawn rows.
 */
export const MARKDOWN_FIRST_UNDRAWN_ROW_ATTRIBUTE = "data-markdown-first-undrawn-row";
export const MARKDOWN_LAST_UNDRAWN_ROW_ATTRIBUTE = "data-markdown-last-undrawn-row";

/** Every index attribute a window marks its drawn elements with, outermost window first. */
export const WINDOWED_ELEMENT_INDEX_ATTRIBUTES: readonly string[] = [
  MARKDOWN_BLOCK_INDEX_ATTRIBUTE,
  MARKDOWN_TABLE_ROW_INDEX_ATTRIBUTE,
];
