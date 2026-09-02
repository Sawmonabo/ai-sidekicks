// What a change proposal IS on the way to a git host, read as something the gate can
// draw — and nothing else. No React, no calls, no eligibility.
//
// `Spec-023 §Console Design (Meridian)` §10.7's job for this surface: "Show exactly
// what will be sent to the git host, and let a participant approve it before anything
// leaves the machine." Four of those words are decisions, and each is made here once
// so the gate never makes it twice: what the branch context ASSOCIATES with, what the
// three status trichotomies MEAN, how a check list ROLLS UP, and how an untyped
// proposal blob is turned into rows that are display data rather than instructions.
//
// EVERY SHAPE BELOW IS THE CONSOLE'S OWN, AND SAYS SO. `packages/contracts` registers
// no `gitflow` module: there is no `baseBranch`, no `headBranch`, no `upstreamRef`, no
// `ChangeRequest`, and no proposal type anywhere in the workspace — only
// `BranchContextId`, a branded scalar `worktree.ts` mints and `ExecutionRootPrepareResponse`
// carries. So these are the shapes the SURFACE needs, derived from what §10.7 says it
// renders, exactly as `bridge/growth-port.ts` derives its request and value types: they
// are not a claim about the eventual wire, which `Spec-011` owns. The one vocabulary
// imported rather than invented is `ExecutionMode`, because the mode is what decides
// whether a writable context exists at all and the contract already closes it at four.
//
// THE THREE TRICHOTOMIES ARE NORMALIZED HERE AND NOWHERE ELSE. §10.7 fixes their
// members, and two of them carry a reading a host-shaped string would lose:
// `mergeable: "unknown"` means the host is still computing and NEVER an error, and an
// absent `reviewDecision` means no decision yet rather than a rejection. Both facts are
// in the tables below, so a renderer cannot restate either one differently.
//
// NEVER, from the same section, and each is a property of THIS file:
//   • No base or head inferred from a pane, a tab, or a focused view. Both are fields
//     on the context, and nothing here computes either.
//   • No fourth action. `PROPOSAL_ACTIONS` is closed at the three `Spec-011 §Required
//     Behavior` names, so an action the console could send is an edit to that tuple.
//   • No parse of a git action's `output`. There is no function here that reads it; it
//     is diagnostic text the gate renders and the console never scrapes.
//   • No stacked proposals, and no second host adapter. One cumulative proposal per run
//     lineage is what `oneCumulativeProposalCopy` says out loud, and the detected host
//     arrives as a wire string this file never picks.

import type { ExecutionMode } from "@ai-sidekicks/contracts";

import type { ChipTone } from "../primitives/index.js";

// --- The branch context -----------------------------------------------------

/**
 * The four named values §10.7 requires, plus the association that makes them
 * actionable.
 *
 * `branchContextId` is spelled as a plain string rather than as the contract's
 * `BranchContextId` brand for the reason `repo-reads.ts` records about `SessionId`:
 * the console never MINTS one, it forwards the opaque value it was handed, and a
 * brand on a display shape would claim this file validated something it did not.
 */
export interface BranchContextReading {
  readonly branchContextId: string;
  /** Where the change lands. Wire-verbatim; never inferred from the selected pane. */
  readonly baseBranch: string;
  /** What is proposed. Wire-verbatim; never inferred from the selected pane. */
  readonly headBranch: string;
  /** The tracking ref, where one is set. Absence means no upstream, not an unread field. */
  readonly upstreamRef?: string | undefined;
  /** The workspace's selected mode, which decides which association below is lawful. */
  readonly executionMode: ExecutionMode;
  readonly worktreeId?: string | undefined;
  readonly ephemeralCloneId?: string | undefined;
}

/**
 * What a branch context is bound to. Closed at three, and the third is the one that
 * is easy to render wrong: `branch` mode carries NEITHER id, and drawing an empty
 * association slot beside it would read as a missing value rather than as the mode's
 * own answer.
 */
