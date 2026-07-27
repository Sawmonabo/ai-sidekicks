// node:test suite for lib/codex-verdict.mjs.
// Run via:
//   node --test --experimental-strip-types '.claude/skills/plan-execution/scripts/__tests__/**/*.test.mjs'
//
// The decision table is unit-tested rather than probed against live PRs because
// its highest-risk branches are unreachable from real data: every findings review
// in the repo is followed by a fix push, so no PR ever shows
// review.commit_id === HEAD; codex-gate.mjs drains both GraphQL connections, so
// truncation never fires; and this repo's checks only ever report SUCCESS or
// FAILURE, so most of the CI conclusion space never appears. A live probe skips
// all of it and still reports success.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeBaseline, resolveBaselinePath } from "../lib/observation-baseline.mjs";
import {
  computeVerdict,
  deriveCiStatus,
  deriveCommentSignals,
  derivePreBaselineAcks,
  derivePushAnchor,
  deriveReactionAck,
  deriveReviewAck,
  deriveStaleRunEvidence,
  isAtOrAfter,
  mergeStateAllowsMerge,
  partitionByRequirement,
  selectNewestReview,
  selectNewestRunPerName,
  selectUnresolvedBotThreads,
  BOT_GRAPHQL_LOGIN,
  BOT_REST_LOGIN,
  DEFAULT_SETTLE_WINDOW_MS,
  MERGEABLE_MERGE_STATES,
} from "../lib/codex-verdict.mjs";

/** A settled, fully clean PR: +1 on the issue, no reviews, CI green, mergeable. */
function cleanSignals(overrides = {}) {
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
    // behaviour and would be a useless default here.
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

test("baseline: +1 reaction on green CI is a mergeable clean pass", () => {
  const result = computeVerdict(cleanSignals());
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.ackOfHead, true);
  assert.equal(result.mergeOk, true);
});

test("RACE: a fresh review on HEAD with no visible threads is NOT clean", () => {
  // Codex submits a findings review at T=0; its threads have not materialised.
  // Read naively this is indistinguishable from a clean pass, and scored
  // merge_ok=1 it would merge a PR that has open findings.
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      reviewAcksHead: true,
      openThreadCount: 0,
      latestReviewAgeMs: 3_000,
    }),
  );
  assert.equal(result.verdict, "ack_unsettled");
  assert.equal(result.unsettled, true);
  assert.equal(result.mergeOk, false, "must never merge inside the settle window");
});

test("RACE control: the settle window is what changes the verdict, nothing else", () => {
  // Same signals, window collapsed to zero. If this did NOT flip to ack_clean the
  // test above would be passing for some unrelated reason.
  const signals = cleanSignals({
    reactionAcksHead: false,
    reviewAcksHead: true,
    openThreadCount: 0,
    latestReviewAgeMs: 3_000,
    settleWindowMs: 0,
  });
  const result = computeVerdict(signals);
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("a review older than the settle window with no threads is a genuine clean pass", () => {
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      reviewAcksHead: true,
      openThreadCount: 0,
      latestReviewAgeMs: DEFAULT_SETTLE_WINDOW_MS + 1,
    }),
  );
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("the settle guard does NOT apply to the reaction leg", () => {
  // A +1 means "no suggestions", so no threads are pending behind it. Holding
  // the reaction leg would stall every clean merge for two minutes. This also
  // pins the other half of the rule: the review leg is NOT firing here, so its
  // 1_000ms age must contribute Infinity rather than pulling the min down.
  const result = computeVerdict(cleanSignals({ latestReviewAgeMs: 1_000 }));
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("a non-firing comment leg contributes Infinity, not its age", () => {
  // Symmetric to the review case above. A fresh comment that does NOT ack HEAD
  // must not drag the settle window down onto an unrelated ack.
  const result = computeVerdict(
    cleanSignals({ commentAcksHead: false, latestCommentAckAgeMs: 1_000 }),
  );
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

// ------------- an ack of HEAD is not a verdict on HEAD (R3-4, guard 2)

test("a sha-citing comment alone never reaches ack_clean, even with 0 threads", () => {
  // The false pass this closes: a findings comment naming HEAD satisfied the ack
  // leg, and in the window before its inline threads materialised the gate saw
  // an ack with zero open threads and reported merge_ok=1 on a commit with open
  // findings. Settled here on purpose — the settle window must NOT be what saves
  // it, or the two guards would be one guard.
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      commentAcksHead: true,
      commentAssertsClean: false,
      latestCommentAckAgeMs: DEFAULT_SETTLE_WINDOW_MS + 1,
    }),
  );
  assert.equal(result.verdict, "ack_without_verdict");
  assert.equal(result.ackOfHead, true, "it IS an ack of HEAD");
  assert.equal(result.cleanAssertingAck, false, "it just does not assert cleanliness");
  assert.equal(
    result.unsettled,
    false,
    "and it is settled — the other guard is not the one firing",
  );
  assert.equal(result.mergeOk, false);
});

test("CONTROL: the same comment asserting CLEAN is mergeable", () => {
  // Flips the single bit under test. Without this the assertion above could be
  // passing because of some unrelated conjunct.
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      commentAcksHead: true,
      commentAssertsClean: true,
      latestCommentAckAgeMs: DEFAULT_SETTLE_WINDOW_MS + 1,
    }),
  );
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("a review on HEAD needs no explicit clean assertion — resolve-then-merge", () => {
  // A clean pass posts no HEAD review at all (PR #256: four bot reviews, none on
  // HEAD), so a review naming HEAD whose threads are every one resolved is the
  // ordinary post-fix state. Demanding an assertion here would refuse a merge
  // that should go — a false NEGATIVE introduced by over-tightening.
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      reviewAcksHead: true,
      commentAssertsClean: false,
      openThreadCount: 0,
      latestReviewAgeMs: DEFAULT_SETTLE_WINDOW_MS + 1,
    }),
  );
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

// ------------------ the settle window covers BOTH thread-bearing legs (R3-4)

test("RACE: a fresh comment ack with no visible threads is NOT clean", () => {
  // Same race as the review leg, reached through the comment leg. Scoping the
  // window to `reviewAcksHead` left this side wide open.
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      commentAcksHead: true,
      commentAssertsClean: true,
      latestCommentAckAgeMs: 3_000,
    }),
  );
  assert.equal(result.verdict, "ack_unsettled");
  assert.equal(result.unsettled, true);
  assert.equal(result.unsettledAckLeg, "comment");
  assert.equal(result.mergeOk, false);
});

test("CONTROL: the same comment ack past the window merges", () => {
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      commentAcksHead: true,
      commentAssertsClean: true,
      latestCommentAckAgeMs: DEFAULT_SETTLE_WINDOW_MS + 1,
    }),
  );
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("the youngest FIRING leg decides the window, and names itself", () => {
  // Both thread-bearing legs fire; the comment is younger, so it is the one the
  // gate is waiting on and the one the caller must be told about.
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      reviewAcksHead: true,
      commentAcksHead: true,
      commentAssertsClean: true,
      latestReviewAgeMs: DEFAULT_SETTLE_WINDOW_MS + 1,
      latestCommentAckAgeMs: 5_000,
    }),
  );
  assert.equal(result.verdict, "ack_unsettled");
  assert.equal(result.unsettledAckLeg, "comment");
  assert.equal(result.threadBearingAckAgeMs, 5_000);
});

test("a NaN age on a FIRING leg is unsettled, not 'safely settled'", () => {
  // The R4-1 false pass, at the decision table. This case used to normalise to
  // Infinity and score ack_clean + merge_ok=1: an ack whose age cannot be
  // measured was read as an ack comfortably OUTSIDE the settle window, which is
  // the one reading the evidence does not support. Unknown recency is the
  // absence of evidence about when the ack landed, so the window must hold it —
  // exactly as if it had landed this instant.
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      commentAcksHead: true,
      commentAssertsClean: true,
      latestCommentAckAgeMs: Number.NaN,
    }),
  );
  assert.equal(result.threadBearingAckAgeMs, 0, "an undatable firing leg reads as brand new");
  assert.equal(result.unsettled, true);
  assert.equal(result.ackAgeUnknown, true, "and the caller is told WHY, so it can say so");
  assert.equal(result.verdict, "ack_unsettled");
  assert.equal(result.mergeOk, false, "the false merge R4-1 named");
});

test("CONTROL: the same NaN on a NON-firing leg still contributes Infinity", () => {
  // The half of the old behaviour that was CORRECT and must survive the fix. A
  // leg the gate rejected has no standing to shorten the window, so its age —
  // measurable or not — must not pull the minimum down. Collapsing these two
  // cases together is what produced R4-1; this is the control that proves they
  // are still apart.
  const result = computeVerdict(
    cleanSignals({ commentAcksHead: false, latestCommentAckAgeMs: Number.NaN }),
  );
  assert.equal(result.threadBearingAckAgeMs, Number.POSITIVE_INFINITY);
  assert.equal(result.ackAgeUnknown, false, "a leg that did not fire has no unknown age");
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("an undatable REVIEW ack is held by the window too", () => {
  // Same defect, reached through the other thread-bearing leg. Both are fed by
  // `firingLegAgeMs`, so a fix applied to one and not the other would leave this
  // side open.
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      reviewAcksHead: true,
      latestReviewAgeMs: Number.NaN,
    }),
  );
  assert.equal(result.verdict, "ack_unsettled");
  assert.equal(result.unsettledAckLeg, "review");
  assert.equal(result.ackAgeUnknown, true);
  assert.equal(result.mergeOk, false);
});

test("Infinity on a FIRING leg is unsettled too — it is the old missing-value sentinel", () => {
  // Not a corner case: the deriver this gate shipped with returned Infinity for
  // a review it could not date, so a caller still on that convention hands one
  // in here. Reading it as "infinitely old, therefore settled" is R4-1 arriving
  // through the front door. Infinity stays meaningful only for a leg that did
  // NOT fire, where computeVerdict supplies it directly and never consults the
  // caller's number at all — the control below.
  const firing = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      commentAcksHead: true,
      commentAssertsClean: true,
      latestCommentAckAgeMs: Number.POSITIVE_INFINITY,
    }),
  );
  assert.equal(firing.verdict, "ack_unsettled");
  assert.equal(firing.ackAgeUnknown, true);
  assert.equal(firing.mergeOk, false);

  const notFiring = computeVerdict(
    cleanSignals({ commentAcksHead: false, latestCommentAckAgeMs: Number.POSITIVE_INFINITY }),
  );
  assert.equal(notFiring.verdict, "ack_clean");
  assert.equal(notFiring.mergeOk, true);
});

test("an undatable ack is reported as such, not as an age of zero seconds", () => {
  // A genuine 0ms age is reachable — GitHub stamps are second-granular, so an
  // ack read inside its own second measures 0 — which is why the caller cannot
  // infer "undatable" from `threadBearingAckAgeMs === 0` and needs the flag. The
  // two states print different remediations: one expires by waiting and the
  // other never does.
  const measured = computeVerdict(
    cleanSignals({ reactionAcksHead: false, reviewAcksHead: true, latestReviewAgeMs: 0 }),
  );
  assert.equal(measured.threadBearingAckAgeMs, 0);
  assert.equal(measured.ackAgeUnknown, false, "0 is a measurement, not a missing one");
  assert.equal(measured.verdict, "ack_unsettled");
});

// ------------------------------- HEAD moved mid-probe (R3-3)

test("a HEAD that moved mid-probe is never mergeable, and says so", () => {
  // Every signal in the object was gathered against a sha that is no longer
  // HEAD. Reporting `no_ack_yet` would send the caller hunting a missing review.
  const result = computeVerdict(cleanSignals({ headUnchanged: false }));
  assert.equal(result.verdict, "head_moved");
  assert.equal(result.mergeOk, false);
});

test("head_moved outranks every other verdict — the probe is stale, not informative", () => {
  for (const overrides of [
    { rateLimited: true },
    { isDraft: true },
    { openThreadCount: 4 },
    { threadWindowTruncated: true },
    { reactionAcksHead: false },
  ]) {
    const result = computeVerdict(cleanSignals({ headUnchanged: false, ...overrides }));
    assert.equal(result.verdict, "head_moved", JSON.stringify(overrides));
    assert.equal(result.mergeOk, false, JSON.stringify(overrides));
  }
});

test("CONTROL: an unchanged HEAD is what restores the merge", () => {
  const result = computeVerdict(cleanSignals({ headUnchanged: true }));
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("an absent headUnchanged signal fails closed WITHOUT claiming a move", () => {
  // A caller that never re-read HEAD saw no move, so `head_moved` would name an
  // event nobody observed — but an unconfirmed head must not authorise a merge
  // either. Hence `=== false` for the verdict and `=== true` for mergeOk.
  const result = computeVerdict(cleanSignals({ headUnchanged: undefined }));
  assert.equal(result.verdict, "ack_clean", "no move was observed, so none is reported");
  assert.equal(result.mergeOk, false, "but an unconfirmed head grants no merge");
});

test("open bot threads outrank any ack leg", () => {
  const result = computeVerdict(cleanSignals({ openThreadCount: 3 }));
  assert.equal(result.verdict, "ack_with_findings");
  assert.equal(result.mergeOk, false);
});

test("rate limiting is a NON-ack terminal that outranks everything", () => {
  const result = computeVerdict(cleanSignals({ rateLimited: true, openThreadCount: 2 }));
  assert.equal(result.verdict, "rate_limited");
  assert.equal(result.mergeOk, false);
});

test("a draft is not review-eligible", () => {
  const result = computeVerdict(cleanSignals({ isDraft: true }));
  assert.equal(result.verdict, "draft_not_eligible");
  assert.equal(result.mergeOk, false);
});

test("no ack of HEAD is never mergeable", () => {
  const result = computeVerdict(
    cleanSignals({ reactionAcksHead: false, reviewAcksHead: false, commentAcksHead: false }),
  );
  assert.equal(result.verdict, "no_ack_yet");
  assert.equal(result.ackOfHead, false);
  assert.equal(result.mergeOk, false);
});

test("a comment ack that asserts CLEAN is a valid ack leg on its own", () => {
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      commentAcksHead: true,
      commentAssertsClean: true,
      latestCommentAckAgeMs: DEFAULT_SETTLE_WINDOW_MS + 1,
    }),
  );
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("an empty check rollup is not a pass", () => {
  // "none" means no checks were reported — absence of evidence, not evidence of green.
  const result = computeVerdict(cleanSignals({ ciStatus: "none" }));
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, false);
});

for (const ciStatus of ["red", "pending", "none"]) {
  test(`mergeOk is false when CI is ${ciStatus}`, () => {
    assert.equal(computeVerdict(cleanSignals({ ciStatus })).mergeOk, false);
  });
}

// -------------------------------------------------------- truncated signals

for (const truncatedSignal of ["threadWindowTruncated", "checkWindowTruncated"]) {
  test(`${truncatedSignal} makes an otherwise-clean PR non-mergeable`, () => {
    // A count the gate cannot vouch for is indistinguishable from a hidden
    // unresolved finding. Detecting truncation and then not feeding it into the
    // verdict is what let a warning print while merge_ok stayed 1.
    const result = computeVerdict(cleanSignals({ [truncatedSignal]: true }));
    assert.equal(result.verdict, "signal_truncated");
    assert.equal(result.signalTruncated, true);
    assert.equal(result.ackOfHead, true, "the ack legs are unaffected by truncation");
    assert.equal(result.mergeOk, false);
  });
}

