// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The handle grammar: an edge names each end by one string, `<mode>/<type>/<index>`, so the side, the connection type and the branch index are recoverable from a stored edge alone.

/**
 * The side of a node a handle stands on.
 */
export type WorkflowHandleMode = "inputs" | "outputs";
/**
 * What a handle carries: items on `main`, a capability an agent can call on `tool`.
 */
export type WorkflowHandleType = "main" | "tool";

/**
 * A handle id as read. `isTypeKnown` is false when the stored string named a type other than
 * `main` or `tool`, read as `main`, or could not be read at all, read as `outputs/main/0`.
 */
export interface WorkflowHandle {
  /**
   * The side.
   */
  mode: WorkflowHandleMode;
  /**
   * The connection type.
   */
  type: WorkflowHandleType;
  /**
   * The branch index.
   */
  index: number;
  /**
   * Whether the stored string named a declared type.
   */
  isTypeKnown: boolean;
}