export const BRANCH_CONTEXT_ASSOCIATIONS = ["worktree", "ephemeral-clone", "in-place"] as const;

/** One association. Derived, so the vocabulary is declared exactly once. */
export type BranchContextAssociation = (typeof BRANCH_CONTEXT_ASSOCIATIONS)[number];

/**
 * One association, ready to draw: which kind, the id where the kind has one, and the
 * sentence that says what the binding means.
 */
export interface BranchContextAssociationReading {
  readonly association: BranchContextAssociation;
  readonly label: string;
  /** The bound id, wire-verbatim. Absent on `in-place`, which binds no separate root. */
  readonly boundId?: string | undefined;
  readonly meaning: string;
}

/**
 * Read a context's association off the mode and the two ids.
 *
 * MODE FIRST, ids second. The ids are plain-optional on the wire because which set is
 * lawful depends on the selected mode and no schema can see it, so reading the ids
 * first would let a stale `worktreeId` on a re-selected `branch`-mode context decide
 * the answer. Reading the mode first makes the mode the answer and the id the detail.
 */
export function branchContextAssociationReading(
  context: BranchContextReading,
): BranchContextAssociationReading {
  if (context.executionMode === "worktree") {
    return {
      association: "worktree",
      label: "Worktree",
      boundId: context.worktreeId,
      meaning: "This context executes in a dedicated checkout on this node.",
    };
  }
  if (context.executionMode === "ephemeral clone") {
    return {
      association: "ephemeral-clone",
      label: "Ephemeral clone",
      boundId: context.ephemeralCloneId,
      meaning: "This context executes in a clone the daemon disposes of on its own schedule.",
    };
  }
  return {
    association: "in-place",
    label: "In place",
    meaning: "This context executes in the mount's own checkout and binds no separate root.",
  };
}

/**
 * Why a workspace has no writable branch context, per mode.
 *
 * Only `read-only` appears, and its absence for the other three is the point:
 * `Spec-011 §Required Behavior` puts a branch context on every writable run in
 * `branch`, `worktree`, or `ephemeral clone` mode, so a writable mode with no context
 * is a read that has not happened rather than a mode that produces none. A table over
 * all four would have had to invent three sentences that are never true.
 */
export const NO_BRANCH_CONTEXT_REASON: Readonly<Partial<Record<ExecutionMode, string>>> = {
  "read-only":
    "This workspace is read-only, so it produces no writable branch context and no preparation side effects. Selecting a writable execution mode on the workspace is what changes that.",
};

/** What the gate says when a writable mode carries no context yet. */
export const BRANCH_CONTEXT_UNREAD_REASON =
  "This workspace's execution mode is writable, so it has a branch context. None has been read for it yet, so nothing here is reporting that it has none.";

// --- The prepared proposal --------------------------------------------------

/** Whether the host would publish this proposal or hold it. The wire's own two words. */
export const PROPOSAL_STATES = ["draft", "ready"] as const;

/** One proposal state. Derived, so the vocabulary is declared exactly once. */
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/**
 * What a prepared proposal puts on screen, before any remote mutation.
 *
 * `blob` is deliberately untyped and deliberately last. §10.7's leverage note is that
 * the proposal is rendered from an untyped `proposalBlob`, "so the renderer treats
 * unknown keys as inert display data and never as instructions" — `proposalBlobRows`
 * below is the only reader of it, and it produces strings.
 */
export interface PreparedProposal {
  readonly title: string;
  readonly body: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly state: ProposalState;
  /** The attribution lines the proposal will carry, verbatim and in order. */
  readonly trailers: readonly string[];
  /** The paths this proposal publishes. Named so the gate can offer the diff half. */
  readonly changedPaths: readonly string[];
  readonly blob?: Readonly<Record<string, unknown>> | undefined;
}

/** One inert row read out of the untyped proposal blob. Both halves are display text. */
export interface ProposalBlobRow {
  readonly key: string;
  readonly text: string;
}

