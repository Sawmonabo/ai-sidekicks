// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The one tag rule every tagged record follows: what a tag may hold, and how a list of tags holds each tag once.

/**
 * A tag, nested with /: no whitespace, never empty, and no empty level around a /.
 */
export type Tag = string;
/**
 * Tags, each nested with / and held once ignoring case; no whitespace or empty level.
 */
export type TagList = Tag[];