test("truncation control: clearing the flag is what restores the merge", () => {
  // Same signals, truncation off. If this did NOT flip to ack_clean the tests
  // above would be passing for some unrelated reason.
  const result = computeVerdict(cleanSignals({ threadWindowTruncated: false }));
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("visible findings outrank truncation in the verdict, and both refuse merge", () => {
  const result = computeVerdict(cleanSignals({ openThreadCount: 2, threadWindowTruncated: true }));
  assert.equal(result.verdict, "ack_with_findings", "the actionable verdict wins the report");
  assert.equal(result.mergeOk, false);
});

test("truncation without an ack still reads as no_ack_yet", () => {
  // Nothing to be truncated ABOUT yet — the caller is still waiting on Codex.
  const result = computeVerdict(
    cleanSignals({ reactionAcksHead: false, threadWindowTruncated: true }),
  );
  assert.equal(result.verdict, "no_ack_yet");
  assert.equal(result.mergeOk, false);
});

// ------------------------------------------------------------- merge state

test("mergeStateAllowsMerge accepts exactly the three mergeable MergeStateStatus values", () => {
  // Enumerated against the live MergeStateStatus enum (introspected 2026-07-27).
  const expectations = {
    CLEAN: true,
    HAS_HOOKS: true,
    UNSTABLE: true, // mergeable with a non-passing ADVISORY status — the F8 case
    BLOCKED: false,
    BEHIND: false,
    DIRTY: false,
    UNKNOWN: false,
  };
  for (const [mergeStateStatus, allowed] of Object.entries(expectations)) {
    assert.equal(mergeStateAllowsMerge(mergeStateStatus), allowed, mergeStateStatus);
  }
});

test("UNSTABLE is mergeable: an advisory check may be red while required checks pass", () => {
  assert.equal(computeVerdict(cleanSignals({ mergeStateStatus: "UNSTABLE" })).mergeOk, true);
});

test("BLOCKED refuses the merge even when Codex is clean and required checks are green", () => {
  // The backstop for required-only CI filtering: a required check with NO row in
  // the rollup is invisible to a row filter, but GitHub still reports BLOCKED.
  const result = computeVerdict(cleanSignals({ mergeStateStatus: "BLOCKED" }));
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, false);
});

test("an absent or UNKNOWN merge state fails closed", () => {
  assert.equal(computeVerdict(cleanSignals({ mergeStateStatus: undefined })).mergeOk, false);
  assert.equal(computeVerdict(cleanSignals({ mergeStateStatus: "UNKNOWN" })).mergeOk, false);
});

// ----------------------------------------------------------------- PR state

test("a MERGED PR with an otherwise-perfect clean ack is NOT mergeable", () => {
  // The false pass this closes: ack legs satisfied, CI green, no threads. Only
  // `isOpen` distinguishes "ready to merge" from "already merged".
  const result = computeVerdict(cleanSignals({ isOpen: false }));
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.ackOfHead, true);
  assert.equal(result.mergeOk, false);
});

test("the OPEN case is unaffected", () => {
  assert.equal(computeVerdict(cleanSignals({ isOpen: true })).mergeOk, true);
});

test("isOpen does NOT lean on a merged PR happening to report UNKNOWN", () => {
  // Live #256 (merged) reports mergeStateStatus=UNKNOWN, which the merge-state
  // conjunct already refuses — but that is observed behaviour, not a contract.
  // Pinning CLEAN against a closed PR proves the state check does the work on
  // its own, so the gate stays correct if GitHub ever reports CLEAN there.
  assert.equal(
    computeVerdict(cleanSignals({ isOpen: false, mergeStateStatus: "CLEAN" })).mergeOk,
    false,
  );
});

test("an absent isOpen signal fails closed", () => {
  assert.equal(computeVerdict(cleanSignals({ isOpen: undefined })).mergeOk, false);
});

// ---------------------------------------------------------- push anchor

// The real timings from this branch's own c8bcdc1 (measured 2026-07-27), which
// is what makes the gap concrete rather than hypothetical.
const COMMITTED_AT = "2026-07-27T18:19:07Z";
const FIRST_SUITE_AT = "2026-07-27T18:20:59Z";
const COMMITTED_AT_MS = Date.parse(COMMITTED_AT);

function botReaction(createdAt) {
  return { user: { login: BOT_REST_LOGIN }, content: "+1", created_at: createdAt };
}

test("STALE ACK: a +1 for the previous head lands inside the commit-to-push gap", () => {
  // The sequence, in the order it actually happens:
  //   18:19:07  the new head is committed locally
  //   18:20:00  Codex +1s the PREVIOUS head — it cannot have seen this one
  //   18:20:59  the new head is pushed; GitHub opens its first check suite
  const staleReaction = botReaction("2026-07-27T18:20:00Z");

  // Anchored on commit time, that reaction acks a commit Codex never saw.
  assert.equal(deriveReactionAck([staleReaction], COMMITTED_AT_MS).reactionAcksHead, true);

  // Anchored on the push, the same reaction is correctly rejected.
  const { anchorMs } = derivePushAnchor(COMMITTED_AT_MS, [{ created_at: FIRST_SUITE_AT }]);
  assert.equal(deriveReactionAck([staleReaction], anchorMs).reactionAcksHead, false);
});

test("one anchor binds all three timestamp-bound legs at once", () => {
  // Confirmed by construction rather than assumed. The two sha-anchored legs are
  // deliberately absent: a review's commit_id and a "Reviewed commit: <sha>"
  // comment both name their commit, so no timestamp can stale them.
  const stale = "2026-07-27T18:20:00Z";
  const reactions = [botReaction(stale)];
  const comments = [
    { user: { login: BOT_REST_LOGIN }, body: "Didn't find any major issues", created_at: stale },
    { user: { login: BOT_REST_LOGIN }, body: "You have hit your usage limits", created_at: stale },
  ];
  const legsAt = (anchorMs) => ({
    reaction: deriveReactionAck(reactions, anchorMs).reactionAcksHead,
    ...deriveCommentSignals(comments, { headShaShort: "abc0123456", ackAnchorMs: anchorMs }),
  });

  const onCommitTime = legsAt(COMMITTED_AT_MS);
  assert.equal(onCommitTime.reaction, true, "+1 leg");
  assert.equal(onCommitTime.commentAcksHead, true, "clean-verdict leg");
  assert.equal(onCommitTime.rateLimited, true, "usage-limits non-ack");

  const { anchorMs } = derivePushAnchor(COMMITTED_AT_MS, [{ created_at: FIRST_SUITE_AT }]);
  const onPushAnchor = legsAt(anchorMs);
  assert.equal(onPushAnchor.reaction, false, "+1 leg");
  assert.equal(onPushAnchor.commentAcksHead, false, "clean-verdict leg");
  assert.equal(onPushAnchor.rateLimited, false, "usage-limits non-ack");
});

test("the earliest suite wins, not the latest", () => {
  // Re-runs add later suites to the same sha; anchoring on one of those would
  // reject acks that legitimately followed the push.
  const { anchorMs, pushObservedAtMs } = derivePushAnchor(COMMITTED_AT_MS, [
    { created_at: "2026-07-27T18:29:15Z" },
    { created_at: FIRST_SUITE_AT },
    { created_at: "2026-07-27T18:21:04Z" },
  ]);
  assert.equal(anchorMs, Date.parse(FIRST_SUITE_AT));
  assert.equal(pushObservedAtMs, Date.parse(FIRST_SUITE_AT));
});

test("the anchor never moves earlier than the commit time", () => {
  // A suite predating the commit means the sha was already on the server from an
  // earlier branch. `max` keeps the previous behaviour as the floor.
  const { anchorMs, pushAnchorKnown } = derivePushAnchor(COMMITTED_AT_MS, [
    { created_at: "2026-07-27T17:00:00Z" },
  ]);
  assert.equal(anchorMs, COMMITTED_AT_MS);
  assert.equal(pushAnchorKnown, true, "the push was still observed, just earlier");
});

test("no check suite means the push time is unknown, not zero", () => {
  const result = derivePushAnchor(COMMITTED_AT_MS, []);
  assert.equal(result.anchorMs, COMMITTED_AT_MS, "falls back to the commit time");
  assert.equal(result.pushObservedAtMs, null);
  assert.equal(result.pushAnchorKnown, false);
  assert.equal(derivePushAnchor(COMMITTED_AT_MS, null).pushAnchorKnown, false);
});

test("unparseable suite timestamps are skipped, not read as the epoch", () => {
  // `new Date(null)` is the epoch, so a null-dated suite would otherwise win the
  // min outright and then lose the max — silently reporting a known push anchor
  // that is really just the commit time.
  const result = derivePushAnchor(COMMITTED_AT_MS, [
    { created_at: null },
    { created_at: "not a date" },
    {},
    { created_at: FIRST_SUITE_AT },
  ]);
  assert.equal(result.anchorMs, Date.parse(FIRST_SUITE_AT));
  assert.equal(result.pushObservedAtMs, Date.parse(FIRST_SUITE_AT));
});

test("suites that are ALL unparseable leave the push time unknown", () => {
  const result = derivePushAnchor(COMMITTED_AT_MS, [{ created_at: null }, { created_at: "x" }]);
  assert.equal(result.pushAnchorKnown, false);
  assert.equal(result.anchorMs, COMMITTED_AT_MS);
});

test("an unknown push anchor is NOT mergeable even on an otherwise-perfect ack", () => {
  const result = computeVerdict(cleanSignals({ pushAnchorKnown: false }));
  assert.equal(result.verdict, "ack_clean", "the ack itself still stands");
  assert.equal(result.mergeOk, false);
});

test("a known push anchor leaves the clean case unaffected", () => {
  assert.equal(computeVerdict(cleanSignals({ pushAnchorKnown: true })).mergeOk, true);
});

test("an absent pushAnchorKnown signal fails closed", () => {
  assert.equal(computeVerdict(cleanSignals({ pushAnchorKnown: undefined })).mergeOk, false);
});

// ------------------------------------------------------- exhaustive sweep

/**
 * Every combination of the named dimensions, STREAMED rather than materialised.
 *
 * The `flatMap` form this replaces built the whole space as one array, so each
 * dimension added multiplied resident memory as well as time. The space is now
 * millions of objects wide and only one of them is ever live at a time, which is
 * what keeps a dimension affordable to add — and adding dimensions is the entire
 * mechanism by which the two invariants below stay honest.
 */
function* cartesianProduct(dimensions) {
  const dimensionEntries = Object.entries(dimensions);
  // An odometer rather than recursive `yield*` delegation, which is not a
  // premature optimisation at this width: delegation spreads a fresh partial at
  // every one of the ~19 levels, so it allocates ~19 objects per combination and
  // bubbles each result back up through as many generator frames. The odometer
  // allocates exactly one. Measured on this suite, recursion cost 2.3x the
  // materialised array it replaced; this pays that back and then some.
  const odometer = new Array(dimensionEntries.length).fill(0);
  for (;;) {
    const combination = {};
    for (let axis = 0; axis < dimensionEntries.length; axis += 1) {
      combination[dimensionEntries[axis][0]] = dimensionEntries[axis][1][odometer[axis]];
    }
    yield combination;
    let axis = dimensionEntries.length - 1;
    while (axis >= 0 && (odometer[axis] += 1) === dimensionEntries[axis][1].length) {
      odometer[axis] = 0;
      axis -= 1;
    }
    if (axis < 0) return;
  }
}

/**
 * The dimensions every sweep below ranges over, named once so a dimension added
 * for one invariant cannot silently go missing from another.
 *
 * `ciStatus` and `mergeStateStatus` each carry a value this gate does not know:
 * a status string outside the documented four, and `DIRTY` — a real GitHub
 * MergeStateStatus the gate has never had a branch for. Both have to fail
 * CLOSED, and a space built only from recognised values cannot tell "refuses
 * unknown input" apart from "was never asked".
 *
 * Both age dimensions carry `NaN` for the same reason. An age that cannot be
 * measured is the R4-1 defect's input, and it is invisible to a space built
 * only from measurable ages — the sweep would range over "fresh" and "settled"
 * and never over "unknown", which is the third state and the one that merged.
 * It also makes the mergeOk invariant below self-enforcing: `NaN >= X` is false,
 * so any combination that reaches a merge on an unmeasurable age fails the
 * settle-window assertion rather than passing silently.
 */
const VERDICT_SIGNAL_DIMENSIONS = {
  isDraft: [true, false],
  isOpen: [true, false],
  headUnchanged: [true, false],
  pushAnchorKnown: [true, false],
  rateLimited: [true, false],
  reviewAcksHead: [true, false],
  reactionAcksHead: [true, false],
  commentAcksHead: [true, false],
  commentAcksHeadBySha: [true, false],
  commentAssertsClean: [true, false],
  commentReportsFindings: [true, false],
  staleRunLandedAfterPush: [true, false],
  openThreadCount: [0, 1],
  latestReviewAgeMs: [1_000, DEFAULT_SETTLE_WINDOW_MS + 1, Number.NaN],
  latestCommentAckAgeMs: [1_000, DEFAULT_SETTLE_WINDOW_MS + 1, Number.NaN],
  threadWindowTruncated: [true, false],
  checkWindowTruncated: [true, false],
  ciStatus: ["green", "red", "pending", "none", "unrecognised-ci-status"],
  mergeStateStatus: ["CLEAN", "UNSTABLE", "BLOCKED", "UNKNOWN", "DIRTY", undefined],
};

/**
 * A SECOND, focused space for the two observation-baseline signals, chained onto
 * the one above rather than folded into it.
 *
 * Folding them in was the obvious move and it costs too much to be worth it: two
 * more booleans take the primary space from 8,847,360 combinations to 35,389,440
 * and the suite from about 6 seconds to about 22, on every run, forever. The
 * signals do not need that reach. Everything they interact with is an ack-leg
 * dimension plus the settle inputs, so a full cartesian over exactly those —
 * 9,216 combinations — covers the interaction completely, and the primary sweep
 * still ranges over CI, merge state, drafts and truncation independently.
 *
 * The non-ack dimensions are pinned to MERGEABLE values on purpose. A focused
 * space whose CI is red would exercise the ladder but could never reach a
 * merge, so the mergeOk invariant would pass over it vacuously — the one thing
 * this space exists to prevent.
 *
 * Note what the PRIMARY space now proves as a side effect: it never sets
 * `observationBaselineKnown` at all, so every one of its 8.8M combinations
 * carries an ABSENT baseline signal. That is the fail-closed direction asserted
 * across the whole space for free — a caller that never consulted the store
 * cannot merge on a timestamp-only ack anywhere in it.
 */
const BASELINE_SIGNAL_DIMENSIONS = {
  isDraft: [false],
  isOpen: [true],
  headUnchanged: [true],
  pushAnchorKnown: [true],
  rateLimited: [false],
  reviewAcksHead: [true, false],
  reactionAcksHead: [true, false],
  commentAcksHead: [true, false],
  commentAcksHeadBySha: [true, false],
  commentAssertsClean: [true, false],
  commentReportsFindings: [true, false],
  staleRunLandedAfterPush: [true, false],
  observationBaselineKnown: [true, false, undefined],
  ackPredatesBaseline: [true, false, undefined],
  openThreadCount: [0, 1],
  latestReviewAgeMs: [1_000, DEFAULT_SETTLE_WINDOW_MS + 1],
  latestCommentAckAgeMs: [1_000, DEFAULT_SETTLE_WINDOW_MS + 1],
  threadWindowTruncated: [false],
  checkWindowTruncated: [false],
  ciStatus: ["green"],
  mergeStateStatus: ["CLEAN"],
};

/**
 * Both spaces, back to back. The invariants below hold over the union, so a
 * verdict arm reachable only from the focused space still counts as reachable
 * and a false merge in either space still fails.
 */
function* allVerdictSignals() {
  yield* cartesianProduct(VERDICT_SIGNAL_DIMENSIONS);
  yield* cartesianProduct(BASELINE_SIGNAL_DIMENSIONS);
}

