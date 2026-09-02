// The console's declaration of the attention plane's projection shape.
//
// OWNER. `Spec-019 §Interfaces And Contracts` owns this wire: "`AttentionProjectionRead`
// must expose current actionable and informational attention state at both run and
// session scope." The typed request and reply shapes are registered in
// `docs/architecture/contracts/api-payload-contracts.md` §Plan-019, and the six
// triggers and two severities below are transcribed from the `AttentionItem` union
// there rather than re-derived from the spec's prose — that union is what
// `packages/contracts/src/attention/` will carry.
//
// WHY THE CONSOLE DECLARES IT AT ALL. It is registered in no code package: there is
// no `packages/contracts/src/attention/`, no `AttentionItem` export, and no
// `SidekicksBridge` namespace that names one. A surface built against a shape that
// exists nowhere would have to invent it inside a view family, which is exactly what
// the growth slate exists to prevent — so the shape is declared here, on the
// substrate, behind the `attention-plane` slate row, and every call to it goes
// through the growth port.
//
// DELETION OBLIGATION. When `packages/contracts` registers these types, this module
// is DELETED and `growth-port.ts` imports `AttentionItem` from the contracts package
// instead. The slate row leaves `growth-slate.ts` and `Plan-023 §Console growth
// slate` in the same PR, and `failure-modes.test.ts` then fails on the port entries
// that still claim fixture-only — which is the reminder this file wants at that
// moment.
//
// HOW IT IS REACHED. Through `growth-port.ts`, which types
// `attentionProjectionRead`'s value as `AttentionProjection` — so a surface that
// narrows a served outcome already has the items and their members. This family's
// barrel deliberately re-exports nothing from here yet: a barrel line with no
// importer is a symbol minted ahead of its reader, and the dead-code gate reports it
// as exactly that. The line lands in the same PR as the first surface that names
// `AttentionItem` in its own props, which is the PR that proves it has a reader.
//
// WHAT IS DELIBERATELY NOT HERE. The notification preference pair's request and reply
// shapes: they are the OTHER half of the same slate row and are stated inline in
// `growth-port.ts`'s signature table beside every other operation's, because nothing
// projects or renders a preference yet and a named type nobody imports would be a
// declaration minted ahead of its reader. They come here the day a surface reads one.

/**
 * Every attention trigger, transcribed from the registered `AttentionItem` union.
 *
 * `Spec-019 §Required Behavior` states the minimum set — pending approval or
 * participant input, run completion, run failure, invite receipt, mention or direct
 * request — and the registered union fixes their spellings. Closed and declared
 * once: a seventh trigger is an amendment to the owning document, never a string a
 * console module invents.
 */
export const ATTENTION_TRIGGERS = [
  "pending_approval",
  "pending_input",
  "run_completed",
  "run_failed",
  "invite_received",
  "mention",
] as const;

/** One attention trigger. Derived, so the vocabulary has exactly one home. */
export type AttentionTrigger = (typeof ATTENTION_TRIGGERS)[number];

/**
 * The two severities, and the distinction the product turns on.
 *
 * `Spec-019 §Required Behavior`: "Users must be able to distinguish passive
 * informational notifications from actionable blocking attention." A console that
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
 * `Spec-019 §Required Behavior` requires alongside run scope (Plan-019 D-019-2, in
 * `api-payload-contracts.md` §Plan-019). A console surface therefore reads scope off
 * the presence of `runId` and never off a field that says which kind this is.
 *
 * The identifiers are plain strings rather than the branded `SessionId` / `RunId`
 * the registered shape uses, matching every other console-side growth value: the
 * brands live in the contracts package this module exists because of, and a console
 * declaration that imported them would be half-registered.
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
   * Optional because an unresolved item is the interesting one, and
   * `Spec-019 §State And Data Implications` keeps actionable attention durable
   * "until resolved" — so absence means outstanding, not unknown.
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
