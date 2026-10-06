// The exhaustive sweep over computeVerdict: every combination of its signals, checked for
// the mergeOk invariant and for every verdict arm being reachable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVerdict, DEFAULT_SETTLE_WINDOW_MS } from "../lib/codex-verdict.mjs";
import { MERGEABLE_MERGE_STATES } from "../lib/merge-readiness.mjs";

/**
 * Every combination of the named dimensions, STREAMED rather than materialized.
 *
 * The space is millions of objects wide; building it as one array would multiply
 * resident memory with each dimension. Streaming keeps one combination live at a
 * time, which keeps a dimension affordable to add — and adding dimensions is how
 * the two invariants below stay honest.
 */
function* cartesianProduct(dimensions) {
  const dimensionEntries = Object.entries(dimensions);
  // An odometer rather than recursive `yield*` delegation: delegation spreads a
  // fresh partial at every one of the ~19 levels, so it allocates ~19 objects per
  // combination and bubbles each result up through as many generator frames. The
  // odometer allocates exactly one.
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
 * CLOSED, and a space built only from recognized values cannot tell "refuses
 * unknown input" apart from "was never asked".
 *
 * Both age dimensions carry `NaN` for the same reason. An age that cannot be
 * measured is invisible to a space built only from measurable ages — the sweep
 * would range over "fresh" and "settled" and never over "unknown", the third
 * state and the one that can fail open.
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
  ciStatus: ["green", "red", "pending", "none", "unrecognized-ci-status"],
  mergeStateStatus: ["CLEAN", "UNSTABLE", "BLOCKED", "UNKNOWN", "DIRTY", undefined],
};

/**
 * A SECOND, focused space for the two observation-baseline signals, chained onto
 * the one above rather than folded into it.
 *
 * Folding them in would take the primary space from 8,847,360 combinations to
 * 35,389,440 and roughly quadruple the suite's run time. The signals do not need
 * that reach. Everything they interact with is an ack-leg
 * dimension plus the settle inputs, so a full cartesian over exactly those —
 * 9,216 combinations — covers the interaction completely, and the primary sweep
 * still ranges over CI, merge state, drafts and truncation independently.
 *
 * The non-ack dimensions are pinned to MERGEABLE values on purpose. A focused
 * space whose CI is red would exercise the ladder but could never reach a
 * merge, so the mergeOk invariant would pass over it vacuously — the one thing
 * this space exists to prevent.
 *
 * Note what the PRIMARY space proves as a side effect: it never sets
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
    // load-bearing. The unscoped form would require blocking that merge.
    assert.equal(result.ackOfHead, true, where);

    // The settle window covers BOTH thread-bearing legs, so whichever of them
    // fired has to be outside it. A window scoped to the review leg alone would let
    // a fresh comment ack merge at age 1_000, and this assertion would fail.
    //
    // These two also catch an undatable firing leg, because `NaN >= X` is false:
    // a firing leg whose age is unmeasurable can only satisfy them by never
    // reaching a merge. Normalizing it to Infinity fails here rather than passing.
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

test("every verdict arm is reachable, and none falls outside the known set", () => {
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
  // it simply never fires. This table's highest-risk branches are unreachable
  // from any real PR, so live traffic will never be the thing that notices.
  assert.deepEqual(
    [...KNOWN_VERDICTS].filter((verdict) => !observedVerdicts.has(verdict)),
    [],
    "verdict arms no combination in the sweep reaches",
  );
});
