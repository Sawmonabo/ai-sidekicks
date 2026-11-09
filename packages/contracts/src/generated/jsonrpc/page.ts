// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The byte budget every paged reply shares: each page is measured in bytes against a budget well inside the message cap.

/**
 * The byte ceiling on a reply's one large member, measured as its JSON's UTF-8 length: a
 * page's entries, hits, sessions or groups, or a read's stored body or files. It is a
 * 1,000,000-byte reply less 8,192 bytes for the message, the echoed id and a continuation
 * cursor.
 */
export const PAGE_MAX_BYTES = 991808 as const;