test("invariant: mergeOk implies ack, no threads, green CI, no truncation, mergeable state", () => {
  let mergeableCases = 0;

  for (const signals of allVerdictSignals()) {
    const result = computeVerdict(signals);
    if (!result.mergeOk) continue;
    mergeableCases += 1;
    const where = JSON.stringify(signals);
    assert.equal(result.ackOfHead, true, where);
    assert.equal(signals.openThreadCount, 0, where);
    assert.equal(signals.ciStatus, "green", where);
    assert.equal(signals.isDraft, false, where);
    assert.equal(signals.isOpen, true, where);
    assert.equal(signals.headUnchanged, true, where);
    assert.equal(signals.pushAnchorKnown, true, where);
    assert.equal(signals.rateLimited, false, where);
    assert.equal(result.unsettled, false, where);
    assert.equal(result.signalTruncated, false, where);
    assert.equal(signals.threadWindowTruncated, false, where);
    assert.equal(signals.checkWindowTruncated, false, where);
    assert.ok(MERGEABLE_MERGE_STATES.has(signals.mergeStateStatus), where);

    // Every merge rests on an ack that ASSERTS cleanliness, so a comment leg
    // firing alone must be a clean-asserting one. This is the sweep-wide form of
    // "citing a sha is not a verdict".
    assert.equal(result.cleanAssertingAck, true, where);
    if (!signals.reviewAcksHead && !signals.reactionAcksHead) {
      assert.equal(signals.commentAssertsClean, true, where);
    }

    // Findings reported in a comment body block the merge exactly as findings in
    // threads do. Nothing else catches this one: with no thread to resolve,
    // GitHub's require-conversation-resolution has nothing to hold, so the gate
    // is the only refusal standing between this shape and a merge.
    assert.equal(signals.commentReportsFindings, false, where);

    // No merge ever rests on an ack the gate cannot attribute to THIS commit.
    // The two sha-less legs are forgeable by a run for the previous head that
    // finishes after the push, so when they are the only acks, evidence of such
    // a run has to be absent. A sha-bound ack lifts the requirement, because a
    // run for another commit cannot produce one.
    assert.equal(result.ackAttributionAmbiguous, false, where);
    if (!signals.reviewAcksHead && !signals.commentAcksHeadBySha) {
      assert.equal(signals.staleRunLandedAfterPush, false, where);
    }

    // The same rule applied to the FLOOR rather than to a rival run. A
    // timestamp-only ack is bound to this head by the anchor alone, so a merge
    // resting on one requires a usable first-sighting baseline — and an absent
    // signal is not a usable one. A sha-bound ack lifts the requirement for the
    // same reason it lifts the attribution one: no floor is load-bearing when
    // the ack names the commit itself.
    assert.equal(result.timestampOnlyAckUnvouchable, false, where);
    if (!signals.reviewAcksHead && !signals.commentAcksHeadBySha) {
      assert.equal(signals.observationBaselineKnown, true, where);
    }

    // A refused pre-baseline ack can never be the thing a merge RESTS on. Note
    // the scoping: `ackPredatesBaseline` alone is deliberately not asserted
    // false here, because a refused stale `+1` alongside a genuine sha-bound
    // review on HEAD is not a reason to block — the review is dispositive and
    // the refusal is about a different, irrelevant signal. What must hold is
    // that some ack of HEAD actually survived, so the refused one is never
    // load-bearing. Asserting the unscoped form instead would have pinned the
    // over-blocking bug in place as though it were the specification.
    assert.equal(result.ackOfHead, true, where);

    // The settle window covers BOTH thread-bearing legs, so whichever of them
    // fired has to be outside it. Scoping the window to the review leg let a
    // fresh comment ack merge at age 1_000 — this is the assertion that fails.
    //
    // These two also carry the R4-1 tripwire at no extra cost, because `NaN >=
    // X` is false: a firing leg whose age is unmeasurable can only satisfy them
    // by never reaching a merge in the first place. Normalising an undatable
    // firing leg back to Infinity fails here rather than passing quietly.
    if (signals.reviewAcksHead) {
      assert.ok(signals.latestReviewAgeMs >= DEFAULT_SETTLE_WINDOW_MS, where);
    }
    if (signals.commentAcksHead) {
      assert.ok(signals.latestCommentAckAgeMs >= DEFAULT_SETTLE_WINDOW_MS, where);
    }
  }

  // Guard against the invariant passing vacuously because nothing was mergeable.
  assert.ok(mergeableCases > 0, "no mergeable case in the sweep — invariant proved nothing");
});

/**
 * Every verdict string `computeVerdict` may produce, pinned HERE rather than
 * imported from the module under test. An oracle read out of the implementation
 * agrees with the implementation by construction: a typo'd verdict string, or an
 * arm added without a name, would appear on both sides and the assertions below
 * would wave it through. Count new arms off the ladder, never off this list.
 */
const KNOWN_VERDICTS = new Set([
  "head_moved",
  "rate_limited",
  "draft_not_eligible",
  "ack_with_findings",
  "ack_findings_no_threads",
  "ack_unattributable",
  "ack_baseline_unavailable",
  "ack_unsettled",
  "signal_truncated",
  "ack_without_verdict",
  "ack_clean",
  "ack_predates_baseline",
  "no_ack_yet",
]);

test("every verdict arm is reachable, and the ladder produces nothing outside the known set", () => {
  const observedVerdicts = new Set();

  for (const signals of allVerdictSignals()) {
    const { verdict } = computeVerdict(signals);
    // A bare `has` rather than an assertion per combination: the sweep visits
    // over a million signal objects, and rendering a failure message for each
    // would cost more than the invariant it documents.
    if (!KNOWN_VERDICTS.has(verdict)) {
      assert.fail(`unlisted verdict ${JSON.stringify(verdict)} from ${JSON.stringify(signals)}`);
    }
    observedVerdicts.add(verdict);
  }

  // An if/else ladder is exactly where a reordering shadows a branch, and a
  // shadowed arm is indistinguishable from a working one without this check —
  // it simply never fires. The risk is not hypothetical here: the file header
  // records that this decision table's highest-risk branches are unreachable
  // from any real PR, so live traffic will never be the thing that notices.
  assert.deepEqual(
    [...KNOWN_VERDICTS].filter((verdict) => !observedVerdicts.has(verdict)),
    [],
    "verdict arms no combination in the sweep reaches",
  );
});

// --------------------------------------------------------------- CI rollup

function run(name, conclusion, startedAt, extra = {}) {
  return { name, conclusion, startedAt, completedAt: startedAt, ...extra };
}

test("a superseded CANCELLED run beside its real SUCCESS does not make CI red", () => {
  // Verbatim shape observed on PR #256: a push cancelled the in-flight advisory
  // lychee run, and the rollup then carried both rows for the same check name.
  const rollup = [
    run("ci-gate", "SUCCESS", "2026-07-27T00:28:55Z"),
    run("lychee — outbound HTTP (advisory)", "CANCELLED", "2026-07-27T00:25:10Z"),
    run("lychee — outbound HTTP (advisory)", "SUCCESS", "2026-07-27T00:25:59Z"),
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.status, "green");
  assert.equal(result.failed.length, 0);
  assert.equal(result.considered.length, 2, "two distinct check names survive dedupe");
});

test("dedupe does NOT hide a cancellation that is the newest run", () => {
  // The inverse risk of the fix above: if dedupe suppressed cancellations
  // generally, the gate would go blind to real failures.
  const rollup = [
    run("flaky-job", "SUCCESS", "2026-07-27T00:25:10Z"),
    run("flaky-job", "CANCELLED", "2026-07-27T00:25:59Z"),
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.status, "red");
  assert.equal(result.failed.length, 1);
});

test("a genuine FAILURE on the newest run is red", () => {
  const result = deriveCiStatus([run("test", "FAILURE", "2026-07-27T00:25:10Z")]);
  assert.equal(result.status, "red");
});

test("an in-flight rerun leaves CI pending, not green", () => {
  const rollup = [
    run("test", "SUCCESS", "2026-07-27T00:25:10Z"),
    { name: "test", conclusion: null, status: "IN_PROGRESS", startedAt: "2026-07-27T00:26:00Z" },
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.status, "pending");
});

test("an empty rollup is 'none', never green", () => {
  assert.equal(deriveCiStatus([]).status, "none");
  assert.equal(deriveCiStatus(undefined).status, "none");
});

test("legacy commit statuses (context/state, no timestamps) still dedupe", () => {
  const rollup = [
    { context: "legacy/build", state: "FAILURE" },
    { context: "legacy/build", state: "SUCCESS", completedAt: "2026-07-27T00:30:00Z" },
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.considered.length, 1);
  assert.equal(result.status, "green");
});

test("legacy commit statuses dedupe on createdAt, the only stamp they carry", () => {
  const rollup = [
    { context: "legacy/build", state: "SUCCESS", createdAt: "2026-07-27T00:30:00Z" },
    { context: "legacy/build", state: "FAILURE", createdAt: "2026-07-27T00:31:00Z" },
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.considered.length, 1);
  assert.equal(result.status, "red", "the newer status must win");
});

test("selectNewestRunPerName keeps exactly one row per name", () => {
  const rollup = [
    run("a", "SUCCESS", "2026-07-27T00:01:00Z"),
    run("a", "SUCCESS", "2026-07-27T00:02:00Z"),
    run("b", "SUCCESS", "2026-07-27T00:01:00Z"),
  ];
  const names = selectNewestRunPerName(rollup).map((check) => check.name);
  assert.deepEqual(names.sort(), ["a", "b"]);
});

// ------------------------------------------- CI conclusion / state coverage

// Every member of the three GraphQL enums this gate can receive, introspected
// from the live schema 2026-07-27. The classification is INVERTED — anything
// that is neither success-like nor pending is failed — so an unenumerated member
// blocks the merge instead of scoring green. ACTION_REQUIRED and STALE are the
// two that used to pass through as green.
const CHECK_CONCLUSION_EXPECTATIONS = {
  SUCCESS: "green",
  NEUTRAL: "green",
  SKIPPED: "green",
  ACTION_REQUIRED: "red",
  TIMED_OUT: "red",
  CANCELLED: "red",
  FAILURE: "red",
  STARTUP_FAILURE: "red",
  STALE: "red",
};

const CHECK_STATUS_EXPECTATIONS = {
  REQUESTED: "pending",
  QUEUED: "pending",
  IN_PROGRESS: "pending",
  WAITING: "pending",
  PENDING: "pending",
  // A finished run whose conclusion has not propagated yet. Not evidence of
  // anything, so it waits rather than flapping the gate red.
  COMPLETED: "pending",
};

const STATUS_STATE_EXPECTATIONS = {
  SUCCESS: "green",
  PENDING: "pending",
  EXPECTED: "pending",
  ERROR: "red",
  FAILURE: "red",
};

for (const [conclusion, expected] of Object.entries(CHECK_CONCLUSION_EXPECTATIONS)) {
  test(`CheckConclusionState ${conclusion} classifies as ${expected}`, () => {
    const rollup = [{ name: "check", status: "COMPLETED", conclusion }];
    assert.equal(deriveCiStatus(rollup).status, expected);
  });
}

for (const [status, expected] of Object.entries(CHECK_STATUS_EXPECTATIONS)) {
  test(`CheckStatusState ${status} (no conclusion yet) classifies as ${expected}`, () => {
    const rollup = [{ name: "check", conclusion: null, status }];
    assert.equal(deriveCiStatus(rollup).status, expected);
  });
}

for (const [state, expected] of Object.entries(STATUS_STATE_EXPECTATIONS)) {
  test(`StatusState ${state} classifies as ${expected}`, () => {
    const rollup = [{ context: "legacy/check", state }];
    assert.equal(deriveCiStatus(rollup).status, expected);
  });
}

test("a conclusion GitHub has not invented yet is failed, not green", () => {
  // The point of inverting the classification: an unknown member fails closed.
  const rollup = [{ name: "check", status: "COMPLETED", conclusion: "SOME_FUTURE_STATE" }];
  assert.equal(deriveCiStatus(rollup).status, "red");
});

test("a row carrying no state at all is pending, never green", () => {
  assert.equal(deriveCiStatus([{ name: "check" }]).status, "pending");
});

// ---------------------------------------------- required vs advisory checks

test("only isRequired rows gate when any row reports isRequired", () => {
  const rollup = [
    run("ci-gate", "SUCCESS", "2026-07-27T00:28:55Z", { isRequired: true }),
    run("docs-corpus-gate", "SUCCESS", "2026-07-27T00:28:55Z", { isRequired: true }),
    run("lychee — outbound HTTP (advisory)", "FAILURE", "2026-07-27T00:25:59Z", {
      isRequired: false,
    }),
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.mode, "required-only");
  assert.equal(result.status, "green", "a transient advisory failure must not block the merge");
  assert.equal(result.gating.length, 2);
  assert.equal(result.failed.length, 0);
  assert.equal(result.advisoryFailed.length, 1, "the advisory failure is still reported");
  assert.equal(result.considered.length, 3, "every deduped row is still accounted for");
});

test('a check NAMED "(required)" that reports isRequired:false does not gate', () => {
  // The live trap on this repo: `lychee — inbound anchors (required)` and
  // `lane boundary — plan-title token (required)` both carry "(required)" in
  // their names and both report isRequired:false. Branch protection lists only
  // ci-gate and docs-corpus-gate (verified 2026-07-27), so isRequired is the
  // only authority and name-matching would gate on the wrong set.
  const rollup = [
    run("ci-gate", "SUCCESS", "2026-07-27T00:28:55Z", { isRequired: true }),
    run("lychee — inbound anchors (required)", "FAILURE", "2026-07-27T00:25:59Z", {
      isRequired: false,
    }),
  ];
  assert.equal(deriveCiStatus(rollup).status, "green");
});

test("a failing REQUIRED check is still red while advisory checks pass", () => {
  const rollup = [
    run("ci-gate", "FAILURE", "2026-07-27T00:28:55Z", { isRequired: true }),
    run("lychee — outbound HTTP (advisory)", "SUCCESS", "2026-07-27T00:25:59Z", {
      isRequired: false,
    }),
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.status, "red");
  assert.equal(result.failed.length, 1);
});

test("a pending REQUIRED check holds the gate even when everything else is green", () => {
  const rollup = [
    { name: "ci-gate", conclusion: null, status: "IN_PROGRESS", isRequired: true },
    run("gitleaks", "SUCCESS", "2026-07-27T00:25:59Z", { isRequired: false }),
  ];
  assert.equal(deriveCiStatus(rollup).status, "pending");
});

test("degradation: with no isRequired row at all, EVERY check gates", () => {
  // Unprotected branch, or a rollup fetched without the field. Falling back to
  // the conservative set keeps the gate safe; codex-gate.mjs prints the mode so
  // the degradation is never silent.
  const rollup = [
    run("ci-gate", "SUCCESS", "2026-07-27T00:28:55Z"),
    run("lychee — outbound HTTP (advisory)", "FAILURE", "2026-07-27T00:25:59Z"),
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.mode, "all-checks");
  assert.equal(result.status, "red");
  assert.equal(result.advisory.length, 0, "nothing is advisory when nothing is required");
});

test("degradation control: adding one isRequired row flips the same rollup to green", () => {
  // Proves the test above is driven by the missing field, not by the failure.
  const rollup = [
    run("ci-gate", "SUCCESS", "2026-07-27T00:28:55Z", { isRequired: true }),
    run("lychee — outbound HTTP (advisory)", "FAILURE", "2026-07-27T00:25:59Z"),
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.mode, "required-only");
  assert.equal(result.status, "green");
});

test("partitionByRequirement treats absent and false isRequired identically", () => {
  const checks = [
    { name: "required", isRequired: true },
    { name: "explicitly-advisory", isRequired: false },
    { name: "field-absent" },
  ];
  const { gating, advisory, mode } = partitionByRequirement(checks);
  assert.equal(mode, "required-only");
  assert.deepEqual(
    gating.map((check) => check.name),
    ["required"],
  );
  assert.deepEqual(
    advisory.map((check) => check.name),
    ["explicitly-advisory", "field-absent"],
  );
});

