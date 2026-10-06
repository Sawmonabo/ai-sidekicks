/**
 * The verdict decision table for the Codex review gate. Its inputs come from codex-signals.mjs
 * (what Codex said about HEAD) and merge-readiness.mjs (CI and merge state); codex-gate.mjs is the
 * I/O shell around all three.
 *
 * The three are split out from codex-gate.mjs because the branches that matter most cannot be
 * reached from live GitHub data, so a probe against real PRs executes none of
 * them and still reports success:
 *   - the review-landed-before-its-threads race — every findings review in the
 *     repo is followed by a fix push, so no open PR ever exhibits
 *     `review.commit_id === HEAD`;
 *   - the truncation guard — codex-gate.mjs drains both GraphQL connections to
 *     completion, so a live probe never trips it;
 *   - most CI conclusions — this repo's checks report SUCCESS or FAILURE, never
 *     `ACTION_REQUIRED`, `STALE`, `NEUTRAL` or `SKIPPED`;
 *   - the second-granular timestamp collision the freshness predicate turns on,
 *     which no live payload has yet exhibited.
 * Isolating this logic makes every one of them directly constructible, and keeps
 * the ack predicate importable so it is tested rather than re-written per caller.
 */

import { firingLegAgeMs } from "./codex-signals.mjs";
import { mergeStateAllowsMerge } from "./merge-readiness.mjs";

/** Window in which a review's threads may still be materializing. */
export const DEFAULT_SETTLE_WINDOW_MS = 120_000;

/**
 * @typedef {object} CodexSignals
 * @property {boolean} isDraft                 PR is a draft (Codex does not auto-review drafts).
 * @property {boolean} isOpen                  PR state is OPEN — not CLOSED, not MERGED.
 * @property {boolean} headUnchanged           HEAD re-read after every probe still matches the
 *                                             snapshot they used.
 * @property {boolean} pushAnchorKnown         A check suite dated the push, so the ack anchor is
 *                                             server-side.
 * @property {boolean} rateLimited             Bot code-review usage-limits comment at or after the
 *                                             freshness anchor.
 * @property {boolean} reviewAcksHead          A bot review names the HEAD sha in its commit_id.
 * @property {boolean} reactionAcksHead        Bot +1 on the PR issue, at or after the ack anchor.
 * @property {boolean} commentAcksHead         Bot comment citing the HEAD sha, or a fresh clean
 *                                             verdict.
 * @property {boolean} commentAcksHeadBySha    That comment ack names the sha itself, so no
 *                                             timestamp binds it.
 * @property {boolean} commentAssertsClean     A bot comment asserts CLEAN, not merely that it read
 *                                             HEAD.
 * @property {boolean} commentReportsFindings  A bot comment carries findings for HEAD in its own
 *                                             body.
 * @property {boolean} staleRunLandedAfterPush A Codex run for an OLDER commit published after the
 *                                             push anchor.
 * @property {boolean} [observationBaselineKnown] The gate's own first sighting of this sha as HEAD
 *                                                is usable as a floor.
 * @property {boolean} [ackPredatesBaseline]  A timestamp-only ack was refused for predating that
 *                                            first sighting.
 * @property {number}  openThreadCount         Bot threads that are unresolved, outdated or not.
 * @property {number}  latestReviewAgeMs       Age of the newest HEAD-matching bot review; Infinity
 *                                             when none, 0 when undatable.
 * @property {boolean} [latestReviewAgeUnknown]   That review exists but carries no usable
 *                                                timestamp.
 * @property {number}  latestCommentAckAgeMs   Age of the newest acking bot comment; Infinity when
 *                                             none, 0 when undatable.
 * @property {boolean} [latestCommentAckAgeUnknown] That comment ack exists but carries no usable
 *                                                  timestamp.
 * @property {boolean} [threadWindowTruncated] Review-thread connection did not drain fully.
 * @property {boolean} [checkWindowTruncated]  Check-rollup connection did not drain fully.
 * @property {"green"|"red"|"pending"|"none"} ciStatus
 * @property {"required-only"|"all-checks"} [ciMode] Whether any check on the branch is marked
 *                                                   required. Read only under `options.advisory`.
 * @property {string}  [mergeStateStatus]      GitHub's own MergeStateStatus for the PR.
 * @property {number}  [settleWindowMs]
 */

