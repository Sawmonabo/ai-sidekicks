// The attention projection's shape: the reply of the attention read, with the trigger
// and severity vocabularies its items carry.
//
// The projection exposes current actionable and informational attention state at both run
// and session scope. The daemon, main and the renderer all read it.

/**
 * Every attention trigger: pending approval or user input, run completion, run failure,
 * mention or direct request. Closed and declared once: a sixth trigger is an amendment to
 * the owning document, never a string a client invents.
 */
export const ATTENTION_TRIGGERS = [
  "pending_approval",
  "pending_input",
  "run_completed",
  "run_failed",
  "mention",
] as const;

/** One attention trigger. Derived, so the vocabulary has exactly one home. */
export type AttentionTrigger = (typeof ATTENTION_TRIGGERS)[number];

/**
 * The two severities, and the distinction the product turns on.
 *
 * A person has to be able to distinguish passive informational notifications
 * from actionable blocking attention. A client that rendered
 * one badge for both would be shipping against a wire whose whole point is that they are
 * different.
 */
export const ATTENTION_SEVERITIES = ["actionable", "informational"] as const;

/** One attention severity. Derived, so the vocabulary has exactly one home. */
export type AttentionSeverity = (typeof ATTENTION_SEVERITIES)[number];

/**
 * One attention item — run-scoped, or the session-scoped aggregate.
 *
 * `runId` is the scope discriminator and there is no second type: an item carrying
 * one is run-scoped, an item omitting one is the session aggregate that
 * the read requires alongside run scope. A client therefore reads scope off
 * the presence of `runId` and never off a field that says which kind this is.
 */
export interface AttentionItem {
  readonly id: string;
  readonly sessionId: string;
  /** Present on a run-scoped item; absent on the session-scoped aggregate. */
  readonly runId?: string;
  readonly trigger: AttentionTrigger;
  readonly severity: AttentionSeverity;
  /** One line a surface renders. Prose, not an identifier. */
  readonly summary: string;
  /** The canonical event that triggered this item. */
  readonly sourceEventId: string;
  readonly createdAt: string;
  /**
   * Set once the state that produced the item resolves.
   *
   * Optional because an unresolved item is the interesting one, and actionable
   * attention stays durable until it resolves — so absence means outstanding, not
   * unknown.
   */
  readonly resolvedAt?: string;
}

/**
 * What one attention-projection read answers with.
 *
 * A wrapper object rather than a bare array: a reply that can grow a sibling member
 * without breaking every caller.
 */
export interface AttentionProjection {
  readonly items: readonly AttentionItem[];
}
