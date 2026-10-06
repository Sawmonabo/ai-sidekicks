// The CodexSignals fixture for the verdict decision-table tests.

/** A settled, fully clean PR: +1 on the issue, no reviews, CI green, mergeable. */
export function cleanSignals(overrides = {}) {
  return {
    isDraft: false,
    isOpen: true,
    headUnchanged: true,
    pushAnchorKnown: true,
    rateLimited: false,
    reviewAcksHead: false,
    reactionAcksHead: true,
    commentAcksHead: false,
    commentAcksHeadBySha: false,
    commentAssertsClean: false,
    commentReportsFindings: false,
    staleRunLandedAfterPush: false,
    // The production-normal baseline state: the gate stamped or read a usable
    // first sighting, and nothing was refused for predating it. Both are
    // explicit rather than defaulted because the fixture's ack is the `+1` —
    // a timestamp-only leg — so an absent baseline signal would make every test
    // built on this fixture unvouchable, which is the correct fail-closed
    // behavior and would be a useless default here.
    observationBaselineKnown: true,
    ackPredatesBaseline: false,
    openThreadCount: 0,
    latestReviewAgeMs: Number.POSITIVE_INFINITY,
    latestCommentAckAgeMs: Number.POSITIVE_INFINITY,
    threadWindowTruncated: false,
    checkWindowTruncated: false,
    ciStatus: "green",
    mergeStateStatus: "CLEAN",
    ...overrides,
  };
}