/**
 * @param {CodexSignals} signals
 * @param {{advisory?: boolean}} [options] `advisory: true` lets a RED CI status
 *   pass the CI conjunct when no check on the branch is marked required — every
 *   check is then informational, so a red one is read and fixed forward rather
 *   than blocking the merge. It never excuses pending or absent CI, nor a red
 *   status while a required check exists.
 * @returns {{verdict: string, ackOfHead: boolean, cleanAssertingAck: boolean, mergeOk: boolean,
 *     unsettled: boolean, unsettledAckLeg: "review"|"comment"|null, threadBearingAckAgeMs: number,
 *     ackAgeUnknown: boolean, shaBoundAckOfHead: boolean, ackAttributionAmbiguous: boolean,
 *     timestampOnlyAckUnvouchable: boolean, signalTruncated: boolean}}
 */
export function computeVerdict(signals, options = {}) {
  const settleWindowMs = signals.settleWindowMs ?? DEFAULT_SETTLE_WINDOW_MS;

  const ackOfHead = signals.reviewAcksHead || signals.reactionAcksHead || signals.commentAcksHead;

  // Exactly ONE shape is excluded from carrying a clean verdict: a comment that
  // acks HEAD without asserting HEAD is clean, when it is the ONLY ack. Citing a
  // sha — or filing findings against it — proves Codex read this commit and is
  // silent on what it found, so by itself it can never reach `ack_clean`.
  //
  // A single named exclusion rather than a general "an ack must assert clean"
  // rule, because the general form silently drops any ack leg nobody remembers
  // to add to it. The bare `+1` is the example: Codex uses it to mean "no
  // suggestions", so a general rule would stop every reaction-only clean pass
  // reaching `ack_clean`. The review leg is outside the exclusion for the same
  // reason: a clean pass posts no HEAD review at all, so a review ON head whose
  // threads are all resolved is the ordinary fix-then-resolve-then-merge state.
  const unverdictedCommentIsTheOnlyAck =
    ackOfHead &&
    signals.reviewAcksHead !== true &&
    signals.reactionAcksHead !== true &&
    signals.commentAssertsClean !== true;
  const cleanAssertingAck = ackOfHead && !unverdictedCommentIsTheOnlyAck;

  // The settle window covers every ack leg that can be FOLLOWED by inline
  // threads — the review object and the acking comment — because the race it
  // guards is thread materialization lagging the ack that announces it; a
  // findings-bearing comment can be followed by threads just as a review can.
  // The reaction leg stays out on purpose — a +1 means "no suggestions", so
  // nothing is pending behind it, and gating it would stall every clean merge.
  //
  // The two ways a leg fails to contribute a real age are OPPOSITE and are the
  // reason `firingLegAgeMs` is not applied uniformly. A leg that did NOT fire
  // contributes Infinity, supplied here rather than derived: feeding in the age
  // of a leg the gate REJECTED would let it shorten a window it has no standing
  // in. A leg that DID fire but carries no usable age contributes 0, because an
  // undatable ack is the absence of evidence about recency, not evidence of it;
  // Infinity there would read as "safely outside the window" and score
  // `ack_clean` + `merge_ok=1` before a delayed thread could appear. The
  // derivers already normalize, so this is defense in depth: a caller that hands
  // in a NaN anyway still fails closed here.
  const reviewAckAgeMs = signals.reviewAcksHead
    ? firingLegAgeMs(signals.latestReviewAgeMs)
    : Number.POSITIVE_INFINITY;
  const commentAckAgeMs = signals.commentAcksHead
    ? firingLegAgeMs(signals.latestCommentAckAgeMs)
    : Number.POSITIVE_INFINITY;
  const threadBearingAckAgeMs = Math.min(reviewAckAgeMs, commentAckAgeMs);
  const unsettled = signals.openThreadCount === 0 && threadBearingAckAgeMs < settleWindowMs;

  // Reported because an ack of unknown age is held by the window FOREVER, and
  // the caller must not print "re-poll" at an operator whose re-polls can never
  // clear it. A real 0ms age is possible (second-granular stamps), so the
  // distinction cannot be read off `threadBearingAckAgeMs === 0`, which is why
  // the derivers report the fact rather than leaving it to be inferred from the
  // number they already clamped.
  //
  // The `!Number.isFinite` half is not redundant with the flag: it catches a
  // caller that hands in a raw NaN without one, such as a hand-built signal
  // object or the exhaustive sweep in the tests.
  const legAgeUnknown = (legFired, unknownFlag, ageMs) =>
    Boolean(legFired) && (unknownFlag === true || !Number.isFinite(ageMs));
  const ackAgeUnknown =
    legAgeUnknown(
      signals.reviewAcksHead,
      signals.latestReviewAgeUnknown,
      signals.latestReviewAgeMs,
    ) ||
    legAgeUnknown(
      signals.commentAcksHead,
      signals.latestCommentAckAgeUnknown,
      signals.latestCommentAckAgeMs,
    );

  // An ack that names the head sha in its own payload cannot be produced by a
  // run for any other commit. The two sha-less legs — the `+1` and the fresh
  // clean verdict — rest entirely on `created_at >= anchor`, and a run for the
  // PREVIOUS head that overlaps the push and finishes afterwards satisfies that
  // by construction, so on its own either one can ack a commit Codex never read.
  // While there is positive evidence of such a run (`deriveStaleRunEvidence`)
  // and NO sha-bound ack to corroborate them, the gate cannot attribute the ack
  // to HEAD and refuses to read cleanliness off it.
  const shaBoundAckOfHead =
    signals.reviewAcksHead === true || signals.commentAcksHeadBySha === true;
  const ackAttributionAmbiguous =
    Boolean(ackOfHead) && !shaBoundAckOfHead && signals.staleRunLandedAfterPush === true;

  // The same "is this ack really about HEAD" question asked of the FLOOR rather
  // than of a rival run. A timestamp-only ack is bound to this head by nothing
  // but the anchor, so when the anchor cannot be trusted — no usable
  // first-sighting baseline, because the store was unwritable, corrupt, or
  // recorded another sha — the gate holds no evidence that the ack post-dates
  // this commit becoming HEAD. Compared `!== true` so an absent field is
  // unusable rather than assumed good, which is what keeps a caller that never
  // consulted the store from merging on the fallback anchor alone.
  //
  // Sha-bound acks are exempt by construction and that exemption is what keeps
  // this from being a blanket stall: a review whose `commit_id` is HEAD, or a
  // comment naming the sha, needs no floor at all. A clean verdict in Codex's
  // current format names the sha, so a broken store degrades to the
  // sha-anchored path rather than to nothing.
  const timestampOnlyAckUnvouchable =
    Boolean(ackOfHead) && !shaBoundAckOfHead && signals.observationBaselineKnown !== true;

  // Returned so the caller can say WHICH ack it is waiting on without
  // re-deriving this min and drifting from it.
  const unsettledAckLeg =
    threadBearingAckAgeMs === Number.POSITIVE_INFINITY
      ? null
      : reviewAckAgeMs <= commentAckAgeMs
        ? "review"
        : "comment";

  // Either connection falling short means the counts fed in here are a floor,
  // not a total. A thread count the gate cannot vouch for is indistinguishable
  // from a hidden unresolved finding, which is the exact false-pass this script
  // exists to kill — so truncation is terminal for THIS probe, not a warning.
  const signalTruncated =
    Boolean(signals.threadWindowTruncated) || Boolean(signals.checkWindowTruncated);

  let verdict;
  if (signals.headUnchanged === false) {
    // Outranks everything, because everything else in this object was gathered
    // against a sha that is no longer HEAD — the threads, the acks and the CI
    // status all describe a commit a merge would not land. Named for the cause
    // rather than downgraded to `no_ack_yet`, which would send the operator
    // looking for a missing review that is not the problem.
    verdict = "head_moved";
  } else if (signals.rateLimited) {
    verdict = "rate_limited";
  } else if (signals.isDraft) {
    verdict = "draft_not_eligible";
  } else if (ackOfHead && signals.openThreadCount > 0) {
    // Visible findings outrank truncation: they are already actionable, and
    // both refuse merge_ok, so nothing is lost by reporting the useful one.
    verdict = "ack_with_findings";
  } else if (ackOfHead && signals.commentReportsFindings === true) {
    // Findings exist, but in a comment body rather than in threads — so there is
    // nothing for the operator to resolve and, crucially, nothing for GitHub's
    // require-conversation-resolution to block on. This gate is the only thing
    // standing between that PR and a merge, which is why the state gets its own
    // name instead of sharing `ack_with_findings`: the remediation differs, and
    // a reader who sees `unresolved=0` next to a findings verdict needs to be
    // told where the findings actually are.
    //
    // Ahead of `unsettled` deliberately. The settle window exists to avoid
    // mistaking "threads not yet materialized" for "clean"; here the answer is
    // already in hand, so waiting a window to re-ask a settled question would
    // only delay an actionable report.
    verdict = "ack_findings_no_threads";
  } else if (ackAttributionAmbiguous) {
    // The only ack of HEAD is timestamp-bound, and a Codex run for an older
    // commit published after this push — so that ack is indistinguishable from
    // the older run's tail. Named rather than left to fall through: `no_ack_yet`
    // would claim Codex has not looked (it has, at the wrong commit) and
    // `ack_without_verdict` would claim it published nothing (it published a
    // verdict, just not one this gate can attribute here).
    //
    // Ahead of `unsettled` because the settle window is the wrong question, not
    // because nothing can resolve this. Waiting does not disambiguate
    // attribution — the stale evidence does not age out and neither does the
    // ack. What clears it is a HEAD-CITING verdict, which a genuine pass for
    // this commit posts in the shape observed today; the remediation is to
    // re-poll for that, and to re-trigger with `@codex review` if it does not
    // come. Reporting `ack_unsettled` instead would send the operator to wait
    // out a window that was never the obstacle.
    verdict = "ack_unattributable";
  } else if (timestampOnlyAckUnvouchable) {
    // Codex acked, the ack carries no sha, and the gate has no trustworthy floor
    // to date it against. Distinct from `ack_unattributable`, which has POSITIVE
    // evidence of a rival run and can name the commit; here there is no evidence
    // either way and the gap is in this gate's own state, so the remediation is
    // to repair the store rather than to chase a Codex run.
    //
    // Ranked below attribution for exactly that reason: when both hold, the
    // stale-run evidence names a specific commit the operator can look at, and a
    // broken store is the less informative of two true statements.
    //
    // Ahead of `unsettled` because no settle window repairs a store, and ahead
    // of `ack_clean` because that is the verdict this refuses to hand out.
    verdict = "ack_baseline_unavailable";
  } else if (unsettled) {
    verdict = "ack_unsettled";
  } else if (ackOfHead && signalTruncated) {
    verdict = "signal_truncated";
  } else if (ackOfHead && !cleanAssertingAck) {
    // Codex named this commit and asserted nothing about it — no clean verdict,
    // and no findings this gate can read. Distinct from `no_ack_yet`, where
    // Codex has not looked at all: here waiting is still right, but the reader
    // is waiting on a verdict rather than on a review.
    //
    // Reached only by a citation with no recognizable body, so it is also where
    // an UNRECOGNIZED comment shape lands — which is the fail-closed direction
    // and the reason this branch sits ahead of `ack_clean` rather than falling
    // through to it. A findings pass carries a marker and lands on the branch
    // above.
    verdict = "ack_without_verdict";
  } else if (ackOfHead) {
    verdict = "ack_clean";
  } else if (signals.ackPredatesBaseline === true) {
    // No ack leg fired, and the reason is this gate's own floor: a timestamp-only
    // ack is sitting on the PR that clears the fallback anchor but predates the
    // first moment this gate saw the sha as HEAD.
    //
    // Last before `no_ack_yet` because it is a strictly more specific account of
    // the same observable state — zero surviving acks — and the general one
    // would misreport it. `no_ack_yet` says Codex has not looked; here Codex
    // looked and published, and the gate refused to bind it. Those demand
    // different actions: one is to keep waiting, the other is that waiting will
    // never help, because Codex does not re-ack a head it has already acked and
    // no future poll moves that timestamp. Only a re-trigger produces an ack this
    // floor can accept.
    //
    // This stall is the accepted cost of the strict floor: seeding the baseline
    // from the fallback anchor on first sight would trade this loud, diagnosable
    // stall for a silent merge on an ack for another commit. See the mergeOk note
    // for why that direction is refused.
    verdict = "ack_predates_baseline";
  } else {
    verdict = "no_ack_yet";
  }

  // ciStatus "none" is an empty gating set — absence of evidence, not a pass.
  // `!signalTruncated` is redundant against the ladder above and deliberately
  // kept: it is the conjunct that survives a future reordering of the verdict
  // branches, the same defense the `unsettled` guard gets from `ack_clean`.
  //
  // `!ackAttributionAmbiguous` is kept for the same reason and NOT by oversight
  // that `unsettled` lacks one. Both are redundant against `verdict ===
  // "ack_clean"` today; the difference is what happens if that stops holding. An
  // unsettled ack resolves itself — the window expires and the next poll is
  // correct — whereas an ack the gate cannot attribute to HEAD only clears if
  // Codex publishes a sha-bound verdict, which it may never do. A reordering
  // that shadowed the truncation arm or this one would convert a permanent
  // uncertainty into a merge; one that shadowed `unsettled` would convert a
  // transient one into a merge two minutes early. The permanent cases get the
  // belt-and-braces conjunct.
  //
  // `isOpen` is NOT redundant against mergeStateStatus. A merged PR reports
  // UNKNOWN, which the last conjunct already refuses, but that is observed GitHub
  // behavior rather than a documented contract, and nothing promises a merged PR
  // will never report CLEAN. Asking the question directly also lets the caller
  // name the real reason instead of blaming a phantom merge requirement.
  // Compared `=== true` so an absent signal fails closed, matching how
  // `mergeStateAllowsMerge` treats an absent merge state.
  //
  // `pushAnchorKnown` is the same shape of question about the freshness anchor.
  // Without a check suite to date the push, the anchor falls back to the
  // author-controlled commit time, and every timestamp-bound ack leg — the +1,
  // the clean-verdict comment, and the usage-limits non-ack — rests on it. A
  // window with no server-side sighting of the sha is usually unmergeable for
  // other reasons too, but only incidentally, so the gate names this cause
  // directly.
  //
  // The two baseline conjuncts are kept on the same permanent-uncertainty
  // rule. Neither clears itself: a broken store stays broken until someone fixes
  // the path, and an ack that predates the first sighting never moves. Both are
  // redundant against `verdict === "ack_clean"` today and both survive a
  // reordering that shadows their arm.
  //
  // `refusedAckIsTheOnlyAck` carries the `!ackOfHead` qualifier because a
  // refused pre-baseline ack only matters when it is WHY no ack survives. If an
  // ack of HEAD did survive — a review whose `commit_id` is this commit, say —
  // that ack is dispositive, and an unrelated stale `+1` nearby is not evidence
  // against it. Blocking on it anyway would leave a state with no way out:
  // verdict `ack_clean`, merge refused, and neither remediation block firing,
  // because both key on the other two verdict names.
  //
  // The alternative, seeding the baseline from the existing anchor on first
  // observation and letting it only ratchet forward, would remove the
  // `ack_predates_baseline` stall entirely, and is refused because the two
  // failure modes are not comparable. Seeding fails by admitting a stale ack on
  // the first gate call for a sha: a SILENT false merge carrying a verdict Codex
  // never gave. The strict floor fails by refusing a genuine ack that predates
  // first sight: a LOUD stall that prints its own remediation.
  //
  // `headUnchanged` is compared `=== true` while the verdict branch above tests
  // `=== false`, and the asymmetry is the point: a caller that never re-read
  // HEAD leaves the field undefined, which must not be reported as a move that
  // was observed, but equally must not authorize a merge on a head nobody
  // confirmed. Undefined therefore names no verdict and grants no merge.
  const refusedAckIsTheOnlyAck = signals.ackPredatesBaseline === true && !ackOfHead;

  const mergeOk =
    verdict === "ack_clean" &&
    signals.isOpen === true &&
    signals.headUnchanged === true &&
    signals.pushAnchorKnown === true &&
    // Advisory mode excuses a red informational check, never a run that has
    // not finished or a branch with no checks at all.
    (signals.ciStatus === "green" ||
      (options.advisory === true &&
        signals.ciMode === "all-checks" &&
        signals.ciStatus === "red")) &&
    signals.openThreadCount === 0 &&
    !signalTruncated &&
    !ackAttributionAmbiguous &&
    !timestampOnlyAckUnvouchable &&
    !refusedAckIsTheOnlyAck &&
    mergeStateAllowsMerge(signals.mergeStateStatus);

  return {
    verdict,
    ackOfHead,
    cleanAssertingAck,
    mergeOk,
    unsettled,
    unsettledAckLeg,
    threadBearingAckAgeMs,
    ackAgeUnknown,
    shaBoundAckOfHead,
    ackAttributionAmbiguous,
    timestampOnlyAckUnvouchable,
    signalTruncated,
  };
}
