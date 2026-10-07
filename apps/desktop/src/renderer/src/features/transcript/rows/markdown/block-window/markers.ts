// What a windowed body marks its block wrappers with. The window writes them, the window's own
// measurement and the selection pin read the index back, and the markdown sheet reads the final
// mark to drop a paragraph's last margin only where the body ends.

/**
 * The attribute a block wrapper carries its index on. Not `data-index`, which marks the
 * transcript's rows: the copy and the row lookups would read a block as a row.
 */
export const MARKDOWN_BLOCK_INDEX_ATTRIBUTE = "data-markdown-block";

/** The attribute the body's last block carries, the one block whose end is the body's end. */
export const MARKDOWN_FINAL_BLOCK_ATTRIBUTE = "data-markdown-final-block";
