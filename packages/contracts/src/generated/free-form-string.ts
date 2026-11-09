// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The longest path a wire string may carry.

/**
 * The longest filesystem path any wire string carries, in code points. 4096 is Linux's
 * `PATH_MAX`, above macOS's 1024 and Windows' 260-character default; a longer Windows
 * extended-length path is refused.
 */
export const FILE_PATH_MAX_LEN = 4096 as const;
