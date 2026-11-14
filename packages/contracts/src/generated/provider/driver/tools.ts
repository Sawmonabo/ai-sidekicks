// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The tools a driver declares and the daemon offers: each tool's metadata and idempotency class, and the callback tools the daemon serves the model.

/** Every idempotency class, safest to repeat first. */
export const IDEMPOTENCY_CLASSES = ["idempotent", "compensable", "manualReconcileOnly"] as const;

/**
 * A tool's declared idempotency: safe to repeat, undoable, or needing a person to reconcile. A
 * daemon restart runs no call again, whatever its class.
 */
export type IdempotencyClass = "idempotent" | "compensable" | "manualReconcileOnly";

/**
 * A tool a driver declares. An undeclared class reads as `manualReconcileOnly`, and unknown
 * members are dropped rather than refused, because providers extend the declaration.
 */
export interface ProviderToolMetadata {
  /**
   * The tool's name.
   */
  name: string;
  /**
   * The tool's idempotency.
   */
  idempotency_class?: IdempotencyClass;
  /**
   * The tool's description.
   */
  description?: string;
}
/**
 * A tool the daemon offers the model: a name, a description and a JSON Schema input. Every call
 * goes through the daemon's approval pipeline and lands as an ordinary tool activity row.
 */
export interface SessionCallbackTool {
  /**
   * The tool's name.
   */
  name: string;
  /**
   * What the tool does, for the model.
   */
  description: string;
  /**
   * The tool's input as a JSON Schema.
   */
  inputSchema: {
    [k: string]: unknown | undefined;
  };
}

export {
  validateIdempotencyClass,
  validateProviderToolMetadata,
} from "../../checks/provider/driver/tools.js";
