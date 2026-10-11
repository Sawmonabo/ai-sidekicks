// What an output's window marks its drawn chunks of lines and its spacers with. The window's own
// measurement and selection pins read a chunk's index back, a selection end is anchored to the
// chunk holding it, and a copy reads the chunks a spacer stands for from the output's held chunks.

/** The attribute a drawn chunk of an output's lines carries its index on. */
export const ANSI_LINE_CHUNK_INDEX_ATTRIBUTE = "data-ansi-line-chunk";

/**
 * The attribute an output's spacer carries the output's key on, under which the feed holds the
 * chunks the output draws, so a copy reads the lines the spacer stands for from them.
 */
export const ANSI_OUTPUT_KEY_ATTRIBUTE = "data-ansi-output";

/** The attributes a spacer carries the first and last chunk it stands for on. */
export const ANSI_FIRST_UNDRAWN_CHUNK_ATTRIBUTE = "data-ansi-first-undrawn-chunk";
export const ANSI_LAST_UNDRAWN_CHUNK_ATTRIBUTE = "data-ansi-last-undrawn-chunk";