test("a rollup of only advisory FAILURES is red, not green", () => {
  // Degradation must not become a way to pass: with no required row, the
  // advisory failure gates.
  const rollup = [run("advisory", "FAILURE", "2026-07-27T00:25:59Z", { isRequired: false })];
  assert.equal(deriveCiStatus(rollup).status, "red");
});

// ------------------------------------------------------- freshness predicate

const HEAD_COMMITTED_AT = "2026-07-27T16:36:20Z";
const HEAD_COMMITTED_AT_MS = Date.parse(HEAD_COMMITTED_AT);
const HEAD_SHA = "cea56e227b54544129a1f55c6cbe2f089bcc9aa5";
const HEAD_SHA_SHORT = HEAD_SHA.slice(0, 10);

test("freshness is INCLUSIVE: an ack in the commit's own second counts", () => {
  // GitHub timestamps are second-granular, so a fast ack carries exactly the
  // HEAD commit's `created_at`. A strict `>` dropped it and the poll waited out
  // its budget on an ack that had already landed. failure-modes.md documents the
  // predicate as `created_at >= BASELINE_TS`.
  assert.equal(isAtOrAfter(HEAD_COMMITTED_AT, HEAD_COMMITTED_AT_MS), true);
});

test("freshness rejects anything strictly earlier, down to one second", () => {
  assert.equal(isAtOrAfter("2026-07-27T16:36:19Z", HEAD_COMMITTED_AT_MS), false);
  assert.equal(isAtOrAfter("2026-07-27T16:36:21Z", HEAD_COMMITTED_AT_MS), true);
});

test("freshness fails closed on an absent or unparseable timestamp", () => {
  for (const timestamp of [undefined, null, "", "not a date"]) {
    assert.equal(isAtOrAfter(timestamp, HEAD_COMMITTED_AT_MS), false, String(timestamp));
  }
});

// --------------------------------------------------------- reaction ack leg

function reaction(overrides = {}) {
  return {
    user: { login: BOT_REST_LOGIN },
    content: "+1",
    created_at: "2026-07-27T16:40:00Z",
    ...overrides,
  };
}

test("a bot +1 newer than HEAD acks it", () => {
  const result = deriveReactionAck([reaction()], HEAD_COMMITTED_AT_MS);
  assert.equal(result.reactionAcksHead, true);
  assert.equal(result.freshThumbsUp.length, 1);
});

test("a bot +1 from a PRIOR head does not ack the current one", () => {
  // Reactions carry no commit reference; the timestamp is the only anchor.
  const result = deriveReactionAck(
    [reaction({ created_at: "2026-07-27T10:00:00Z" })],
    HEAD_COMMITTED_AT_MS,
  );
  assert.equal(result.reactionAcksHead, false);
  assert.equal(result.botThumbsUp.length, 1, "it is still counted as a bot +1 for the report");
});

test("a bot +1 in the HEAD commit's own second acks it", () => {
  const result = deriveReactionAck(
    [reaction({ created_at: HEAD_COMMITTED_AT })],
    HEAD_COMMITTED_AT_MS,
  );
  assert.equal(result.reactionAcksHead, true);
});

test("the REST login form is required — the bare GraphQL form matches nothing", () => {
  // A wrong-form filter returns 0 hits silently and the poll never terminates.
  const result = deriveReactionAck(
    [reaction({ user: { login: BOT_GRAPHQL_LOGIN } })],
    HEAD_COMMITTED_AT_MS,
  );
  assert.equal(result.botThumbsUp.length, 0);
  assert.equal(result.reactionAcksHead, false);
});

test("only a +1 acks — 'eyes' means Codex is still reviewing", () => {
  const result = deriveReactionAck([reaction({ content: "eyes" })], HEAD_COMMITTED_AT_MS);
  assert.equal(result.reactionAcksHead, false);
});

test("no reactions at all is not an ack and does not throw", () => {
  assert.equal(deriveReactionAck([], HEAD_COMMITTED_AT_MS).reactionAcksHead, false);
  assert.equal(deriveReactionAck(null, HEAD_COMMITTED_AT_MS).reactionAcksHead, false);
});

// --------------------------------------------------------- comment signals

/** The clean-verdict comment, verbatim from PR #120 (ASCII apostrophe, 0x27). */
const CLEAN_VERDICT_BODY = "Codex Review: Didn't find any major issues. What shall we delve next?";

function comment(overrides = {}) {
  return {
    user: { login: BOT_REST_LOGIN },
    body: CLEAN_VERDICT_BODY,
    created_at: "2026-07-27T16:40:00Z",
    ...overrides,
  };
}

/** 5 min after the default comment fixture — well outside the settle window. */
const COMMENT_NOW_MS = Date.parse("2026-07-27T16:45:00Z");

const commentAnchors = {
  headShaShort: HEAD_SHA_SHORT,
  ackAnchorMs: HEAD_COMMITTED_AT_MS,
  nowMs: COMMENT_NOW_MS,
};

test("a fresh clean-verdict comment is an ack leg in its own right", () => {
  // Ack shape (2), observed on PRs #120 / #121. The gate used to match only
  // "Reviewed commit" + sha, so a clean-comment ack read as no_ack_yet.
  const result = deriveCommentSignals([comment()], commentAnchors);
  assert.equal(result.commentAcksHead, true);
  assert.equal(result.freshCleanVerdictComments.length, 1);
});

test("a clean-verdict comment from a PRIOR head does not ack the current one", () => {
  // It carries no sha, so freshness is the only thing binding it to this push.
  const result = deriveCommentSignals(
    [comment({ created_at: "2026-07-27T10:00:00Z" })],
    commentAnchors,
  );
  assert.equal(result.commentAcksHead, false);
});

test("a clean-verdict comment in the HEAD commit's own second acks it", () => {
  const result = deriveCommentSignals([comment({ created_at: HEAD_COMMITTED_AT })], commentAnchors);
  assert.equal(result.commentAcksHead, true);
});

test("the clean-verdict match survives a typographic apostrophe", () => {
  // The live bytes are ASCII 0x27 (hexdumped 2026-07-27), but a quote swap
  // upstream would silently match zero comments — the failure this guards.
  const result = deriveCommentSignals(
    [comment({ body: "Codex Review: Didn’t find any major issues." })],
    commentAnchors,
  );
  assert.equal(result.commentAcksHead, true);
});

test("an unrelated bot comment is not a clean verdict", () => {
  const result = deriveCommentSignals(
    [comment({ body: "Codex Review: 3 issues found." })],
    commentAnchors,
  );
  assert.equal(result.commentAcksHead, false);
});

test("a sha-citing comment acks regardless of age — the sha IS the anchor", () => {
  // Deliberately older than HEAD: this leg must NOT inherit the timestamp filter
  // that the sha-less clean-verdict leg needs.
  const result = deriveCommentSignals(
    [
      comment({
        body: `**Reviewed commit:** \`${HEAD_SHA_SHORT}\``,
        created_at: "2020-01-01T00:00:00Z",
      }),
    ],
    commentAnchors,
  );
  assert.equal(result.commentAcksHead, true);
  assert.equal(result.shaCitingComments.length, 1);
});

test("a comment citing a DIFFERENT sha does not ack HEAD", () => {
  const result = deriveCommentSignals(
    [comment({ body: "**Reviewed commit:** `deadbeef00`" })],
    commentAnchors,
  );
  assert.equal(result.commentAcksHead, false);
});

test("a fresh usage-limits comment is a terminal non-ack", () => {
  const result = deriveCommentSignals(
    [comment({ body: "Codex has reached its usage limits for this period." })],
    commentAnchors,
  );
  assert.equal(result.rateLimited, true);
});

test("a usage-limits comment from a PRIOR head does NOT pin the gate", () => {
  // computeVerdict gives rate_limited precedence over every ack leg, so an
  // unbounded scan let one historic usage-limits comment pin the gate to
  // rate_limited forever — even after a later HEAD collected a clean ack.
  const result = deriveCommentSignals(
    [
      comment({
        body: "Codex has reached its usage limits for this period.",
        created_at: "2026-07-20T09:00:00Z",
      }),
      comment(),
    ],
    commentAnchors,
  );
  assert.equal(result.rateLimited, false, "the stale non-ack must not fire");
  assert.equal(result.commentAcksHead, true, "the fresh ack on this HEAD stands");
});

test("a usage-limits comment in the HEAD commit's own second still fires", () => {
  const result = deriveCommentSignals(
    [comment({ body: "usage limits reached", created_at: HEAD_COMMITTED_AT })],
    commentAnchors,
  );
  assert.equal(result.rateLimited, true);
});

test("comments from anyone but the bot are ignored entirely", () => {
  const result = deriveCommentSignals(
    [comment({ user: { login: "some-human" } }), comment({ user: { login: BOT_GRAPHQL_LOGIN } })],
    commentAnchors,
  );
  assert.equal(result.botComments.length, 0);
  assert.equal(result.commentAcksHead, false);
});

// -------------------------- citing a sha is not a verdict (R3-4, guard 2)

test("a sha-citing comment WITH findings acks HEAD but asserts nothing about it", () => {
  // The hole: `commentAcksHead` was the whole story, so a findings comment
  // naming HEAD reached ack_clean during the window before its threads
  // materialised. Naming a commit proves Codex looked; it is not a verdict.
  const result = deriveCommentSignals(
    [comment({ body: `**Reviewed commit:** \`${HEAD_SHA_SHORT}\`\n\n3 issues found.` })],
    commentAnchors,
  );
  assert.equal(result.commentAcksHead, true, "it is still a genuine ack of HEAD");
  assert.equal(result.commentAssertsClean, false, "but it says nothing about cleanliness");
  assert.equal(result.cleanVerdictShaComments.length, 0);
});

test("PR #256's real clean shape — ONE comment, both verdict and citation", () => {
  // Verbatim structure of the only bot comment across PRs #247/#250/#253/#256/
  // #259 (surveyed 2026-07-27): the clean pass posts a single comment carrying
  // the verdict AND the sha. Both facts must fire off that one comment.
  const result = deriveCommentSignals(
    [
      comment({
        body: `Codex Review: Didn't find any major issues. :tada:\n\n**Reviewed commit:** \`${HEAD_SHA_SHORT}\``,
      }),
    ],
    commentAnchors,
  );
  assert.equal(result.commentAcksHead, true);
  assert.equal(result.commentAssertsClean, true);
  assert.equal(result.cleanVerdictShaComments.length, 1);
});

test("the sha-cited clean verdict asserts clean at ANY age — the sha is the anchor", () => {
  // Anchor independence is what keeps the escape hatch open when the push
  // anchor is wrong (see derivePushAnchor's third residual). Tightening the
  // cleanliness fact must not smuggle a timestamp back onto this leg.
  const result = deriveCommentSignals(
    [
      comment({
        body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${HEAD_SHA_SHORT}\``,
        created_at: "2020-01-01T00:00:00Z",
      }),
    ],
    commentAnchors,
  );
  assert.equal(result.freshCleanVerdictComments.length, 0, "far too old for the freshness leg");
  assert.equal(result.commentAssertsClean, true, "yet the sha-cited verdict still stands");
});

// ------------------------- age of the acking comment (R3-4, guard 1 input)

test("latestCommentAckAgeMs is the age of the NEWEST acking comment", () => {
  // Newest, because the most recent ack is the one whose threads are likeliest
  // still in flight. Taking the oldest would call a settling PR settled.
  const result = deriveCommentSignals(
    [
      comment({ created_at: "2026-07-27T16:40:00Z" }),
      comment({ created_at: "2026-07-27T16:44:00Z" }),
    ],
    commentAnchors,
  );
  assert.equal(result.ackComments.length, 2);
  assert.equal(result.latestCommentAckAgeMs, 60_000);
});

test("a non-acking comment does not contribute an age", () => {
  const result = deriveCommentSignals(
    [comment({ body: "Codex Review: 3 issues found.", created_at: "2026-07-27T16:44:59Z" })],
    commentAnchors,
  );
  assert.equal(result.commentAcksHead, false);
  assert.equal(result.latestCommentAckAgeMs, Number.POSITIVE_INFINITY);
});

test("a missing nowMs makes the age UNKNOWN, which reads as brand new", () => {
  // Neither NaN nor Infinity. NaN is fail-OPEN and silent (`NaN <
  // settleWindowMs` is false, so it reads as settled); Infinity says the same
  // thing to a `<` test, which is why substituting it did not fix anything — it
  // just made the false pass deliberate-looking. The leg FIRED, so its unknown
  // age has to be the conservative reading, and that is 0.
  const result = deriveCommentSignals([comment()], {
    headShaShort: HEAD_SHA_SHORT,
    ackAnchorMs: HEAD_COMMITTED_AT_MS,
  });
  assert.equal(result.commentAcksHead, true);
  assert.equal(result.latestCommentAckAgeMs, 0);
  assert.equal(result.latestCommentAckAgeUnknown, true);
  assert.equal(Number.isNaN(result.latestCommentAckAgeMs), false);
});

test("a comment leg that did not fire has no unknown age either", () => {
  const result = deriveCommentSignals([], commentAnchors);
  assert.equal(result.latestCommentAckAgeMs, Number.POSITIVE_INFINITY);
  assert.equal(result.latestCommentAckAgeUnknown, false);
});

test("an unparseable created_at on the only ack reads as brand new, never as settled", () => {
  const result = deriveCommentSignals(
    [comment({ body: `**Reviewed commit:** \`${HEAD_SHA_SHORT}\``, created_at: "not-a-date" })],
    commentAnchors,
  );
  assert.equal(result.commentAcksHead, true, "the sha leg needs no timestamp to ACK");
  assert.equal(result.latestCommentAckAgeMs, 0, "but it still cannot be called settled");
});

test("one datable ack among undatable ones is what the age follows", () => {
  // The scan takes the newest PARSEABLE stamp and only falls to 0 when there is
  // none, so a single broken row cannot drag a genuinely settled ack back into
  // the window and stall the merge.
  // Sha-citing bodies, because that is the only ack leg a comment can satisfy
  // with no usable `created_at` — the clean-verdict leg is timestamp-bound and
  // an undated comment never reaches it at all.
  const citation = `**Reviewed commit:** \`${HEAD_SHA_SHORT}\``;
  const result = deriveCommentSignals(
    [
      comment({ body: citation, created_at: "not-a-date" }),
      comment({ body: citation, created_at: "2026-07-27T16:40:00Z" }),
      comment({ body: citation, created_at: null }),
    ],
    commentAnchors,
  );
  assert.equal(result.ackComments.length, 3);
  assert.equal(result.latestCommentAckAgeMs, 300_000);
});

test("a comment matching BOTH ack legs is counted once, not twice", () => {
  const result = deriveCommentSignals(
    [
      comment({
        body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${HEAD_SHA_SHORT}\``,
      }),
    ],
    commentAnchors,
  );
  assert.equal(result.shaCitingComments.length, 1);
  assert.equal(result.freshCleanVerdictComments.length, 1);
  assert.equal(result.ackComments.length, 1, "the same comment must not be double-counted");
});

// ------------------------------------------------------- unresolved threads

function thread({ isResolved = false, isOutdated = false, login = BOT_GRAPHQL_LOGIN } = {}) {
  return { isResolved, isOutdated, comments: { nodes: [{ author: { login }, path: "a.ts" }] } };
}

test("an unresolved thread counts even when the fix push marked it OUTDATED", () => {
  // GitHub's require-conversation-resolution keys on resolution, not on whether
  // the diff position is outdated. Dropping outdated threads reported
  // merge_ok=1 while GitHub reported BLOCKED.
  const result = selectUnresolvedBotThreads([thread({ isOutdated: true })]);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.outdatedCount, 1, "outdated survives as diagnostic metadata only");
});

