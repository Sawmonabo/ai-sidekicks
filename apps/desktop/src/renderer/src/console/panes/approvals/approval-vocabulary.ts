// The approvals surface's closed sets, declared exactly once.
//
// `Spec-023 §Console Design (Meridian)` §7.6 fixes four of them verbatim — nine
// canonical categories, five approval states, two decisions, and (§7.7) two
// remembered-scope kinds beside four invalidation triggers — and each one is a
// vocabulary the daemon owns rather than one the console may widen.
//
// WHY THEY ARE DECLARED HERE AND NOT IMPORTED FROM `@ai-sidekicks/contracts`.
// They are not registered there. `packages/contracts` carries the seven
// `approval.*` event TYPES and their category, and no approval payload variant, no
// `ApprovalState`, no `ApprovalCategory`, no `RememberedScope`, and no
// `InvalidationTrigger` — the surface's whole wire column reads FIXTURE for that
// reason. So these are renderer-local projection contracts on the same terms
// `store/entities.ts` states for `ConsoleSessionEvent`: the console narrows an
// `unknown` reply at one boundary, and the day the contract package registers the
// real unions this module is deleted rather than reconciled.
//
// EVERY TABLE BELOW IS TOTAL OVER ITS SET BY CONSTRUCTION. A tenth category or a
// sixth state fails to compile here rather than rendering as a nameless token in
// whichever deck first opened the pane. A value the wire sends that this build
// does not know is NOT asserted into a member: the classifiers at the bottom
// answer `undefined`, and the surface renders the wire string verbatim under an
// unrecognized treatment, which is the fail-closed projection rule.

import { type ChipTone } from "../../primitives/index.js";

/** The nine canonical approval categories, verbatim. */
export const APPROVAL_CATEGORIES = [
  "tool_execution",
  "file_write",
  "network_access",
  "destructive_git",
  "user_input",
  "plan_approval",
  "mcp_elicitation",
  "gate",
  "human_phase_contribution",
] as const;

/** One canonical category. Derived from the enumeration, never restated. */
export type ApprovalCategory = (typeof APPROVAL_CATEGORIES)[number];

/** The five-member approval state. */
export const APPROVAL_STATES = ["pending", "approved", "rejected", "expired", "canceled"] as const;

export type ApprovalState = (typeof APPROVAL_STATES)[number];

/**
 * The two-member decision. Two values, no third.
 *
 * There is deliberately no `amend` arm: §7.6's Never list states that
 * `ApprovalResolveRequest` carries nothing that edits the requested action, so an
 * approve-with-amendment control would be a control for a wire that refuses it.
 */
export const APPROVAL_DECISIONS = ["approved", "rejected"] as const;

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** `RememberedScope.kind` — an enum token, never free text (§7.7). */
export const REMEMBERED_SCOPE_KINDS = ["run", "session"] as const;

export type RememberedScopeKind = (typeof REMEMBERED_SCOPE_KINDS)[number];

/** The four invalidation triggers, verbatim (§7.7). */
export const INVALIDATION_TRIGGERS = [
  "explicit",
  "membership_change",
  "node_trust_change",
  "session_end",
] as const;

export type InvalidationTrigger = (typeof INVALIDATION_TRIGGERS)[number];

/**
 * What a category is called on screen.
 *
 * The token itself is still rendered beside the phrase, in mono, because the token
 * is what the daemon sent and rule 4 gives a wire string the mono signature. The
 * phrase exists so a person reads a sentence rather than an identifier; it never
 * replaces the token.
 */
export const CATEGORY_PHRASE: Readonly<Record<ApprovalCategory, string>> = {
  tool_execution: "Run a tool",
  file_write: "Write to a file",
  network_access: "Reach the network",
  destructive_git: "Change git history",
  user_input: "Ask a person",
  plan_approval: "Approve a plan",
  mcp_elicitation: "Answer a server's prompt",
  gate: "Pass a gate",
  human_phase_contribution: "Contribute to a phase",
};

/** What a state is called on screen. Total for `CATEGORY_PHRASE`'s reason. */
export const STATE_PHRASE: Readonly<Record<ApprovalState, string>> = {
  pending: "Waiting on a decision",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
  canceled: "Canceled",
};

/**
 * The chip tone a state wears.
 *
 * `pending` is the only amber one, because amber means a person is needed and
 * nothing else earns it (rule 3). `rejected` is not red: a rejection is the
 * console working correctly, and spending red on it would leave nothing louder for
 * the case where something actually failed.
 */
export const STATE_TONE: Readonly<Record<ApprovalState, ChipTone>> = {
  pending: "attention",
  approved: "accent",
  rejected: "neutral",
  expired: "neutral",
  canceled: "neutral",
};

/** What an invalidation trigger is called on screen, so revocation is never mysterious. */
export const TRIGGER_PHRASE: Readonly<Record<InvalidationTrigger, string>> = {
  explicit: "revoked by a participant",
  membership_change: "revoked because the grantor's membership changed",
  node_trust_change: "revoked because the node's trust changed",
  session_end: "revoked because the session ended",
};

/**
 * What a remembered scope's kind covers, so a reader knows what they are granting.
 *
 * The two sentences are deliberately different lengths: a run-scoped grant dies
 * with the run and a session-scoped one outlives every run in the session, and the
 * control that offers them is the one place that difference has to be legible.
 */
export const SCOPE_KIND_PHRASE: Readonly<Record<RememberedScopeKind, string>> = {
  run: "This run only",
  session: "This whole session",
};

/**
 * Whether a wire string is an OWN key of one of the tables above.
 *
 * `Object.hasOwn` and not a truthiness read of the property: an object literal
 * inherits `toString`, `constructor`, and the rest of `Object.prototype`, so a bare
 * lookup answers a function for those names and classifies them as members. That is
 * a silent widening of a closed set by whatever string the wire happens to send,
 * which is the one thing these classifiers exist to prevent.
 */
function isOwnKey(table: Readonly<Record<string, unknown>>, value: string): boolean {
  return Object.hasOwn(table, value);
}

/**
 * Classify a wire-verbatim category, or `undefined` when this build does not know it.
 *
 * The table above stays total over the union by ASSIGNMENT rather than by a cast,
 * so a tenth member is a compile error there while an unknown string answers
 * `undefined` here instead of being asserted into a member it does not belong to.
 */
export function asApprovalCategory(value: string): ApprovalCategory | undefined {
  return isOwnKey(CATEGORY_PHRASE, value) ? (value as ApprovalCategory) : undefined;
}

/** Classify a wire-verbatim state. Fail-closed, for `asApprovalCategory`'s reason. */
export function asApprovalState(value: string): ApprovalState | undefined {
  return isOwnKey(STATE_PHRASE, value) ? (value as ApprovalState) : undefined;
}

/** Classify a wire-verbatim invalidation trigger. Fail-closed, same reason. */
export function asInvalidationTrigger(value: string): InvalidationTrigger | undefined {
  return isOwnKey(TRIGGER_PHRASE, value) ? (value as InvalidationTrigger) : undefined;
}

/** Classify a wire-verbatim remembered-scope kind. Fail-closed, same reason. */
export function asRememberedScopeKind(value: string): RememberedScopeKind | undefined {
  return isOwnKey(SCOPE_KIND_PHRASE, value) ? (value as RememberedScopeKind) : undefined;
}