/**
 * Turn the untyped blob into rows.
 *
 * THREE PROPERTIES, AND EACH IS THE RULE RATHER THAN A CONVENIENCE:
 *   1. Every value becomes a STRING here. A caller therefore cannot branch on a
 *      blob's shape, which is what "never as instructions" means structurally — a
 *      key named `action`, `onClick`, or `__html` reaches the screen as the text of
 *      its value and as nothing else.
 *   2. Keys are sorted, so two reads of one proposal draw the same rows. Object key
 *      order is the producer's, and a gate whose rows reshuffle between reads reads
 *      as a proposal that changed.
 *   3. A value that will not stringify becomes the stated fallback rather than
 *      throwing inside a list row. `JSON.stringify` returns `undefined` for a
 *      function or a `symbol` and throws on a cycle; both land on the same sentence.
 */
export function proposalBlobRows(
  blob: Readonly<Record<string, unknown>> | undefined,
): readonly ProposalBlobRow[] {
  if (blob === undefined) {
    return [];
  }
  return Object.keys(blob)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => ({ key, text: proposalBlobValueText(blob[key]) }));
}

/** What a blob value that cannot be rendered as text says instead. */
export const PROPOSAL_BLOB_UNRENDERABLE = "(a value the console cannot render as text)";

function proposalBlobValueText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? PROPOSAL_BLOB_UNRENDERABLE;
  } catch {
    return PROPOSAL_BLOB_UNRENDERABLE;
  }
}

/**
 * The one sentence §10.7 asks to be said plainly, kept out of the component so the
 * claim and the surface that makes it can be held against each other by a test.
 */
export const ONE_CUMULATIVE_PROPOSAL_COPY =
  "One proposal covers this run lineage. Further commits in this worktree update it rather than opening another.";

// --- The three status trichotomies ------------------------------------------

/** Where the proposal stands on the host. */
export const CHANGE_REQUEST_STATES = ["open", "merged", "closed"] as const;

/** One change-request state. Derived, so the vocabulary is declared exactly once. */
export type ChangeRequestState = (typeof CHANGE_REQUEST_STATES)[number];

/** Whether the host can merge it. `unknown` is a THIRD reading and never an error. */
export const MERGEABILITY_READINGS = ["mergeable", "conflicting", "unknown"] as const;

/** One mergeability reading. Derived, so the vocabulary is declared exactly once. */
export type MergeabilityReading = (typeof MERGEABILITY_READINGS)[number];

/** One check's outcome. */
export const CHECK_STATUSES = ["pending", "success", "failure"] as const;

/** One check status. Derived, so the vocabulary is declared exactly once. */
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** A human's verdict, where one has been given. Absence is "no decision yet". */
export const REVIEW_DECISIONS = ["approved", "changes-requested", "commented"] as const;

/** One review decision. Derived, so the vocabulary is declared exactly once. */
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** What a status value means and how loudly it reads. The name itself is the wire's. */
export interface StatusPresentation {
  /** Amber means a person is needed, red means something failed, everything else neutral. */
  readonly tone: ChipTone;
  /** One sentence saying what this value means. Never the value name reworded. */
  readonly meaning: string;
}

/** Total over `ChangeRequestState` by construction. */
export const CHANGE_REQUEST_STATE_PRESENTATION: Readonly<
  Record<ChangeRequestState, StatusPresentation>
> = {
  open: { tone: "neutral", meaning: "The proposal is open on the host." },
  merged: { tone: "neutral", meaning: "The proposal has been merged." },
  closed: {
    tone: "attention",
    meaning: "The proposal was closed without merging. Nothing from it reached the base branch.",
  },
};

/**
 * Total over `MergeabilityReading` by construction.
 *
 * `unknown` is NEUTRAL and its sentence says the host is still working. Toning it as a
 * failure, or wording it as "could not determine", would report a computation in
 * progress as a problem — the one reading §10.7 names explicitly.
 */