test("a resolved thread never counts, outdated or not", () => {
  const result = selectUnresolvedBotThreads([
    thread({ isResolved: true, isOutdated: true }),
    thread({ isResolved: true, isOutdated: false }),
  ]);
  assert.equal(result.unresolved.length, 0);
});

test("threads opened by a human are not Codex findings", () => {
  const result = selectUnresolvedBotThreads([thread({ login: "some-human" })]);
  assert.equal(result.unresolved.length, 0);
});

test("thread authors use the GraphQL login form — the REST form matches nothing", () => {
  const result = selectUnresolvedBotThreads([thread({ login: BOT_REST_LOGIN })]);
  assert.equal(result.unresolved.length, 0);
});

test("a mixed thread set counts every unresolved bot thread once", () => {
  const result = selectUnresolvedBotThreads([
    thread(),
    thread({ isOutdated: true }),
    thread({ isResolved: true }),
    thread({ login: "some-human" }),
  ]);
  assert.equal(result.unresolved.length, 2);
  assert.equal(result.outdatedCount, 1);
});

test("an empty or absent thread set is zero, not a throw", () => {
  assert.equal(selectUnresolvedBotThreads([]).unresolved.length, 0);
  assert.equal(selectUnresolvedBotThreads(undefined).unresolved.length, 0);
});

// ------------------------------------------------------------- review ack leg

function review(overrides = {}) {
  return {
    user: { login: BOT_REST_LOGIN },
    commit_id: HEAD_SHA,
    submitted_at: "2026-07-27T16:40:00Z",
    ...overrides,
  };
}

test("the newest HEAD-MATCHING bot review is what anchors the review leg", () => {
  const nowMs = Date.parse("2026-07-27T16:45:00Z");
  const result = deriveReviewAck(
    [review({ commit_id: "olderolder", submitted_at: "2026-07-27T09:00:00Z" }), review()],
    HEAD_SHA,
    nowMs,
  );
  assert.equal(result.reviewAcksHead, true);
  assert.equal(result.botReviews.length, 2, "the full bot set is still reported for display");
  assert.equal(result.headBotReviews.length, 1, "but only one names HEAD");
  assert.equal(result.latestReviewAgeMs, 300_000);
});

test("newest is decided by submitted_at, NOT by array position", () => {
  // The hazard `at(-1)` carried: it trusts the endpoint's ordering and the page
  // merge to preserve it. BOTH reviews here name HEAD, so the filter cannot mask
  // a positional pick — the newest is first in the array, and a positional read
  // would take the stale one's age.
  const result = deriveReviewAck(
    [
      review({ submitted_at: "2026-07-27T16:40:00Z" }),
      review({ submitted_at: "2026-07-27T09:00:00Z" }),
    ],
    HEAD_SHA,
    Date.parse("2026-07-27T16:45:00Z"),
  );
  assert.equal(result.reviewAcksHead, true);
  assert.equal(result.headBotReviews.length, 2);
  assert.equal(result.latestReviewAgeMs, 300_000, "the age must follow the newest review");
});

test("selectNewestReview keeps the later position on a tie", () => {
  const first = review({ commit_id: "aaaaaaaaaa" });
  const second = review({ commit_id: "bbbbbbbbbb" });
  assert.equal(selectNewestReview([first, second]), second);
});

test("selectNewestReview falls back to position when no review carries a stamp", () => {
  // Degenerate payload: without timestamps the documented order is the only
  // signal left, so this must degrade to the old behaviour rather than to an
  // arbitrary pick.
  const first = review({ submitted_at: undefined, commit_id: "aaaaaaaaaa" });
  const second = review({ submitted_at: undefined, commit_id: "bbbbbbbbbb" });
  assert.equal(selectNewestReview([first, second]), second);
});

test("selectNewestReview ignores an unparseable stamp in favour of a real one", () => {
  const real = review({ submitted_at: "2026-07-27T09:00:00Z", commit_id: "aaaaaaaaaa" });
  const broken = review({ submitted_at: "not a date", commit_id: "bbbbbbbbbb" });
  assert.equal(selectNewestReview([real, broken]), real);
});

test("selectNewestReview is empty-safe", () => {
  assert.equal(selectNewestReview([]), null);
  assert.equal(selectNewestReview(undefined), null);
});

test("a newest review sitting on a pre-fix commit does not ack HEAD", () => {
  // PR #250's shape: four reviews, none on the final HEAD. A reviews-only poll
  // would wait forever.
  const result = deriveReviewAck(
    [review({ commit_id: "0000000000" })],
    HEAD_SHA,
    Date.parse("2026-07-27T16:45:00Z"),
  );
  assert.equal(result.reviewAcksHead, false);
});

test("reviews use the REST login form — the bare form matches nothing", () => {
  const result = deriveReviewAck(
    [review({ user: { login: BOT_GRAPHQL_LOGIN } })],
    HEAD_SHA,
    Date.now(),
  );
  assert.equal(result.botReviews.length, 0);
  assert.equal(result.reviewAcksHead, false);
});

test("no bot review leaves the age at Infinity, which never trips the settle guard", () => {
  const result = deriveReviewAck([], HEAD_SHA, Date.now());
  assert.equal(result.latestReviewAgeMs, Number.POSITIVE_INFINITY);
  assert.equal(computeVerdict(cleanSignals({ latestReviewAgeMs: Infinity })).verdict, "ack_clean");
});

test("a HEAD review with NO submitted_at is undatable, not ancient", () => {
  // R4-1 at its upstream source. The old ternary keyed on `submitted_at` being
  // truthy and fell to Infinity when it was not — the same value that means "no
  // review at all". A review that EXISTS acks HEAD, so the leg fires; what is
  // missing is its age, and Infinity claimed that age was comfortably outside
  // the settle window. The two cases share a value no longer.
  const result = deriveReviewAck([review({ submitted_at: undefined })], HEAD_SHA, Date.now());
  assert.equal(result.reviewAcksHead, true, "the review still acks HEAD");
  assert.equal(result.latestReviewAgeMs, 0, "but its age is unknown, so it reads as brand new");
  // Carried as a fact rather than left to be inferred from the 0: the clamp is
  // lossy, and a consumer that guesses "unknown" from the number would also
  // guess it for a genuine 0ms measurement.
  assert.equal(result.latestReviewAgeUnknown, true);
});

test("a datable HEAD review reports its age as KNOWN", () => {
  const result = deriveReviewAck([review()], HEAD_SHA, Date.parse("2026-07-27T16:45:00Z"));
  assert.equal(result.latestReviewAgeMs, 300_000);
  assert.equal(result.latestReviewAgeUnknown, false);
});

test("no review at all has no unknown age — there is no leg to date", () => {
  const result = deriveReviewAck([], HEAD_SHA, Date.now());
  assert.equal(result.latestReviewAgeMs, Number.POSITIVE_INFINITY);
  assert.equal(result.latestReviewAgeUnknown, false);
});

test("a HEAD review with an UNPARSEABLE submitted_at is undatable too", () => {
  // The nastier half: `"not a date"` is truthy, so the old ternary took the
  // arithmetic branch and returned a raw NaN out of the deriver — which then
  // read as settled at the decision table.
  const result = deriveReviewAck([review({ submitted_at: "not a date" })], HEAD_SHA, Date.now());
  assert.equal(result.reviewAcksHead, true);
  assert.equal(result.latestReviewAgeMs, 0);
  assert.equal(Number.isNaN(result.latestReviewAgeMs), false, "and never a raw NaN");
});

test("a missing nowMs cannot date a review either", () => {
  const result = deriveReviewAck([review()], HEAD_SHA, undefined);
  assert.equal(result.latestReviewAgeMs, 0);
});

test("END TO END: an undatable review on HEAD is held, not merged", () => {
  // The composition R4-1 actually threatened: deriveReviewAck feeds
  // computeVerdict, zero threads are visible, and before the fix this scored
  // ack_clean + merge_ok=1 on a review whose threads could still be in flight.
  const result = verdictForShape({
    reviews: [review({ submitted_at: undefined })],
    threads: [],
    nowMs: COMMENT_NOW_MS,
  });
  assert.equal(result.verdict, "ack_unsettled");
  assert.equal(result.ackAgeUnknown, true);
  assert.equal(result.mergeOk, false);
});

// ------------------------- filter to HEAD, THEN take the newest (R3-2)

test("a HEAD review is found even when an older-head review submits LAST", () => {
  // Overlapping review runs, the one started on the PREVIOUS head finishing
  // second. Taking the newest bot review globally and then testing its
  // commit_id reports NO ack while a review naming HEAD sits in the same
  // payload — and the settle window took the age of the review just rejected.
  const result = deriveReviewAck(
    [
      review({ commit_id: HEAD_SHA, submitted_at: "2026-07-27T16:40:00Z" }),
      review({ commit_id: "0000000000", submitted_at: "2026-07-27T16:44:00Z" }),
    ],
    HEAD_SHA,
    Date.parse("2026-07-27T16:45:00Z"),
  );
  assert.equal(result.reviewAcksHead, true, "the HEAD-matching review decides the ack");
  assert.equal(result.latestReviewAgeMs, 300_000, "and the age is ITS age, not the newer one's");
});

test("the age comes from the newest of the HEAD-matching set", () => {
  const result = deriveReviewAck(
    [
      review({ submitted_at: "2026-07-27T16:30:00Z" }),
      review({ submitted_at: "2026-07-27T16:44:00Z" }),
      review({ commit_id: "0000000000", submitted_at: "2026-07-27T16:44:30Z" }),
    ],
    HEAD_SHA,
    Date.parse("2026-07-27T16:45:00Z"),
  );
  assert.equal(result.headBotReviews.length, 2);
  assert.equal(result.latestReviewAgeMs, 60_000);
});

test("an absent headSha acks nothing, even against a review carrying no commit_id", () => {
  // Filtering on equality alone would pair `undefined === undefined` and invent
  // an ack out of two missing fields — the fail-OPEN direction.
  const result = deriveReviewAck(
    [review({ commit_id: undefined })],
    undefined,
    Date.parse("2026-07-27T16:45:00Z"),
  );
  assert.equal(result.botReviews.length, 1, "the review is still a bot review");
  assert.equal(result.reviewAcksHead, false, "but it acks no head");
  assert.equal(result.latestReviewAgeMs, Number.POSITIVE_INFINITY);
});

// ------------------ end-to-end: the two shapes this repo actually produces

/**
 * Derivations wired together the way codex-gate.mjs wires them, so a change that
 * satisfies one derivation while breaking the composition cannot pass.
 *
 * The shapes below are every one observed in the repo, established by surveying
 * all 48 bot comments rather than the five-PR sample this file used to cite: the
 * clean verdict (36 comments), the findings summary posted as a comment body (5),
 * the usage-limits notice (6), and the findings review with inline threads.
 */
function verdictForShape({
  reviews = [],
  reactions = [],
  comments = [],
  threads = [],
  nowMs,
  // Production-normal by default: the gate HAS a usable first sighting, and it
  // coincides with the fallback anchor so nothing is refused for predating it.
  // Defaulting this to "absent" instead would quietly run every end-to-end case
  // through the unvouchable branch — the tests would still pass, for the wrong
  // reason, and would stop modelling the gate they exist to model.
  baselineMs = HEAD_COMMITTED_AT_MS,
}) {
  // Mirrors the gate: the effective floor is the later of the two.
  const ackAnchorMs = Number.isFinite(baselineMs)
    ? Math.max(HEAD_COMMITTED_AT_MS, baselineMs)
    : HEAD_COMMITTED_AT_MS;
  const { botReviews, reviewAcksHead, latestReviewAgeMs, latestReviewAgeUnknown } = deriveReviewAck(
    reviews,
    HEAD_SHA,
    nowMs,
  );
  const { reactionAcksHead } = deriveReactionAck(reactions, ackAnchorMs);
  const {
    botComments,
    commentAcksHead,
    commentAcksHeadBySha,
    commentAssertsClean,
    commentReportsFindings,
    latestCommentAckAgeMs,
    latestCommentAckAgeUnknown,
    rateLimited,
  } = deriveCommentSignals(comments, {
    headShaShort: HEAD_SHA_SHORT,
    ackAnchorMs,
    // Mirrors the gate: the quota notice is a recency signal anchored on the
    // push, not an ack anchored on first sighting.
    freshnessAnchorMs: HEAD_COMMITTED_AT_MS,
    nowMs,
  });
  // The PUSH anchor, mirroring the gate — deliberately not `ackAnchorMs`. See
  // the regression test at the bottom of this file: handing the raised baseline
  // to this detector clips its window to start at first sighting and hides a
  // stale run that landed in the push-to-sighting gap.
  const { staleRunLandedAfterPush } = deriveStaleRunEvidence({
    botReviews,
    botComments,
    headSha: HEAD_SHA,
    headShaShort: HEAD_SHA_SHORT,
    ackAnchorMs: HEAD_COMMITTED_AT_MS,
  });
  const { ackPredatesBaseline } = derivePreBaselineAcks({
    reactions,
    comments,
    headShaShort: HEAD_SHA_SHORT,
    fallbackAnchorMs: HEAD_COMMITTED_AT_MS,
    baselineMs,
  });
  const { unresolved } = selectUnresolvedBotThreads(threads);
  return computeVerdict({
    isDraft: false,
    isOpen: true,
    headUnchanged: true,
    pushAnchorKnown: true,
    observationBaselineKnown: Number.isFinite(baselineMs),
    ackPredatesBaseline,
    rateLimited,
    reviewAcksHead,
    reactionAcksHead,
    commentAcksHead,
    commentAcksHeadBySha,
    commentAssertsClean,
    commentReportsFindings,
    staleRunLandedAfterPush,
    openThreadCount: unresolved.length,
    latestReviewAgeMs,
    latestReviewAgeUnknown,
    latestCommentAckAgeMs,
    latestCommentAckAgeUnknown,
    threadWindowTruncated: false,
    checkWindowTruncated: false,
    ciStatus: "green",
    mergeStateStatus: "CLEAN",
  });
}

