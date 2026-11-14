// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The RFC 9562 UUID text form every UUID id accepts, for a member whose brand another contract declares.

/**
 * A UUID in the RFC 9562 text form, either case, the Nil and Max UUIDs among them.
 */
export type UuidTextForm = string;

export { validateUuidTextForm } from "../checks/internal/branded.js";
