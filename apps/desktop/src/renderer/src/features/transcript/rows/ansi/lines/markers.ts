// What an output's window marks its drawn chunks of lines with. The window's own measurement and
// selection pins read a chunk's index back, and a selection end is anchored to the chunk holding
// it. Its spacers carry the marks every text window's do (`drawn-window-sources.ts`).

/** The attribute a drawn chunk of an output's lines carries its index on. */
export const ANSI_LINE_CHUNK_INDEX_ATTRIBUTE = "data-ansi-line-chunk";