export const MERGEABILITY_PRESENTATION: Readonly<Record<MergeabilityReading, StatusPresentation>> =
  {
    mergeable: {
      tone: "neutral",
      meaning: "The host reports no conflict against the base branch.",
    },
    conflicting: {
      tone: "attention",
      meaning:
        "The host reports a conflict against the base branch. Resolving it is a person's act.",
    },
    unknown: {
      tone: "neutral",
      meaning: "The host is still computing mergeability. This is not an error and not a conflict.",
    },
  };

/** Total over `CheckStatus` by construction. */
export const CHECK_STATUS_PRESENTATION: Readonly<Record<CheckStatus, StatusPresentation>> = {
  pending: { tone: "neutral", meaning: "Still running." },
  success: { tone: "neutral", meaning: "Passed." },
  failure: { tone: "failure", meaning: "Failed." },
};

/**
 * Total over `ReviewDecision` by construction.
 *
 * There is no member for "nobody decided" — that is the absence of a decision and it
 * renders as an absence, not as a fourth value. Adding one here would let the console
 * assert a verdict the host never gave.
 */
export const REVIEW_DECISION_PRESENTATION: Readonly<Record<ReviewDecision, StatusPresentation>> = {
  approved: { tone: "neutral", meaning: "A reviewer approved this proposal." },
  "changes-requested": {
    tone: "attention",
    meaning: "A reviewer asked for changes.",
  },
  commented: { tone: "neutral", meaning: "A reviewer commented without deciding." },
};

/** What the gate says where the host has recorded no review verdict at all. */
export const NO_REVIEW_DECISION_COPY = "No decision yet.";

/** One host check, as the host names it. */
export interface ProposalCheck {
  readonly name: string;
  readonly status: CheckStatus;
}

/** Where the proposal stands, once it exists on the host. */
export interface ProposalStatusReading {
  readonly state: ChangeRequestState;
  readonly mergeable: MergeabilityReading;
  readonly checks: readonly ProposalCheck[];
  readonly reviewDecision?: ReviewDecision | undefined;
}

/** How many checks sit at each status, plus the tone the whole rollup reads at. */
export interface CheckRollup {
  readonly countByStatus: Readonly<Record<CheckStatus, number>>;
  readonly total: number;
  readonly tone: ChipTone;
}

/**
 * Fold a check list into the rollup the gate opens on.
 *
 * WORST-FIRST TONE, and it is a decision rather than an ordering accident: one failure
 * among fifty passes is the fact a person acts on, so a single `failure` takes the
 * rollup red and any remaining `pending` takes it neutral rather than amber — a check
 * that is still running needs nobody.
 */
export function checkRollup(checks: readonly ProposalCheck[]): CheckRollup {
  const countByStatus: Record<CheckStatus, number> = { pending: 0, success: 0, failure: 0 };
  for (const check of checks) {
    countByStatus[check.status] += 1;
  }
  return {
    countByStatus,
    total: checks.length,
    tone: countByStatus.failure > 0 ? "failure" : "neutral",
  };
}

// --- The three modelled actions ---------------------------------------------

/**
 * The three `Spec-011 §Required Behavior` names, and no more.
 *
 * These are what the gate offers. The wire behind them is the growth port's
 * `gitActionExecute`, whose `action` member is an untyped string because the action
 * vocabulary is unregistered — `bridge/growth-slate.ts` carries it as the
 * `gitflow-actions` row, owned by `Spec-011`. So this tuple is the console's half of
 * that seam: three offers, each of which the port refuses by name today.
 */
export const PROPOSAL_ACTIONS = ["commit", "push", "prepare-proposal"] as const;

/** One modelled action. Derived, so the vocabulary is declared exactly once. */
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

/** What each action is called on screen and what pressing it does. */
export interface ProposalActionPresentation {
  readonly label: string;
  /** What the act does, in one sentence. Shown before the act, never after it. */
  readonly consequence: string;
}

