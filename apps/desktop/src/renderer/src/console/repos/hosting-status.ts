// What the git host says about a proposal that already exists there, normalized once.
//
// THREE TRICHOTOMIES AND THE CHECK ROLLUP THEY OPEN ON, fixed here because no committed
// document states them, and this module is the whole of the console's reading of them —
// `prepared-proposal.ts` beside it owns what a proposal carries before any of this
// exists, and `ProposalGate.tsx` draws what is decided here without deciding any of it
// again.
//
// THE THREE TRICHOTOMIES ARE NORMALIZED HERE AND NOWHERE ELSE. Their
// members are fixed above, and two of them carry a reading a host-shaped string would lose:
// `mergeable: "unknown"` means the host is still computing and NEVER an error, and an
// absent `reviewDecision` means no decision yet rather than a rejection. Both facts are
// in the tables below, so a renderer cannot restate either one differently.
//
// NO SECOND HOST ADAPTER. Every value here is the host's own word, arriving as a wire
// string this module never picks; `Spec-011 §Git Hosting Adapter` owns which host is
// talked to, and nothing here branches on which one answered.

import type { ChipTone } from "../primitives/index.js";

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
 * progress as a problem — the one reading this module names explicitly.
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
