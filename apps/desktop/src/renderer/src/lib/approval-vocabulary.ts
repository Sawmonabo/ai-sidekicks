// What the approval card and the inspector's Rules section call each approval value on screen.
// Each table is keyed by the contract's type, so a value the contract adds does not compile
// until it has words.

import type {
  ApprovalCategory,
  ApprovalState,
  RememberedRuleSense,
  RememberedScopeKind,
} from "@ai-sidekicks/contracts/approval";

/** The palette category the approval rows and the rule revocations sit under. */
export const APPROVAL_COMMAND_GROUP = "Approvals";

/** What a category is called on screen, in words; the wire token is rendered beside it, in mono. */
export const APPROVAL_CATEGORY_LABELS: Readonly<Record<ApprovalCategory, string>> = {
  tool_execution: "Run a tool",
  file_write: "Write to a file",
  network_access: "Reach the network",
  destructive_git: "Change git history",
  plan_approval: "Approve a plan",
  gate: "Pass a gate",
};

/** What a state is called on screen. */
export const APPROVAL_STATE_LABELS: Readonly<Record<ApprovalState, string>> = {
  pending: "Waiting on a decision",
  approved: "Approved",
  rejected: "Rejected",
  canceled: "Canceled",
};

/** A remembered rule's reach, in the words the card's answers and its Rules row use. */
export const RULE_SCOPE_LABELS: Readonly<Record<RememberedScopeKind, string>> = {
  session: "this session",
  project: "this project",
};

/** What a remembered rule does to its subject, as its Rules row reads. */
export const RULE_SENSE_LABELS: Readonly<Record<RememberedRuleSense, string>> = {
  allow: "Allow",
  block: "Block",
};