/**
 * Total over `ProposalAction` by construction.
 *
 * `prepare-proposal` states the gate's whole reason for existing: preparation happens
 * BEFORE any remote mutation, so its sentence is what a participant reads to know that
 * pressing it sends nothing.
 */
export const PROPOSAL_ACTION_PRESENTATION: Readonly<
  Record<ProposalAction, ProposalActionPresentation>
> = {
  commit: {
    label: "Commit",
    consequence:
      "Records the working tree's changes on the head branch. Nothing leaves this machine.",
  },
  push: {
    label: "Push",
    consequence: "Sends the head branch to the detected host.",
  },
  "prepare-proposal": {
    label: "Prepare proposal",
    consequence:
      "Builds the proposal locally so it can be reviewed here first. Nothing is created on the host.",
  },
};

// --- The incompatible-checkout choice ---------------------------------------

/**
 * A blocking choice, never resolved automatically.
 *
 * `Spec-011 §Fallback Behavior` requires an explicit user choice before proceeding on
 * an incompatible checkout, so the gate holds and offers the host's own options rather
 * than picking one. The options are the daemon's strings — the console mints none,
 * which is why this shape carries a list rather than a closed union.
 */
export interface CheckoutConflict {
  /** What is incompatible, in the daemon's own words. Rendered verbatim. */
  readonly reason: string;
  /** The ways forward the daemon offered. At least one, or there is no choice to put. */
  readonly options: readonly CheckoutConflictOption[];
}

/** One way forward out of an incompatible checkout. */
export interface CheckoutConflictOption {
  readonly optionId: string;
  readonly label: string;
}

// --- What the gate can have to say ------------------------------------------

/**
 * The gate's arms. Six, and none stands in for another — rule 8's whole claim, applied
 * to a surface whose absences are unusually easy to conflate.
 *
 *   • `not-checked`  — nothing was asked. No branch-context read is registered on the
 *                      bridge, so this is V1's ordinary arm and it must never read as
 *                      "this workspace has no context".
 *   • `no-context`   — the question was put and the mode is the answer. Carries the
 *                      mode so the reason names it rather than generalising.
 *   • `preparing`    — a read is in flight.
 *   • `prepared`     — a context, optionally a proposal, optionally its host status.
 *   • `hosting-unavailable` — the DEGRADED arm, which is a required feature rather
 *                      than an error page: a proposal-ready summary plus the bundle a
 *                      participant acts on by hand.
 *   • `refused`      — a first-class failure carrying the daemon's own message.
 */
export type ProposalGateState =
  | { readonly kind: "not-checked" }
  | { readonly kind: "no-context"; readonly executionMode: ExecutionMode }
  | { readonly kind: "preparing" }
  | {
      readonly kind: "prepared";
      readonly context: BranchContextReading;
      readonly detectedHost: string;
      readonly proposal?: PreparedProposal | undefined;
      readonly status?: ProposalStatusReading | undefined;
    }
  | {
      readonly kind: "hosting-unavailable";
      readonly context: BranchContextReading;
      readonly proposal: PreparedProposal;
      /** Where the diff artifact bundle landed, so the summary is actionable by hand. */
      readonly bundlePath: string;
    }
  | { readonly kind: "refused"; readonly message: string };

/**
 * What the degraded arm says.
 *
 * It names the capability rather than the outage, because `Spec-011 §Fallback
 * Behavior` makes producing a summary and a bundle the REQUIRED behaviour when hosting
 * is unavailable — so this state is the system working, and copy that apologised for
 * it would misreport a feature as a fault.
 */
export const HOSTING_UNAVAILABLE_COPY =
  "The git host is not reachable, so nothing was sent. The proposal summary and its diff bundle are below and are complete enough to act on by hand.";

/** What a failed git action says above the daemon's own message text. */
export const ACTION_FAILURE_COPY = "The daemon refused this action.";
