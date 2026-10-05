// The Codex review gate end to end: payload derivations wired into computeVerdict the way
// codex-gate.mjs wires them, over the shapes observed live.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOT_REST_LOGIN,
  deriveCommentSignals,
  derivePreBaselineAcks,
  deriveReactionAck,
  deriveReviewAck,
  deriveStaleRunEvidence,
  selectUnresolvedBotThreads,
} from "../lib/codex-signals.mjs";
import { computeVerdict, DEFAULT_SETTLE_WINDOW_MS } from "../lib/codex-verdict.mjs";
import {
  comment,
  COMMENT_NOW_MS,
  HEAD_COMMITTED_AT_MS,
  HEAD_SHA,
  HEAD_SHA_SHORT,
  OTHER_FULL_SHA,
  PR28_FINDINGS_BODY,
  PR28_FINDINGS_SHA,
  PREVIOUS_HEAD_CLEAN_BODY,
  PREVIOUS_HEAD_SHA_SHORT,
  reaction,
  review,
  thread,
} from "./codex-signals.test-support.mjs";

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
  // reason, and would stop modeling the gate they exist to model.
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
  // the stale-run regression test in codex-signals.anchoring.test.mjs: handing
  // the raised baseline to this detector clips its window to start at first
  // sighting and hides a stale run that landed in the push-to-sighting gap.
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
  // of the gate is measured against it.
  const result = verdictForShape({
    comments: [
      comment({
        body:
          `Codex Review: Didn't find any major issues. ` +
          `:tada:\n\n**Reviewed commit:** \`${HEAD_SHA_SHORT}\``,
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
        body:
          `Codex Review: Didn't find any major issues. ` +
          `:tada:\n\n**Reviewed commit:** \`${HEAD_SHA_SHORT}\``,
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

test("the findings review with its threads not yet materialized is held, not merged", () => {
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

// ------------- findings delivered as a comment body (the PR #28 shape)

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
  // tell "clean" from "threads still materializing". The findings are already in
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
  // The shape with no second line of defense: zero threads means
  // require-conversation-resolution has nothing to hold, so GitHub would allow
  // this merge and only the gate refuses it. Settled by an hour, so the settle
  // window is provably not what does the refusing.
  const result = verdictForShape({
    comments: [
      comment({
        body:
          `**Reviewed commit:** \`${HEAD_SHA_SHORT}\`\n\n### ` +
          `💡 Codex Review\n![P2 Badge](x) something is wrong`,
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

test("END TO END: a usage-limits notice in the push-to-sighting gap is still rate_limited", () => {
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
        body: "You have reached your Codex usage limits for code reviews. Please try again later.",
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
        body:
          `Codex Review: Didn't find any major ` +
          `issues.\n\n**Reviewed commit:** \`${HEAD_SHA_SHORT}\``,
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
