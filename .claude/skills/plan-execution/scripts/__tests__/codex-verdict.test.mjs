// node:test suite for lib/codex-verdict.mjs.
// Run via:
//   node --test --experimental-strip-types \
//     '.claude/skills/plan-execution/scripts/__tests__/**/*.test.mjs'
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
import { computeVerdict, DEFAULT_SETTLE_WINDOW_MS } from "../lib/codex-verdict.mjs";
import { cleanSignals } from "./codex-verdict.test-support.mjs";

test("baseline: +1 reaction on green CI is a mergeable clean pass", () => {
  // Also the control for every fail-closed test that flips one default: an
  // unchanged HEAD, an open PR, a known push anchor, no truncation and no stale
  // run are all fixture defaults, so this is what restores the merge for each.
  const result = computeVerdict(cleanSignals());
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.ackOfHead, true);
  assert.equal(result.mergeOk, true);
});

test("RACE: a fresh review on HEAD with no visible threads is NOT clean", () => {
  // Codex submits a findings review at T=0; its threads have not materialized.
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

// ------------------------------------------- an ack of HEAD is not a verdict on HEAD

test("a sha-citing comment alone never reaches ack_clean, even with 0 threads", () => {
  // A findings comment naming HEAD satisfies the ack leg, and before its inline
  // threads materialize the gate sees an ack with zero open threads. Settled here
  // on purpose: the settle window must NOT be what refuses it, or the two guards
  // would be one guard.
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

test("CONTROL: a settled comment ack asserting CLEAN merges on its own", () => {
  // Flips the single bit under test. Without this the assertion above could be
  // passing because of some unrelated conjunct. It is also the past-the-window
  // control for the fresh comment-ack race below, and shows a clean-asserting
  // comment is a valid ack leg with no other leg firing.
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
  // A clean pass posts no HEAD review at all, so a review naming HEAD whose
  // threads are every one resolved is the ordinary post-fix state. Demanding an
  // assertion here would refuse a merge that should go.
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

// ------------------------- the settle window covers BOTH thread-bearing legs

test("RACE: a fresh comment ack with no visible threads is NOT clean", () => {
  // Same race as the review leg, reached through the comment leg. A window scoped
  // to `reviewAcksHead` alone would leave this side open.
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
  // Normalized to Infinity, an ack whose age cannot be measured would read as
  // comfortably OUTSIDE the settle window and score ack_clean + merge_ok=1.
  // Unknown recency is the absence of evidence about when the ack landed, so the
  // window must hold it — exactly as if it had landed this instant.
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
  assert.equal(result.mergeOk, false, "an undatable ack never merges inside the window");
});

test("CONTROL: the same NaN on a NON-firing leg still contributes Infinity", () => {
  // A leg the gate rejected has no standing to shorten the window, so its age —
  // measurable or not — must not pull the minimum down. This control proves the
  // non-firing and undatable-firing cases stay apart.
  const result = computeVerdict(
    cleanSignals({ commentAcksHead: false, latestCommentAckAgeMs: Number.NaN }),
  );
  assert.equal(result.threadBearingAckAgeMs, Number.POSITIVE_INFINITY);
  assert.equal(result.ackAgeUnknown, false, "a leg that did not fire has no unknown age");
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("an undatable REVIEW ack is held by the window too", () => {
  // Same hazard through the other thread-bearing leg. Both are fed by
  // `firingLegAgeMs`, so applying it to one and not the other would leave this
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

test("Infinity on a FIRING leg is unsettled too — no ack is infinitely old", () => {
  // A caller that uses Infinity as a missing-value sentinel hands one in here, and
  // reading it as "infinitely old, therefore settled" would merge inside the window.
  // Infinity stays meaningful only for a leg that did NOT fire, where computeVerdict
  // supplies it directly and never consults the caller's number — the control below.
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

// ---------------------------------------------------------- HEAD moved mid-probe

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

test("an absent headUnchanged signal fails closed WITHOUT claiming a move", () => {
  // A caller that never re-read HEAD saw no move, so `head_moved` would name an
  // event nobody observed — but an unconfirmed head must not authorize a merge
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
  // Nothing is refused for predating the baseline here, so this is also the
  // control for `ack_predates_baseline`: the same shape with a refusal.
  const result = computeVerdict(
    cleanSignals({ reactionAcksHead: false, reviewAcksHead: false, commentAcksHead: false }),
  );
  assert.equal(result.verdict, "no_ack_yet");
  assert.equal(result.ackOfHead, false);
  assert.equal(result.mergeOk, false);
});

test("an empty check rollup is not a pass", () => {
  // "none" means no checks were reported — absence of evidence, not evidence of green.
  const result = computeVerdict(cleanSignals({ ciStatus: "none" }));
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, false);
});

for (const ciStatus of ["red", "pending"]) {
  test(`mergeOk is false when CI is ${ciStatus}`, () => {
    assert.equal(computeVerdict(cleanSignals({ ciStatus })).mergeOk, false);
  });
}

test("advisory mode lets a red CI merge only when no check is marked required", () => {
  // `all-checks` is the mode the deriver reports when the branch has no
  // required check: every check is informational, so on an advisory run a red
  // one is read and fixed forward rather than blocking the merge.
  const advisorySignals = cleanSignals({ ciStatus: "red", ciMode: "all-checks" });
  assert.equal(computeVerdict(advisorySignals, { advisory: true }).mergeOk, true);
  // CONTROL: the same signals without the flag still refuse the merge, so the
  // assertion above is measuring the flag and not a weakened CI conjunct.
  assert.equal(computeVerdict(advisorySignals).mergeOk, false);
  // CONTROL: advisory does not excuse a red check that a required check gates.
  assert.equal(
    computeVerdict(cleanSignals({ ciStatus: "red", ciMode: "required-only" }), { advisory: true })
      .mergeOk,
    false,
  );
});

// -------------------------------------------------------- truncated signals

for (const truncatedSignal of ["threadWindowTruncated", "checkWindowTruncated"]) {
  test(`${truncatedSignal} makes an otherwise-clean PR non-mergeable`, () => {
    // A count the gate cannot vouch for is indistinguishable from a hidden
    // unresolved finding, so truncation feeds the verdict, not just a warning.
    const result = computeVerdict(cleanSignals({ [truncatedSignal]: true }));
    assert.equal(result.verdict, "signal_truncated");
    assert.equal(result.signalTruncated, true);
    assert.equal(result.ackOfHead, true, "the ack legs are unaffected by truncation");
    assert.equal(result.mergeOk, false);
  });
}

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

test("advisory mode does not excuse pending or absent CI", () => {
  for (const ciStatus of ["pending", "none"]) {
    const signals = cleanSignals({ ciStatus, ciMode: "all-checks" });
    assert.equal(computeVerdict(signals, { advisory: true }).mergeOk, false, ciStatus);
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
  // Ack legs satisfied, CI green, no threads. Only `isOpen` distinguishes
  // "ready to merge" from "already merged".
  const result = computeVerdict(cleanSignals({ isOpen: false }));
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.ackOfHead, true);
  assert.equal(result.mergeOk, false);
});

test("isOpen does NOT lean on a merged PR happening to report UNKNOWN", () => {
  // A merged PR reports mergeStateStatus=UNKNOWN, which the merge-state conjunct
  // already refuses — but that is GitHub's behavior, not a documented contract.
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

test("an unknown push anchor is NOT mergeable even on an otherwise-perfect ack", () => {
  const result = computeVerdict(cleanSignals({ pushAnchorKnown: false }));
  assert.equal(result.verdict, "ack_clean", "the ack itself still stands");
  assert.equal(result.mergeOk, false);
});

test("an absent pushAnchorKnown signal fails closed", () => {
  assert.equal(computeVerdict(cleanSignals({ pushAnchorKnown: undefined })).mergeOk, false);
});

// ---------------------------------------- the ack that cannot be attributed to HEAD

test("a +1 alone cannot be trusted while an older run landed after the push", () => {
  // The reaction leg carries no body at all, so nothing in it distinguishes a
  // pass for THIS commit from the tail of a run for the previous one. It has the
  // same exposure as the sha-less clean comment, so the binding covers both.
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

test("CONTROL: a HEAD-CITING ack clears the ambiguity and merges", () => {
  // The false-NEGATIVE control: a PR that saw a cross-push race must still be
  // mergeable once Codex publishes a verdict naming THIS commit. Without it the
  // attribution arm could stall every such PR permanently and no test would notice.
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

// ------------------------------------------------ baseline verdicts in the ladder

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
  // ...and it MERGES. Refusing here would be a silent block: verdict `ack_clean`,
  // merge blocked, and no remediation printed, because both remediation blocks key
  // on the two baseline verdict names. A review naming THIS commit is dispositive,
  // and a discarded `+1` from before the first sighting is not evidence against it.
  assert.equal(result.mergeOk, true);
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
  // HEAD needs no floor, and neither does a clean verdict citing the sha — so a
  // broken store degrades to the sha-anchored path rather than to nothing.
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
