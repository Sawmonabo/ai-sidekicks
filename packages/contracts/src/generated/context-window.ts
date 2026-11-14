// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Where the window size on a `usage.contextWindow.updated` row came from.

/** Every [`ContextWindowSource`]. */
export const CONTEXT_WINDOW_SOURCES = ["providerReported", "modelDefault"] as const;

/**
 * Where a context window's figures came from: the provider reported them, or the window is the
 * model's declared default.
 */
export type ContextWindowSource = "providerReported" | "modelDefault";

export { validateContextWindowSource } from "./checks/context-window.js";