test("PR #256's clean shape still merges once settled", () => {
  // ONE bot comment carrying both the verdict and the sha, and NO review on
  // HEAD. This is the shape the whole gate has to keep passing; every tightening
  // in this file is measured against it.
  const result = verdictForShape({
    comments: [
      comment({
        body: `Codex Review: Didn't find any major issues. :tada:\n\n**Reviewed commit:** \`${HEAD_SHA_SHORT}\``,
        created_at: "2026-07-27T16:40:00Z",
      }),
    ],
    nowMs: Date.parse("2026-07-27T16:45:00Z"),
  });
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("PR #256's clean shape is held inside the settle window", () => {
  const result = verdictForShape({
    comments: [
      comment({
        body: `Codex Review: Didn't find any major issues. :tada:\n\n**Reviewed commit:** \`${HEAD_SHA_SHORT}\``,
        created_at: "2026-07-27T16:40:00Z",
      }),
    ],
    nowMs: Date.parse("2026-07-27T16:40:05Z"),
  });
  assert.equal(result.verdict, "ack_unsettled");
  assert.equal(result.mergeOk, false);
});

test("PR #259's findings shape still reports ack_with_findings", () => {
  // A review whose commit_id is HEAD, with inline threads open. No bot comment
  // is involved. This is one of the TWO ways findings arrive; the other is a
  // summary comment with no thread at all, covered below.
  const result = verdictForShape({
    reviews: [review({ submitted_at: "2026-07-27T16:40:00Z" })],
    threads: [thread(), thread({ isOutdated: true })],
    nowMs: Date.parse("2026-07-27T16:45:00Z"),
  });
  assert.equal(result.verdict, "ack_with_findings");
  assert.equal(result.mergeOk, false);
});

test("the findings review with its threads not yet materialised is held, not merged", () => {
  // Same review, zero visible threads — the original race, end to end.
  const result = verdictForShape({
    reviews: [review({ submitted_at: "2026-07-27T16:40:00Z" })],
    threads: [],
    nowMs: Date.parse("2026-07-27T16:40:05Z"),
  });
  assert.equal(result.verdict, "ack_unsettled");
  assert.equal(result.unsettledAckLeg, "review");
  assert.equal(result.mergeOk, false);
});

// ------------- findings delivered as a comment body (the PR #28 shape)

/**
 * The first 420 bytes of the real PR #28 comment, copied verbatim from the API
 * (comment 4365201840, 2026-05-03T02:18:54Z).
 *
 * Held as a real payload rather than a hand-written fixture on purpose: a
 * fixture written to match the classifier proves only that the author can copy a
 * regex twice. The emoji is U+1F4A1 and the sha appears solely inside a blob
 * permalink — both are properties of the live comment, and both are what the
 * classifier has to survive.
 */
const PR28_FINDINGS_SHA = "f67a7bba0a28b5bdbd6003f649d91fcb0d91e906";
const PR28_FINDINGS_BODY =
  "\n### 💡 Codex Review\n\n" +
  `https://github.com/Sawmonabo/ai-sidekicks/blob/${PR28_FINDINGS_SHA}` +
  "/.claude/skills/plan-execution/scripts/preflight.mjs#L102\n" +
  "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  " +
  "Parse all declared precondition blocks before gating phases**\n\n" +
  "`gatePreconditions` silently skips dependency checks when the fenced block is not matched.";

const pr28Anchors = {
  headShaShort: PR28_FINDINGS_SHA.slice(0, 10),
  ackAnchorMs: Date.parse("2026-05-03T02:11:29Z"),
  nowMs: Date.parse("2026-05-03T02:25:00Z"),
};

test("the real PR #28 findings comment is recognised as findings against HEAD", () => {
  const result = deriveCommentSignals(
    [comment({ body: PR28_FINDINGS_BODY, created_at: "2026-05-03T02:18:54Z" })],
    pr28Anchors,
  );
  assert.equal(result.commentReportsFindings, true, "the live body must classify as findings");
  assert.equal(result.commentAcksHead, true, "and it is an ack — Codex demonstrably read HEAD");
  assert.equal(result.commentAssertsClean, false, "but it asserts nothing about cleanliness");
  assert.equal(result.shaCitingComments.length, 0, "it carries no 'Reviewed commit' line at all");
});

test("a findings summary naming an OLDER sha is stale and acks nothing", () => {
  // PR #235's shape: the author pushed 108s before the summary landed, so the
  // permalink sha is no longer HEAD. Firing here would pin the gate to findings
  // against a commit that has already been rewritten.
  const result = deriveCommentSignals(
    [comment({ body: PR28_FINDINGS_BODY, created_at: "2026-05-03T02:18:54Z" })],
    { ...pr28Anchors, headShaShort: "0123456789" },
  );
  assert.equal(result.commentReportsFindings, false);
  assert.equal(result.commentAcksHead, false);
});

test("the heading alone is a sufficient findings marker", () => {
  // The two markers are accepted as a disjunction because they fail
  // independently — an upstream badge or severity-scheme change must not take
  // detection with it. This is that claim, tested rather than asserted.
  const result = deriveCommentSignals(
    [
      comment({
        body: `### 💡 Codex Review\n\n.../blob/${HEAD_SHA}/x.md#L1\n\nsomething is wrong`,
      }),
    ],
    commentAnchors,
  );
  assert.equal(result.commentReportsFindings, true, "no badge in this body, heading only");
});

test("the badge alone is a sufficient findings marker", () => {
  const result = deriveCommentSignals(
    [comment({ body: `.../blob/${HEAD_SHA}/x.md#L1\n\n![P1 Badge](x)  something is wrong` })],
    commentAnchors,
  );
  assert.equal(result.commentReportsFindings, true, "no heading in this body, badge only");
});

test("clean verdicts and usage-limits notices are never findings", () => {
  // The phantom direction. Surveyed live: neither marker appears on any of the
  // 36 clean verdicts or the 6 usage-limits notices in the repo.
  const clean = deriveCommentSignals([comment()], commentAnchors);
  assert.equal(clean.commentReportsFindings, false);
  const rateLimited = deriveCommentSignals(
    [comment({ body: "Codex has reached its usage limits for now." })],
    commentAnchors,
  );
  assert.equal(rateLimited.commentReportsFindings, false);
});

test("repeated findings summaries dedupe by identity, not by body text", () => {
  // PR #218 posted three byte-identical summaries 17 seconds apart. They are
  // three separate comments, so all three are acks; the Set exists to stop ONE
  // comment counting twice when it lands in two legs at once.
  const body = `### 💡 Codex Review\n\n.../blob/${HEAD_SHA}/x.md#L1\n![P1 Badge](x)`;
  const result = deriveCommentSignals(
    [
      comment({ body, created_at: "2026-07-27T16:40:00Z" }),
      comment({ body, created_at: "2026-07-27T16:40:17Z" }),
      comment({ body, created_at: "2026-07-27T16:40:31Z" }),
    ],
    commentAnchors,
  );
  assert.equal(result.findingsShaComments.length, 3, "all three are findings");
  assert.equal(result.ackComments.length, 3, "distinct objects, so all three are distinct acks");
  assert.equal(result.commentReportsFindings, true);
});

test("an empty headShaShort cites nothing — no ack invented from a missing field", () => {
  // `"anything".includes("")` is true, so an unset head would make EVERY bot
  // comment a sha citation. Fail-OPEN, and the same hole deriveReviewAck guards.
  const result = deriveCommentSignals(
    [comment({ body: PR28_FINDINGS_BODY }), comment({ body: "**Reviewed commit:** `abc`" })],
    { ...commentAnchors, headShaShort: "" },
  );
  assert.equal(result.commentReportsFindings, false);
  assert.equal(result.shaCitingComments.length, 0);
  assert.equal(result.commentAcksHead, false);
});

test("an unrecognised comment body asserts nothing — CLEAN fails closed", () => {
  // The clean assertion requires a POSITIVE match, so a shape nobody anticipated
  // reads as "not clean" rather than as "clean by default".
  const result = deriveCommentSignals(
    [comment({ body: "Codex has some thoughts about this one, expressed in a novel format." })],
    commentAnchors,
  );
  assert.equal(result.commentAssertsClean, false);
  assert.equal(result.commentReportsFindings, false);
  assert.equal(result.commentAcksHead, false);
});

test("PR #28's comment-only findings pass reports findings, not no_ack_yet", () => {
  // The defect end to end. Every ack leg was false for the 8 minutes that sha was
  // HEAD — no review on it, the only +1 two hours later — so the gate said
  // "Codex has not looked at this yet" about a commit carrying a filed P1.
  const result = verdictForShape({
    comments: [
      comment({
        body: PR28_FINDINGS_BODY.replace(PR28_FINDINGS_SHA, HEAD_SHA),
        created_at: "2026-07-27T16:40:00Z",
      }),
    ],
    nowMs: COMMENT_NOW_MS,
  });
  assert.equal(result.verdict, "ack_findings_no_threads");
  assert.notEqual(result.verdict, "no_ack_yet", "the state Codex has not looked at is different");
  assert.equal(result.ackOfHead, true);
  assert.equal(result.cleanAssertingAck, false);
  assert.equal(result.mergeOk, false);
});

test("comment-borne findings outrank the settle window", () => {
  // Zero threads inside the window would normally be `ack_unsettled` — waiting to
  // tell "clean" from "threads still materialising". The findings are already in
  // hand, so there is nothing left to wait for.
  const result = verdictForShape({
    comments: [
      comment({
        body: PR28_FINDINGS_BODY.replace(PR28_FINDINGS_SHA, HEAD_SHA),
        created_at: "2026-07-27T16:40:00Z",
      }),
    ],
    nowMs: Date.parse("2026-07-27T16:40:05Z"),
  });
  assert.equal(result.verdict, "ack_findings_no_threads");
  assert.equal(result.mergeOk, false);
});

test("a sha-citing findings comment cannot merge with the window fully expired", () => {
  // The shape with no second line of defence: zero threads means
  // require-conversation-resolution has nothing to hold, so GitHub would allow
  // this merge and only the gate refuses it. Settled by an hour, so the settle
  // window is provably not what does the refusing.
  const result = verdictForShape({
    comments: [
      comment({
        body: `**Reviewed commit:** \`${HEAD_SHA_SHORT}\`\n\n### 💡 Codex Review\n![P2 Badge](x) something is wrong`,
        created_at: "2026-07-27T15:45:00Z",
      }),
    ],
    threads: [],
    nowMs: COMMENT_NOW_MS,
  });
  assert.equal(result.verdict, "ack_findings_no_threads");
  assert.equal(result.mergeOk, false, "merge_ok must be 0 with the window long expired");
  assert.ok(result.threadBearingAckAgeMs > DEFAULT_SETTLE_WINDOW_MS, "and it IS settled");
});

// ---------- a clean verdict for the PREVIOUS head, landing after the push (R4-2)

/**
 * The race, in the order it happens:
 *   16:36:20  HEAD is committed and pushed; the anchor is set here
 *   16:40:00  a Codex run STARTED on the previous head finishes and posts its
 *             clean verdict, naming the commit it actually read
 * The verdict's `created_at` post-dates the anchor, so every timestamp-only
 * predicate accepts it. Moving the anchor cannot help: the ack arrives after the
 * push, not before it. What separates them is that the comment says which commit
 * it read — and it is not this one.
 */
const PREVIOUS_HEAD_SHA_SHORT = "9f3c1d77aa";
const PREVIOUS_HEAD_CLEAN_BODY = `Codex Review: Didn't find any major issues. :tada:\n\n**Reviewed commit:** \`${PREVIOUS_HEAD_SHA_SHORT}\``;

test("a clean verdict naming ANOTHER commit is not a clean ack of HEAD", () => {
  const result = deriveCommentSignals(
    [comment({ body: PREVIOUS_HEAD_CLEAN_BODY, created_at: "2026-07-27T16:40:00Z" })],
    commentAnchors,
  );
  assert.equal(result.freshCleanVerdictComments.length, 0, "fresh by timestamp, but not ours");
  assert.equal(result.otherCommitCleanVerdictComments.length, 1, "and it is counted, not hidden");
  assert.equal(result.commentAssertsClean, false);
  assert.equal(result.commentAcksHead, false, "it acks the PREVIOUS head, not this one");
});

test("CONTROL: the same verdict naming HEAD acks and asserts clean", () => {
  // The single bit under test is which sha the citation carries. Without this
  // the assertion above could be passing because the body was rejected outright.
  const result = deriveCommentSignals(
    [
      comment({
        body: PREVIOUS_HEAD_CLEAN_BODY.replace(PREVIOUS_HEAD_SHA_SHORT, HEAD_SHA_SHORT),
        created_at: "2026-07-27T16:40:00Z",
      }),
    ],
    commentAnchors,
  );
  assert.equal(result.commentAcksHead, true);
  assert.equal(result.commentAssertsClean, true);
  assert.equal(result.otherCommitCleanVerdictComments.length, 0);
});

test("CONTROL: a SHA-LESS clean verdict is untouched — no sha is being required", () => {
  // Ack shape (2) as observed on #120/#121 carries no citation at all, and a
  // no-findings pass often produces no review object either. Requiring a sha
  // would refuse this and stall every clean merge that uses the historical
  // shape; the rule refuses only comments that positively name another commit.
  const result = deriveCommentSignals([comment()], commentAnchors);
  assert.equal(result.commentAcksHead, true);
  assert.equal(result.commentAssertsClean, true);
  assert.equal(result.otherCommitCleanVerdictComments.length, 0);
});

test("an empty headShaShort disqualifies EVERY citation — fail closed", () => {
  // The inverted-sign guard: on the ack legs an absent head must match nothing,
  // here it must match everything, because matching is suspicion rather than
  // acceptance. `"anything".includes("")` is true, so the unguarded form would
  // silently clear every citation instead.
  const result = deriveCommentSignals(
    [comment({ body: PREVIOUS_HEAD_CLEAN_BODY, created_at: "2026-07-27T16:40:00Z" })],
    { ...commentAnchors, headShaShort: "" },
  );
  assert.equal(result.otherCommitCleanVerdictComments.length, 1);
  assert.equal(result.commentAssertsClean, false);
});

test("commentAcksHeadBySha separates the sha-bound acks from the timestamp-bound ones", () => {
  const bySha = deriveCommentSignals(
    [comment({ body: `**Reviewed commit:** \`${HEAD_SHA_SHORT}\`` })],
    commentAnchors,
  );
  assert.equal(bySha.commentAcksHead, true);
  assert.equal(bySha.commentAcksHeadBySha, true);

  const byTimestamp = deriveCommentSignals([comment()], commentAnchors);
  assert.equal(byTimestamp.commentAcksHead, true, "the sha-less clean verdict still acks");
  assert.equal(byTimestamp.commentAcksHeadBySha, false, "but nothing except its stamp binds it");
});

test("a findings summary naming HEAD is sha-bound too", () => {
  const result = deriveCommentSignals(
    [comment({ body: PR28_FINDINGS_BODY.replace(PR28_FINDINGS_SHA, HEAD_SHA) })],
    commentAnchors,
  );
  assert.equal(result.commentAcksHeadBySha, true, "its permalinks carry the sha");
});

// ------------------------------------------------- stale-run evidence (R4-2)

test("a review for a NON-head commit submitted after the anchor is evidence", () => {
  const result = deriveStaleRunEvidence({
    botReviews: [review({ commit_id: "0000000000", submitted_at: "2026-07-27T16:40:00Z" })],
    botComments: [],
    headSha: HEAD_SHA,
    headShaShort: HEAD_SHA_SHORT,
    ackAnchorMs: HEAD_COMMITTED_AT_MS,
  });
  assert.equal(result.staleRunLandedAfterPush, true);
  assert.equal(result.staleReviews.length, 1);
});

test("CONTROL: the ordinary findings-then-fix flow is NOT evidence", () => {
  // The false-positive that would stall every round-trip PR in the repo. There,
  // the review causes the push, so it predates the anchor by construction; only
  // a review landing AFTER the push has the cross-push signature. If this test
  // ever fails, the gate has started blocking normal work.
  const result = deriveStaleRunEvidence({
    botReviews: [review({ commit_id: "0000000000", submitted_at: "2026-07-27T09:00:00Z" })],
    botComments: [],
    headSha: HEAD_SHA,
    headShaShort: HEAD_SHA_SHORT,
    ackAnchorMs: HEAD_COMMITTED_AT_MS,
  });
  assert.equal(result.staleRunLandedAfterPush, false);
});

test("a review ON head is never its own stale evidence", () => {
  const result = deriveStaleRunEvidence({
    botReviews: [review({ submitted_at: "2026-07-27T16:40:00Z" })],
    botComments: [],
    headSha: HEAD_SHA,
    headShaShort: HEAD_SHA_SHORT,
    ackAnchorMs: HEAD_COMMITTED_AT_MS,
  });
  assert.equal(result.staleRunLandedAfterPush, false);
});

test("a citation naming another commit after the anchor is evidence, and names it", () => {
  // The trace that carries the weight: a clean pass usually posts NO review
  // object, so on the dangerous path — the clean tail — the review trace above
  // is absent and only this one is present.
  const result = deriveStaleRunEvidence({
    botReviews: [],
    botComments: [comment({ body: PREVIOUS_HEAD_CLEAN_BODY, created_at: "2026-07-27T16:40:00Z" })],
    headSha: HEAD_SHA,
    headShaShort: HEAD_SHA_SHORT,
    ackAnchorMs: HEAD_COMMITTED_AT_MS,
  });
  assert.equal(result.staleRunLandedAfterPush, true);
  assert.equal(result.staleCitations.length, 1);
  assert.deepEqual(result.staleCitedShas, [PREVIOUS_HEAD_SHA_SHORT], "for the diagnostic");
});

test("CONTROL: a citation naming HEAD is not evidence of anything stale", () => {
  const result = deriveStaleRunEvidence({
    botReviews: [],
    botComments: [
      comment({
        body: PREVIOUS_HEAD_CLEAN_BODY.replace(PREVIOUS_HEAD_SHA_SHORT, HEAD_SHA_SHORT),
        created_at: "2026-07-27T16:40:00Z",
      }),
    ],
    headSha: HEAD_SHA,
    headShaShort: HEAD_SHA_SHORT,
    ackAnchorMs: HEAD_COMMITTED_AT_MS,
  });
  assert.equal(result.staleRunLandedAfterPush, false);
  assert.deepEqual(result.staleCitedShas, []);
});

test("a stale citation predating the anchor is ordinary history, not a race", () => {
  const result = deriveStaleRunEvidence({
    botReviews: [],
    botComments: [comment({ body: PREVIOUS_HEAD_CLEAN_BODY, created_at: "2026-07-27T09:00:00Z" })],
    headSha: HEAD_SHA,
    headShaShort: HEAD_SHA_SHORT,
    ackAnchorMs: HEAD_COMMITTED_AT_MS,
  });
  assert.equal(result.staleRunLandedAfterPush, false);
});

test("an absent headShaShort makes every fresh citation evidence — fail closed", () => {
  const result = deriveStaleRunEvidence({
    botReviews: [],
    botComments: [
      comment({
        body: PREVIOUS_HEAD_CLEAN_BODY.replace(PREVIOUS_HEAD_SHA_SHORT, HEAD_SHA_SHORT),
        created_at: "2026-07-27T16:40:00Z",
      }),
    ],
    headSha: HEAD_SHA,
    headShaShort: "",
    ackAnchorMs: HEAD_COMMITTED_AT_MS,
  });
  assert.equal(result.staleRunLandedAfterPush, true, "unknown head means everything is suspect");
});

test("a body the sha capture does not fit yields no sha, never a wrong one", () => {
  const result = deriveStaleRunEvidence({
    botReviews: [],
    botComments: [
      comment({ body: "**Reviewed commit:** (redacted)", created_at: "2026-07-27T16:40:00Z" }),
    ],
    headSha: HEAD_SHA,
    headShaShort: HEAD_SHA_SHORT,
    ackAnchorMs: HEAD_COMMITTED_AT_MS,
  });
  assert.equal(result.staleRunLandedAfterPush, true, "the decision does not need the capture");
  assert.deepEqual(result.staleCitedShas, [], "only the diagnostic degrades");
});

test("empty inputs are not evidence and do not throw", () => {
  const result = deriveStaleRunEvidence({
    botReviews: undefined,
    botComments: undefined,
    headSha: HEAD_SHA,
    headShaShort: HEAD_SHA_SHORT,
    ackAnchorMs: HEAD_COMMITTED_AT_MS,
  });
  assert.equal(result.staleRunLandedAfterPush, false);
});

// -------------------- the ack that cannot be attributed to HEAD (R4-2 verdict)

test("a +1 alone cannot be trusted while an older run landed after the push", () => {
  // The reaction leg carries no body at all, so nothing in it distinguishes a
  // pass for THIS commit from the tail of a run for the previous one. Codex
  // flagged only the comment leg; the +1 has identical exposure and is the more
  // common clean ack, so the binding has to cover it.
  const result = computeVerdict(cleanSignals({ staleRunLandedAfterPush: true }));
  assert.equal(result.verdict, "ack_unattributable");
  assert.equal(result.ackOfHead, true, "it IS an ack — the gate just cannot attribute it");
  assert.equal(result.shaBoundAckOfHead, false);
  assert.equal(result.mergeOk, false);
});

test("a sha-less clean verdict alone cannot be trusted either", () => {
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      commentAcksHead: true,
      commentAssertsClean: true,
      latestCommentAckAgeMs: DEFAULT_SETTLE_WINDOW_MS + 1,
      staleRunLandedAfterPush: true,
    }),
  );
  assert.equal(result.verdict, "ack_unattributable");
  assert.equal(result.mergeOk, false);
});

