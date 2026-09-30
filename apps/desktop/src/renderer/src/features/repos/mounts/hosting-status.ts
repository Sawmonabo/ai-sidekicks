// What the git host says about a change request that already exists there, as the
// console presents it.
//
// THE VOCABULARIES ARE THE CONTRACT'S, IMPORTED AND NEVER RESTATED. Each table below is
// a `Record` keyed by a wire union from `@ai-sidekicks/contracts`, so a member added
// there fails to compile here before it reaches a chip with no meaning. Two absences
// carry a reading a host-shaped string would lose: an absent `mergeable` means the host
// has not settled it, never a conflict and never an error, and an absent
// `reviewDecision` means no decision yet rather than a rejection. Neither has a table
// row, so neither can be drawn as a value the host never sent.
//
// THE REQUEST'S DECISION AND A REVIEWER'S VERDICT ARE TWO SETS. A reviewer can comment
// without deciding, and a request can need a review nobody has given, so each has its
// own table.
//
// NO SECOND HOST ADAPTER. Every value here is the host's own word, arriving as a wire
// string this module never picks; the hosting adapter owns which host is talked to,
// and nothing here branches on which one answered.

import type {
  ChangeRequestCheck,
  ChangeRequestCheckStatus,
  ChangeRequestMergeability,
  ChangeRequestReviewDecision,
  ChangeRequestState,
  ReviewerVerdict,
} from "@ai-sidekicks/contracts";

import type { ChipTone } from "@renderer/components/Chip/Chip.js";

/** What a status value means and how loudly it reads. The name itself is the wire's. */
export interface StatusPresentation {
  /** Amber means a person is needed, red means something failed, everything else neutral. */
  readonly tone: ChipTone;
  /** One sentence saying what this value means. Never the value name reworded. */
  readonly meaning: string;
}

/**
 * Total over `ChangeRequestState` by construction.
 *
 * @consumedBy the pull request tab's state pill
 */
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
 * Total over `ChangeRequestMergeability` by construction; an unsettled answer is absent.
 *
 * @consumedBy the pull request tab's header
 */
export const MERGEABILITY_PRESENTATION: Readonly<
  Record<ChangeRequestMergeability, StatusPresentation>
> = {
  mergeable: {
    tone: "neutral",
    meaning: "The host reports no conflict against the base branch.",
  },
  conflicting: {
    tone: "attention",
    meaning: "The host reports a conflict against the base branch. Resolving it is a person's act.",
  },
};

/**
 * Total over `ChangeRequestCheckStatus` by construction.
 *
 * @consumedBy the pull request tab's checks
 */
export const CHECK_STATUS_PRESENTATION: Readonly<
  Record<ChangeRequestCheckStatus, StatusPresentation>
> = {
  pending: { tone: "neutral", meaning: "Still running." },
  success: { tone: "neutral", meaning: "Passed." },
  failure: { tone: "failure", meaning: "Failed." },
};

/**
 * Total over `ChangeRequestReviewDecision` by construction.
 *
 * There is no member for "nobody decided" — that is the absence of a decision and it
 * renders as an absence, not as a fourth value. Adding one here would let the console
 * assert a verdict the host never gave.
 *
 * @consumedBy the pull request tab's header
 */
export const CHANGE_REQUEST_REVIEW_DECISION_PRESENTATION: Readonly<
  Record<ChangeRequestReviewDecision, StatusPresentation>
> = {
  approved: { tone: "neutral", meaning: "The request has the approval it needs." },
  changes_requested: {
    tone: "attention",
    meaning: "A reviewer asked for changes.",
  },
  review_required: {
    tone: "attention",
    meaning: "The host requires a review nobody has given yet.",
  },
};

/**
 * Total over `ReviewerVerdict` by construction.
 *
 * @consumedBy the pull request tab's review list
 */
export const REVIEWER_VERDICT_PRESENTATION: Readonly<Record<ReviewerVerdict, StatusPresentation>> =
  {
    approved: { tone: "neutral", meaning: "This reviewer approved the request." },
    changes_requested: {
      tone: "attention",
      meaning: "This reviewer asked for changes.",
    },
    commented: { tone: "neutral", meaning: "This reviewer commented without deciding." },
  };

/**
 * What the review list says where no reviewer has given a verdict yet.
 *
 * @consumedBy the pull request tab's review list
 */
export const NO_REVIEWER_VERDICT_COPY = "No review yet";

/** How many checks sit at each status, plus the tone the whole rollup reads at. */
export interface CheckRollup {
  readonly countByStatus: Readonly<Record<ChangeRequestCheckStatus, number>>;
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
export function checkRollup(checks: readonly Pick<ChangeRequestCheck, "status">[]): CheckRollup {
  const countByStatus: Record<ChangeRequestCheckStatus, number> = {
    pending: 0,
    success: 0,
    failure: 0,
  };
  for (const check of checks) {
    countByStatus[check.status] += 1;
  }
  return {
    countByStatus,
    total: checks.length,
    tone: countByStatus.failure > 0 ? "failure" : "neutral",
  };
}
