// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The id of one run, which every run, session, approval, question, plan and workflow contract carries.

/**
 * Identifies one run. Only a UUID is accepted, so a path or an SQL fragment never reaches a
 * store lookup.
 */
export type RunId = string & { readonly __brand: "RunId" };

export { validateRunId } from "../checks/run/id.js";