test("CONTROL: with no stale run, the same +1 merges", () => {
  // The bit under test is the evidence, nothing else. Without this control the
  // arm above could be refusing for an unrelated reason.
  const result = computeVerdict(cleanSignals({ staleRunLandedAfterPush: false }));
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("CONTROL: a HEAD-CITING ack clears the ambiguity and merges", () => {
  // The false-NEGATIVE control, and the one this design most needs: a PR that
  // saw a cross-push race must still be mergeable once Codex publishes a verdict
  // naming THIS commit. Without it the new arm could be stalling every such PR
  // permanently and no test would notice.
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      commentAcksHead: true,
      commentAcksHeadBySha: true,
      commentAssertsClean: true,
      latestCommentAckAgeMs: DEFAULT_SETTLE_WINDOW_MS + 1,
      staleRunLandedAfterPush: true,
    }),
  );
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.shaBoundAckOfHead, true);
  assert.equal(result.mergeOk, true);
});

test("CONTROL: a review ON head clears it too — a stale run cannot forge one", () => {
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      reviewAcksHead: true,
      latestReviewAgeMs: DEFAULT_SETTLE_WINDOW_MS + 1,
      staleRunLandedAfterPush: true,
    }),
  );
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("open findings still outrank an attribution gap", () => {
  const result = computeVerdict(
    cleanSignals({ staleRunLandedAfterPush: true, openThreadCount: 2 }),
  );
  assert.equal(result.verdict, "ack_with_findings", "the actionable verdict wins the report");
  assert.equal(result.mergeOk, false);
});

test("the attribution gap outranks the settle window", () => {
  // Waiting is not the remediation here — the stale evidence does not age out
  // and neither does the ack. Reporting `ack_unsettled` would send the operator
  // to wait out a window that was never the obstacle.
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      commentAcksHead: true,
      commentAssertsClean: true,
      latestCommentAckAgeMs: 3_000,
      staleRunLandedAfterPush: true,
    }),
  );
  assert.equal(result.verdict, "ack_unattributable");
});

test("no ack at all stays no_ack_yet — the evidence alone invents nothing", () => {
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      reviewAcksHead: false,
      commentAcksHead: false,
      staleRunLandedAfterPush: true,
    }),
  );
  assert.equal(result.verdict, "no_ack_yet");
});

test("END TO END: the delayed clean verdict plus a stale +1 never merges", () => {
  // The whole of R4-2, composed the way codex-gate.mjs composes it. Before the
  // fix this scored ack_clean and merge_ok=1 for a commit Codex never read:
  // `freshCleanVerdictComments` fed BOTH the ack leg and the cleanliness
  // assertion, and every predicate involved was timestamp-only.
  const result = verdictForShape({
    comments: [comment({ body: PREVIOUS_HEAD_CLEAN_BODY, created_at: "2026-07-27T16:40:00Z" })],
    reactions: [reaction({ created_at: "2026-07-27T16:40:02Z" })],
    nowMs: COMMENT_NOW_MS,
  });
  assert.equal(result.verdict, "ack_unattributable");
  assert.equal(result.mergeOk, false);
});

test("END TO END: the delayed clean verdict ALONE reports no ack of this head", () => {
  // Deliberately not the new arm. With the +1 absent, nothing acks HEAD at all —
  // Codex reviewed the previous commit and has not reported on this one — so
  // `no_ack_yet` is literally true and its `@codex review` remediation is the
  // right one. This is distinct from the round-3 defect, where Codex HAD
  // reviewed HEAD and the gate said it had not.
  const result = verdictForShape({
    comments: [comment({ body: PREVIOUS_HEAD_CLEAN_BODY, created_at: "2026-07-27T16:40:00Z" })],
    nowMs: COMMENT_NOW_MS,
  });
  assert.equal(result.verdict, "no_ack_yet");
  assert.equal(result.ackOfHead, false);
  assert.equal(result.mergeOk, false);
});

test("END TO END: the race resolves once Codex posts a verdict naming HEAD", () => {
  // Both comments are present — the previous head's tail AND this head's real
  // verdict — which is the state the PR reaches by re-polling. The gate must
  // merge here, or the fix has converted a false pass into a permanent stall.
  const result = verdictForShape({
    comments: [
      comment({ body: PREVIOUS_HEAD_CLEAN_BODY, created_at: "2026-07-27T16:40:00Z" }),
      comment({
        body: PREVIOUS_HEAD_CLEAN_BODY.replace(PREVIOUS_HEAD_SHA_SHORT, HEAD_SHA_SHORT),
        created_at: "2026-07-27T16:41:00Z",
      }),
    ],
    reactions: [reaction({ created_at: "2026-07-27T16:40:02Z" })],
    nowMs: COMMENT_NOW_MS,
  });
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("a bare sha citation with no verdict and no findings is still not clean", () => {
  // Settled deliberately, so the settle window is not what saves this either.
  const result = verdictForShape({
    comments: [
      comment({
        body: `**Reviewed commit:** \`${HEAD_SHA_SHORT}\``,
        created_at: "2026-07-27T15:45:00Z",
      }),
    ],
    nowMs: COMMENT_NOW_MS,
  });
  assert.equal(result.verdict, "ack_without_verdict");
  assert.equal(result.mergeOk, false);
});

// ------------------------------------------- observation baseline (R5-1)

const PRE_BASELINE_ANCHORS = {
  headShaShort: HEAD_SHA_SHORT,
  // Stands in for the check-suite floor: on a sha pushed earlier on another
  // branch this is the sha's first visibility ANYWHERE, which is what makes it
  // predate the head update.
  fallbackAnchorMs: Date.parse("2026-07-27T16:00:00Z"),
  baselineMs: Date.parse("2026-07-27T16:30:00Z"),
};

test("R5-1: a +1 between the suite sighting and first sight of HEAD is refused", () => {
  // The exact cross-branch shape. The reaction clears the check-suite anchor —
  // which is why round 5 filed this — and predates the moment this gate first
  // saw the sha as HEAD, so it cannot be a verdict on this head.
  const result = derivePreBaselineAcks({
    reactions: [reaction({ created_at: "2026-07-27T16:15:00Z" })],
    comments: [],
    ...PRE_BASELINE_ANCHORS,
  });
  assert.equal(result.ackPredatesBaseline, true);
  assert.equal(result.preBaselineReactions.length, 1);
});

test("CONTROL: the same +1 AFTER first sight is not refused", () => {
  const result = derivePreBaselineAcks({
    reactions: [reaction({ created_at: "2026-07-27T16:40:00Z" })],
    comments: [],
    ...PRE_BASELINE_ANCHORS,
  });
  assert.equal(result.ackPredatesBaseline, false);
});

test("a +1 older than the FALLBACK anchor is not blamed on the baseline", () => {
  // It was already stale under the previous behaviour, so reporting it here
  // would send the operator to re-trigger over a floor that is not what
  // rejected it. `ack_predates_baseline` has to mean the baseline, and only it.
  const result = derivePreBaselineAcks({
    reactions: [reaction({ created_at: "2026-07-27T09:00:00Z" })],
    comments: [],
    ...PRE_BASELINE_ANCHORS,
  });
  assert.equal(result.ackPredatesBaseline, false);
  assert.equal(result.preBaselineReactions.length, 0);
});

test("a sha-less clean verdict in the same window is refused too", () => {
  const result = derivePreBaselineAcks({
    reactions: [],
    comments: [comment({ created_at: "2026-07-27T16:15:00Z" })],
    ...PRE_BASELINE_ANCHORS,
  });
  assert.equal(result.ackPredatesBaseline, true);
  assert.equal(result.preBaselineCleanComments.length, 1);
});

test("a clean verdict NAMING HEAD is never refused — the sha binds it, not the floor", () => {
  // The escape hatch, at the reconstruction layer. Today's clean-verdict format
  // is this one, so over-reporting here would manufacture stalls on the modern
  // shape while claiming the baseline caused them.
  const result = derivePreBaselineAcks({
    reactions: [],
    comments: [
      comment({
        body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${HEAD_SHA_SHORT}\``,
        created_at: "2026-07-27T16:15:00Z",
      }),
    ],
    ...PRE_BASELINE_ANCHORS,
  });
  assert.equal(result.ackPredatesBaseline, false);
});

test("a clean verdict naming ANOTHER commit is not reported as a baseline refusal", () => {
  // It is disqualified by its own words (the R4-2 leg), so attributing it to the
  // baseline would print the wrong remediation for the right refusal.
  const result = derivePreBaselineAcks({
    reactions: [],
    comments: [comment({ body: PREVIOUS_HEAD_CLEAN_BODY, created_at: "2026-07-27T16:15:00Z" })],
    ...PRE_BASELINE_ANCHORS,
  });
  assert.equal(result.ackPredatesBaseline, false);
});

test("no baseline means no baseline refusal — not a fallback to rejecting everything", () => {
  for (const baselineMs of [null, undefined, Number.NaN]) {
    const result = derivePreBaselineAcks({
      reactions: [reaction({ created_at: "2026-07-27T16:15:00Z" })],
      comments: [comment({ created_at: "2026-07-27T16:15:00Z" })],
      headShaShort: HEAD_SHA_SHORT,
      fallbackAnchorMs: PRE_BASELINE_ANCHORS.fallbackAnchorMs,
      baselineMs,
    });
    assert.equal(result.ackPredatesBaseline, false, String(baselineMs));
  }
});

test("non-bot rows never count as refused acks", () => {
  const result = derivePreBaselineAcks({
    reactions: [reaction({ user: { login: "a-human" }, created_at: "2026-07-27T16:15:00Z" })],
    comments: [comment({ user: { login: "a-human" }, created_at: "2026-07-27T16:15:00Z" })],
    ...PRE_BASELINE_ANCHORS,
  });
  assert.equal(result.ackPredatesBaseline, false);
});

// ------------------------------------------ the baseline store on disk

/** A throwaway state dir; every store test gets its own so none can see another's. */
function withStateDir(run) {
  const stateDir = mkdtempSync(join(tmpdir(), "codex-gate-baseline-"));
  try {
    return run(stateDir);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

const BASELINE_PR = 259;

/**
 * A full sha for a DIFFERENT commit, sharing its prefix with the previous-head
 * fixture above so the two blocks describe the same imagined history. It must
 * differ from HEAD_SHA within the first 12 characters, because that is the width
 * `resolveBaselinePath` puts in the filename.
 */
const OTHER_FULL_SHA = `${PREVIOUS_HEAD_SHA_SHORT}40fbdb98acad7aa6cc37ec3b20997b`;

test("the first sighting is stamped, and reports itself as the first", () => {
  withStateDir((stateDir) => {
    const nowMs = Date.parse("2026-07-27T20:56:24Z");
    const result = observeBaseline({ stateDir, prNumber: BASELINE_PR, headSha: HEAD_SHA, nowMs });
    assert.equal(result.baselineKnown, true);
    assert.equal(result.observedAtMs, nowMs);
    assert.equal(result.firstObservation, true);
    assert.equal(result.baselineError, null);
  });
});

test("a later poll adopts the EARLIER stamp — the floor never ratchets forward", () => {
  // The concurrency case, and the direction matters. If a second run could move
  // the baseline forward it would land on top of an ack that had already
  // arrived, refusing a verdict the first run would have accepted — a stall
  // manufactured by polling twice.
  withStateDir((stateDir) => {
    const firstMs = Date.parse("2026-07-27T20:56:24Z");
    const laterMs = Date.parse("2026-07-27T21:30:00Z");
    observeBaseline({ stateDir, prNumber: BASELINE_PR, headSha: HEAD_SHA, nowMs: firstMs });
    const second = observeBaseline({
      stateDir,
      prNumber: BASELINE_PR,
      headSha: HEAD_SHA,
      nowMs: laterMs,
    });
    assert.equal(second.observedAtMs, firstMs);
    assert.equal(second.firstObservation, false);
    assert.equal(second.baselineKnown, true);
  });
});

test("a different sha on the same PR gets its own baseline", () => {
  withStateDir((stateDir) => {
    const firstMs = Date.parse("2026-07-27T20:00:00Z");
    const secondMs = Date.parse("2026-07-27T21:00:00Z");
    observeBaseline({ stateDir, prNumber: BASELINE_PR, headSha: HEAD_SHA, nowMs: firstMs });
    const other = observeBaseline({
      stateDir,
      prNumber: BASELINE_PR,
      headSha: OTHER_FULL_SHA,
      nowMs: secondMs,
    });
    assert.equal(other.observedAtMs, secondMs);
    assert.equal(other.firstObservation, true);
  });
});

test("a corrupt record is unusable, not silently re-stamped as now", () => {
  // Re-stamping would be the tempting repair and it is the false-merge
  // direction: `now` post-dates every ack on the PR, so the gate would go on
  // to reject genuine acks while reporting a healthy baseline.
  withStateDir((stateDir) => {
    writeFileSync(
      resolveBaselinePath({ stateDir, prNumber: BASELINE_PR, headSha: HEAD_SHA }),
      "{not json",
    );
    const result = observeBaseline({
      stateDir,
      prNumber: BASELINE_PR,
      headSha: HEAD_SHA,
      nowMs: Date.now(),
    });
    assert.equal(result.baselineKnown, false);
    assert.equal(result.observedAtMs, null);
    assert.match(result.baselineError, /unreadable or corrupt/);
  });
});

test("a record naming ANOTHER sha is refused rather than adopted", () => {
  withStateDir((stateDir) => {
    writeFileSync(
      resolveBaselinePath({ stateDir, prNumber: BASELINE_PR, headSha: HEAD_SHA }),
      JSON.stringify({ pr: BASELINE_PR, sha: OTHER_FULL_SHA, observedAtMs: 1 }),
    );
    const result = observeBaseline({
      stateDir,
      prNumber: BASELINE_PR,
      headSha: HEAD_SHA,
      nowMs: Date.now(),
    });
    assert.equal(result.baselineKnown, false);
    assert.match(result.baselineError, /records sha/);
  });
});

test("a record with an unusable timestamp is refused", () => {
  withStateDir((stateDir) => {
    writeFileSync(
      resolveBaselinePath({ stateDir, prNumber: BASELINE_PR, headSha: HEAD_SHA }),
      JSON.stringify({ pr: BASELINE_PR, sha: HEAD_SHA, observedAtMs: "whenever" }),
    );
    const result = observeBaseline({
      stateDir,
      prNumber: BASELINE_PR,
      headSha: HEAD_SHA,
      nowMs: Date.now(),
    });
    assert.equal(result.baselineKnown, false);
    assert.match(result.baselineError, /no usable observedAtMs/);
  });
});

test("a DIRECTORY sitting on the record path is refused, and is a deletable one", () => {
  // Worth pinning because the errno is counter-intuitive. `O_CREAT | O_EXCL`
  // against an existing directory reports EEXIST, not EISDIR — the exclusivity
  // check fires before anything looks at the inode type — so this takes the
  // re-read path and surfaces as an unusable record rather than as an unwritable
  // one. That is the right remediation anyway (delete it), so the classification
  // is correct; it is simply not the one the code shape suggests.
  withStateDir((stateDir) => {
    mkdirSync(resolveBaselinePath({ stateDir, prNumber: BASELINE_PR, headSha: HEAD_SHA }));
    const result = observeBaseline({
      stateDir,
      prNumber: BASELINE_PR,
      headSha: HEAD_SHA,
      nowMs: Date.now(),
    });
    assert.equal(result.baselineKnown, false);
    assert.equal(result.baselineWritable, true, "deletable, so the remediation is to delete it");
    assert.match(result.baselineError, /unreadable or corrupt/);
  });
});

test("a write that fails for any NON-EEXIST reason reports NOT WRITABLE", () => {
  // The two failures need different remediations — delete the file vs repair the
  // path — so the flag has to survive the return rather than collapsing.
  //
  // Provoked with an over-long filename rather than with chmod, deliberately: a
  // permission probe is bypassed when the suite runs as root, which would leave
  // this arm silently unexercised in exactly the environments where nobody is
  // watching. ENAMETOOLONG does not care who is asking.
  withStateDir((stateDir) => {
    const result = observeBaseline({
      stateDir,
      prNumber: "9".repeat(5000),
      headSha: HEAD_SHA,
      nowMs: Date.now(),
    });
    assert.equal(result.baselineKnown, false);
    assert.equal(result.baselineWritable, false);
    assert.match(result.baselineError, /not writable/);
  });
});

test("a state directory that cannot be created is reported, not thrown", () => {
  withStateDir((stateDir) => {
    const blocked = join(stateDir, "a-file");
    writeFileSync(blocked, "not a directory");
    const result = observeBaseline({
      stateDir: join(blocked, "nested"),
      prNumber: BASELINE_PR,
      headSha: HEAD_SHA,
      nowMs: Date.now(),
    });
    assert.equal(result.baselineKnown, false);
    assert.equal(result.baselineWritable, false);
    assert.match(result.baselineError, /not creatable/);
  });
});

// ------------------------------- baseline verdicts in the ladder (R5-1)

test("a refused ack reports ack_predates_baseline, NOT no_ack_yet", () => {
  // The whole point of reconstructing the refused set. `no_ack_yet` tells the
  // operator Codex has not looked; here Codex looked, published, and the gate
  // declined to bind it. The two demand opposite next actions.
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      commentAcksHead: false,
      reviewAcksHead: false,
      ackPredatesBaseline: true,
    }),
  );
  assert.equal(result.verdict, "ack_predates_baseline");
  assert.equal(result.mergeOk, false);
});

test("CONTROL: with nothing refused, the same shape is plain no_ack_yet", () => {
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      commentAcksHead: false,
      reviewAcksHead: false,
      ackPredatesBaseline: false,
    }),
  );
  assert.equal(result.verdict, "no_ack_yet");
});

