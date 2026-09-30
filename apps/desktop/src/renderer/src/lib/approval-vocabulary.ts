// What the approval card and the inspector's Rules section call each approval value on
// screen.
//
// The closed sets themselves are the contract's (`@ai-sidekicks/contracts`); each table
// here is keyed by the contract's type, so a value the contract adds fails to compile
// until it has words.

import type {
  ApprovalCategory,
  ApprovalState,
  RememberedRuleSense,
  RememberedScopeKind,
} from "@ai-sidekicks/contracts";

/**
 * What a category is called on screen.
 *
 * The token itself is still rendered beside the phrase, in mono, because the token is
 * what the daemon sent and a wire string always renders in mono. The phrase exists so a
 * person reads a sentence rather than an identifier; it never replaces the token.
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

/** What a state is called on screen. */
export const APPROVAL_STATE_LABELS: Readonly<Record<ApprovalState, string>> = {
  pending: "Waiting on a decision",
  approved: "Approved",
  rejected: "Rejected",
  canceled: "Canceled",
};

/** A remembered rule's reach, in the words its label and its Rules row use. */
export const RULE_SCOPE_LABELS: Readonly<Record<RememberedScopeKind, string>> = {
  session: "this session",
  project: "this project",
};

/** What a remembered rule does to its subject, as its Rules row reads. */
export const RULE_SENSE_LABELS: Readonly<Record<RememberedRuleSense, string>> = {
  allow: "Allow",
  block: "Block",
};
