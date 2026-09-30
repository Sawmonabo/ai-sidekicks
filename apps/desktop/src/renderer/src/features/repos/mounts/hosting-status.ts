// Presentation of what the git host reports about a change request. Each table is a `Record`
// keyed by a contract union, so a new wire member fails to compile here. An absent `mergeable`
// (not settled yet) and an absent `reviewDecision` (no decision yet) have no row, so they are
// never drawn as a value the host did not send.

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
 * Total over `ChangeRequestReviewDecision` by construction. "Nobody decided" is an absence,
 * not a fourth value, so the console cannot assert a verdict the host never gave.
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
 * Fold a check list into a count per status and a worst-first tone: any failure is red, else
 * neutral, since a check still running needs nobody.
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
