// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The id of one artifact manifest, the element type of every attachment list.

/**
 * Identifies an artifact manifest; the element type of every attachment list. It names the
 * manifest, never its content, which carries a separate SHA-256 `digest`.
 */
export type ArtifactId = string & { readonly __brand: "ArtifactId" };

export { validateArtifactId } from "../checks/artifacts/id.js";
