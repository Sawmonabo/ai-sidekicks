// The attention projection's shape: the reply of the attention read, with the trigger
// and severity vocabularies its items carry.
//
// The attention plane owns this wire: the projection exposes current actionable and
// informational attention state at both run and session scope. No contracts package
// registers the shape yet, so it is declared here rather than invented inside a
// surface; the five triggers and two severities are transcribed from the
// `AttentionItem` union the plane defines. The daemon and main read the same shape,
// so it belongs in the contracts package, not the renderer.
//
// The notification preference pair's request and reply shapes are not here: nothing
// projects or renders a preference yet.

/**
 * Every attention trigger, transcribed from the registered `AttentionItem` union.
 *
 * The attention plane states the minimum set — pending approval or user input, run
 * completion, run failure, mention or direct request — and the registered union fixes
 * their spellings. Closed and declared once: a sixth trigger is an amendment to the
 * owning document, never a string a console module invents.
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
 * from actionable blocking attention. A console that
 * rendered one badge for both would be shipping against a wire whose whole point is
 * that they are different.
 */
export const ATTENTION_SEVERITIES = ["actionable", "informational"] as const;

/** One attention severity. Derived, so the vocabulary has exactly one home. */
export type AttentionSeverity = (typeof ATTENTION_SEVERITIES)[number];

/**
 * One attention item — run-scoped, or the session-scoped aggregate.
 *
 * `runId` is the scope discriminator and there is no second type: an item carrying
 * one is run-scoped, an item omitting one is the session aggregate that
 * the read requires alongside run scope. A console surface therefore reads scope off
 * the presence of `runId` and never off a field that says which kind this is.
 *
 * The identifiers are plain strings rather than the branded `SessionId` / `RunId`
 * the registered shape will use: the brands live in the contracts package, and a
 * declaration here that imported them would be half-registered.
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
 * A wrapper object rather than a bare array, matching the registered
 * `AttentionProjectionReadResponse`: a reply that can grow a sibling member without
 * breaking every caller is the shape the wire will send, and a console trained
 * against a bare array would have to be retrained on the day it does.
 */
export interface AttentionProjection {
  readonly items: readonly AttentionItem[];
}
