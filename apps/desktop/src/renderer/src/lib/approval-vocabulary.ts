// The approvals surface's closed sets, declared exactly once.
//
// All six — seven canonical categories, five approval states, two decisions, two
// remembered-scope kinds, and four invalidation triggers — are vocabularies the
// daemon owns rather than ones the console may widen. The approvals payload
// contracts are where they are written, and the approvals view names the scope kinds
// on the surface itself, as a `RememberedScope { kind: 'run' | 'session' }` grant
// with category-derived pattern semantics.
//
// WHY THEY ARE DECLARED HERE AND NOT IMPORTED FROM `@ai-sidekicks/contracts`.
// They are not registered there. `packages/contracts` carries the seven
// `approval.*` event TYPES and their category, and no approval payload variant, no
// `ApprovalState`, no `ApprovalCategory`, no `RememberedScope`, and no
// `InvalidationTrigger` — the surface's whole wire column reads FIXTURE for that
// reason. So these are renderer-local projection contracts on the same terms
// `store/entities/entities.ts` states for `ProjectedSessionEvent`: the console narrows an
// `unknown` reply at one boundary, and the day the contract package registers the
// real unions this module is deleted rather than reconciled.
//
// EVERY TABLE BELOW IS TOTAL OVER ITS SET BY CONSTRUCTION. A tenth category or a
// sixth state fails to compile here rather than rendering as a nameless token in
// whichever deck first opened the pane. A value the wire sends that this build
// does not know is NOT asserted into a member: the classifiers at the bottom
// answer `undefined`, and the surface renders the wire string verbatim under an
// unrecognized treatment, which is the fail-closed projection rule.
/** The seven canonical approval categories, verbatim. */
export const APPROVAL_CATEGORIES = [
  "tool_execution",
  "file_write",
  "network_access",
  "destructive_git",
  "plan_approval",
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
 * There is deliberately no `amend` arm: the registered `ApprovalResolveRequest`
 * carries nothing that edits the requested action and the Approvals View sketch
 * offers approve / deny / remember and no fourth, so an approve-with-amendment
 * control would be a control for a wire that has no member for it.
 */
export const APPROVAL_DECISIONS = ["approved", "rejected"] as const;

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** `RememberedScope.kind` — an enum token, never free text: the wire declares an
 * explicit enum rather than a free-form string. */
export const REMEMBERED_SCOPE_KINDS = ["run", "session"] as const;

export type RememberedScopeKind = (typeof REMEMBERED_SCOPE_KINDS)[number];

/** The four invalidation triggers, verbatim from that block's `InvalidationTrigger`. */
export const INVALIDATION_TRIGGERS = [
  "explicit",
  "session_end",
  "project_detached",
  "server_trust_withdrawn",
] as const;

/**
 * One invalidation trigger. Derived from the enumeration, never restated.
 *
 * @consumedBy the remembered-rule invalidation reading
 */
export type InvalidationTrigger = (typeof INVALIDATION_TRIGGERS)[number];

/**
 * What a category is called on screen.
 *
 * The token itself is still rendered beside the phrase, in mono, because the token
 * is what the daemon sent and rule 4 gives a wire string the mono signature. The
 * phrase exists so a person reads a sentence rather than an identifier; it never
 * replaces the token.
 */
export const APPROVAL_CATEGORY_LABELS: Readonly<Record<ApprovalCategory, string>> = {
  tool_execution: "Run a tool",
  file_write: "Write to a file",
  network_access: "Reach the network",
  destructive_git: "Change git history",
  plan_approval: "Approve a plan",
  gate: "Pass a gate",
  human_phase_contribution: "Contribute to a phase",
};

/** What a state is called on screen. Total for `APPROVAL_CATEGORY_LABELS`'s reason. */
export const APPROVAL_STATE_LABELS: Readonly<Record<ApprovalState, string>> = {
  pending: "Waiting on a decision",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
  canceled: "Canceled",
};

/**
 * What a remembered scope's kind covers, so a reader knows what they are granting.
 *
 * The two sentences are deliberately different lengths: a run-scoped grant dies
 * with the run and a session-scoped one outlives every run in the session, and the
 * control that offers them is the one place that difference has to be legible.
 */
export const RULE_SCOPE_LABELS: Readonly<Record<RememberedScopeKind, string>> = {
  run: "This run only",
  session: "This whole session",
};

/**
 * Classify a wire-verbatim category, or `undefined` when this build does not know it.
 *
 * The table above stays total over the union by ASSIGNMENT rather than by a cast,
 * so a tenth member is a compile error there while an unknown string answers
 * `undefined` here instead of being asserted into a member it does not belong to.
 */
export function asApprovalCategory(value: string): ApprovalCategory | undefined {
  return isOwnKey(APPROVAL_CATEGORY_LABELS, value) ? (value as ApprovalCategory) : undefined;
}

/** Classify a wire-verbatim state. Fail-closed, for `asApprovalCategory`'s reason. */
export function asApprovalState(value: string): ApprovalState | undefined {
  return isOwnKey(APPROVAL_STATE_LABELS, value) ? (value as ApprovalState) : undefined;
}

/** Classify a wire-verbatim remembered-scope kind. Fail-closed, same reason. */
export function asRememberedScopeKind(value: string): RememberedScopeKind | undefined {
  return isOwnKey(RULE_SCOPE_LABELS, value) ? (value as RememberedScopeKind) : undefined;
}

/**
 * A remembered scope kind's phrase, or the wire string itself where this build does
 * not know the kind — the fail-closed projection, never a guess at which boundary
 * was meant.
 *
 * Here rather than beside either caller: the standing-permissions list renders a
 * granted rule's boundary and the approval card renders the boundary a resolution
 * minted, and two copies of one fail-closed rule drift the moment one of them gains
 * a third kind.
 */
export function describeRuleScope(kind: string): string {
  const known = asRememberedScopeKind(kind);
  return known === undefined ? kind : RULE_SCOPE_LABELS[known];
}

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