test("a surviving ack outranks a refused one — the refusal is not sticky", () => {
  // A stale +1 refused by the baseline must not shadow a genuine sha-bound
  // verdict that arrived afterwards, or the gate would stall a clean merge on
  // the strength of an ack it had already discarded.
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      reviewAcksHead: true,
      latestReviewAgeMs: DEFAULT_SETTLE_WINDOW_MS + 1,
      ackPredatesBaseline: true,
    }),
  );
  assert.equal(result.verdict, "ack_clean");
  // ...and it MERGES. This assertion was inverted in review, and the inversion
  // is the interesting part. Refusing the merge here sounds like the
  // conservative choice, but it produced a state the operator cannot act on:
  // verdict `ack_clean`, merge blocked, and no remediation printed, because
  // both remediation blocks key on the two baseline verdict names and neither
  // fires for `ack_clean`. That is a silent block, which this gate treats as a
  // defect regardless of which direction it errs in. The substance is that a
  // review naming THIS commit is dispositive evidence Codex reviewed it, and a
  // discarded `+1` from before the first sighting is not evidence against that.
  assert.equal(result.mergeOk, true);
});

test("REGRESSION: the stale-run window is anchored on the push, not the baseline", () => {
  // The shape that made this a bug rather than a preference, taken from PR #259
  // and reduced. A review for the PREVIOUS head lands 3s after the push; the
  // gate's first sighting is an hour later; a bare +1 arrives after that
  // sighting. If the stale-run detector is handed the raised baseline instead
  // of the push anchor, the review falls below its floor and disappears, the +1
  // clears the floor untouched, and the gate merges on a timestamp-only ack
  // while a run for the previous commit is demonstrably still in flight.
  //
  // Asserted through the detector directly rather than through computeVerdict,
  // because the defect was in which anchor the CALLER passed — a verdict-level
  // test would have kept passing while the gate shipped the wrong argument.
  const pushAnchorMs = HEAD_COMMITTED_AT_MS;
  const baselineMs = pushAnchorMs + 60 * 60 * 1000;
  const staleReviewAtMs = pushAnchorMs + 3_000;

  const staleReviewForPreviousHead = [
    {
      user: { login: BOT_REST_LOGIN },
      commit_id: OTHER_FULL_SHA,
      submitted_at: new Date(staleReviewAtMs).toISOString(),
      state: "COMMENTED",
    },
  ];

  const atPushAnchor = deriveStaleRunEvidence({
    botReviews: staleReviewForPreviousHead,
    botComments: [],
    headSha: HEAD_SHA,
    headShaShort: HEAD_SHA_SHORT,
    ackAnchorMs: pushAnchorMs,
  });
  assert.equal(atPushAnchor.staleRunLandedAfterPush, true);

  // The negative control: the same reviews, read against the raised floor,
  // report nothing. This is what the gate was doing.
  const atBaseline = deriveStaleRunEvidence({
    botReviews: staleReviewForPreviousHead,
    botComments: [],
    headSha: HEAD_SHA,
    headShaShort: HEAD_SHA_SHORT,
    ackAnchorMs: baselineMs,
  });
  assert.equal(atBaseline.staleRunLandedAfterPush, false);
});

test("a timestamp-only ack with no usable baseline cannot be vouched for", () => {
  const result = computeVerdict(cleanSignals({ observationBaselineKnown: false }));
  assert.equal(result.verdict, "ack_baseline_unavailable");
  assert.equal(result.timestampOnlyAckUnvouchable, true);
  assert.equal(result.mergeOk, false);
});

test("an ABSENT baseline signal fails closed exactly as a false one does", () => {
  const signals = cleanSignals();
  delete signals.observationBaselineKnown;
  const result = computeVerdict(signals);
  assert.equal(result.verdict, "ack_baseline_unavailable");
  assert.equal(result.mergeOk, false);
});

test("ESCAPE HATCH: a sha-bound ack merges even with no baseline at all", () => {
  // This is what keeps the strict floor from being a blanket stall. A review on
  // HEAD needs no floor, and every clean verdict Codex has posted since
  // 2026-06-22 carries the sha — so a broken store degrades to the sha-anchored
  // path rather than to nothing.
  const result = computeVerdict(
    cleanSignals({
      observationBaselineKnown: false,
      reactionAcksHead: false,
      reviewAcksHead: true,
      latestReviewAgeMs: DEFAULT_SETTLE_WINDOW_MS + 1,
    }),
  );
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("a sha-CITING comment ack is the other escape hatch", () => {
  const result = computeVerdict(
    cleanSignals({
      observationBaselineKnown: false,
      reactionAcksHead: false,
      commentAcksHead: true,
      commentAcksHeadBySha: true,
      commentAssertsClean: true,
      latestCommentAckAgeMs: DEFAULT_SETTLE_WINDOW_MS + 1,
    }),
  );
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("stale-run evidence outranks a missing baseline when both hold", () => {
  // Both are true statements about the same ack; the one naming a specific
  // commit is the one the operator can act on.
  const result = computeVerdict(
    cleanSignals({ observationBaselineKnown: false, staleRunLandedAfterPush: true }),
  );
  assert.equal(result.verdict, "ack_unattributable");
});

test("visible findings still outrank both baseline verdicts", () => {
  const result = computeVerdict(
    cleanSignals({
      observationBaselineKnown: false,
      ackPredatesBaseline: true,
      openThreadCount: 2,
    }),
  );
  assert.equal(result.verdict, "ack_with_findings");
});

test("END TO END R5-1: a +1 for the previous head, in the cross-branch window", () => {
  // The finding, whole. This sha was pushed on another branch first, so its
  // earliest check suite — and therefore the old anchor — predates the moment it
  // became this PR's HEAD. A +1 acking the PREVIOUS head lands in that window,
  // clears the old anchor, and used to score merge_ok=1 with no review of the
  // update. The first-sighting floor is what refuses it now.
  const result = verdictForShape({
    reactions: [reaction({ created_at: "2026-07-27T16:40:00Z" })],
    baselineMs: Date.parse("2026-07-27T16:50:00Z"),
    nowMs: Date.parse("2026-07-27T17:00:00Z"),
  });
  assert.equal(result.verdict, "ack_predates_baseline");
  assert.equal(result.mergeOk, false);
});

test("END TO END R5-1 CONTROL: the same +1 after first sighting merges", () => {
  // Same shape, one timestamp moved. If this did not merge, the floor would be
  // stalling genuine clean passes rather than catching stale ones.
  const result = verdictForShape({
    reactions: [reaction({ created_at: "2026-07-27T16:55:00Z" })],
    baselineMs: Date.parse("2026-07-27T16:50:00Z"),
    nowMs: Date.parse("2026-07-27T17:00:00Z"),
  });
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("END TO END: a usage-limits notice in the push-to-sighting gap still reports rate_limited", () => {
  // The third floor-conflation instance, and the reason `freshnessAnchorMs`
  // exists. A quota notice is not a claim about any commit, so the ack floor is
  // the wrong question to ask of it. Anchored on first sighting instead, this
  // notice falls below the floor, `rateLimited` goes false, and the gate tells
  // the operator to keep waiting for an ack that cannot arrive until the quota
  // resets — the opposite of the action the notice calls for.
  const result = verdictForShape({
    comments: [
      {
        user: { login: BOT_REST_LOGIN },
        body: "You have hit your usage limits",
        created_at: "2026-07-27T16:36:25Z",
      },
    ],
    baselineMs: Date.parse("2026-07-27T17:36:20Z"),
    nowMs: Date.parse("2026-07-27T17:45:00Z"),
  });
  assert.equal(result.verdict, "rate_limited");
  assert.equal(result.mergeOk, false);
});

test("END TO END: a stale review in the push-to-sighting gap still blocks a later +1", () => {
  // The interaction between the two floors, end to end, and the case that made
  // the anchor split a correctness fix rather than a tidy-up. A run for the
  // PREVIOUS head finishes seconds after the push; the gate does not run until
  // an hour later; a bare +1 lands after that first sighting.
  //
  // Each floor on its own says "merge": the +1 clears the baseline, so nothing
  // is refused as pre-baseline. Only the stale-run detector objects, and only
  // if its window still reaches back to the push. Handing it the raised
  // baseline instead — which is what the gate did until review caught it —
  // hides the review below the floor and this merges on a timestamp-only ack
  // while a previous-head run is demonstrably in flight.
  const result = verdictForShape({
    reviews: [
      review({
        commit_id: OTHER_FULL_SHA,
        submitted_at: "2026-07-27T16:36:23Z",
        state: "COMMENTED",
      }),
    ],
    reactions: [reaction({ created_at: "2026-07-27T17:40:00Z" })],
    baselineMs: Date.parse("2026-07-27T17:36:20Z"),
    nowMs: Date.parse("2026-07-27T17:45:00Z"),
  });
  assert.equal(result.mergeOk, false);
  assert.equal(result.verdict, "ack_unattributable");
});

test("END TO END: a sha-citing clean verdict merges with NO baseline at all", () => {
  // The escape hatch end to end, on today's clean-verdict format. A broken store
  // must degrade to the sha-anchored path, not to a stalled gate.
  const result = verdictForShape({
    comments: [
      comment({
        body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${HEAD_SHA_SHORT}\``,
        created_at: "2026-07-27T16:40:00Z",
      }),
    ],
    baselineMs: Number.NaN,
    nowMs: Date.parse("2026-07-27T17:00:00Z"),
  });
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("END TO END: a bare +1 with no baseline is held, not merged", () => {
  const result = verdictForShape({
    reactions: [reaction({ created_at: "2026-07-27T16:40:00Z" })],
    baselineMs: Number.NaN,
    nowMs: Date.parse("2026-07-27T17:00:00Z"),
  });
  assert.equal(result.verdict, "ack_baseline_unavailable");
  assert.equal(result.mergeOk, false);
});
