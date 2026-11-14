// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The id of one workflow run, which every run method, event and step record carries.

/**
 * Identifies one workflow run: a UUID the daemon mints; a client never builds one.
 */
export type WorkflowRunId = string & { readonly __brand: "WorkflowRunId" };

export { validateWorkflowRunId } from "../../checks/workflow/run/id.js";
