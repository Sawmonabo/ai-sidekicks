// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The operating systems and processor architectures a build runs on, in Node's spelling.

/** The operating systems a build runs on. */
export const SUPPORTED_PLATFORMS = ["darwin", "linux", "win32"] as const;

/**
 * An operating system a build runs on, in Node's spelling.
 */
export type SupportedPlatform = "darwin" | "linux" | "win32";
/**
 * A processor architecture a build runs on, in Node's spelling.
 */
export type Arch = "x64" | "arm64";
