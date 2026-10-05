// Tests for how lib/codex-signals.mjs binds timestamp-only acks to HEAD: the push anchor, the
// freshness predicate, the reaction leg, stale-run evidence and acks the baseline refused.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOT_GRAPHQL_LOGIN,
  BOT_REST_LOGIN,
  deriveCommentSignals,
  derivePreBaselineAcks,
  derivePushAnchor,
  deriveReactionAck,
  deriveStaleRunEvidence,
  isAtOrAfter,
} from "../lib/codex-signals.mjs";
import {
  comment,
  HEAD_COMMITTED_AT,
  HEAD_COMMITTED_AT_MS,
  HEAD_SHA,
  HEAD_SHA_SHORT,
  OTHER_FULL_SHA,
  PREVIOUS_HEAD_CLEAN_BODY,
  PREVIOUS_HEAD_SHA_SHORT,
  reaction,
  review,
} from "./codex-signals.test-support.mjs";

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
    {
      user: { login: BOT_REST_LOGIN },
      body: "You have reached your Codex usage limits for code reviews. Please try again later.",
      created_at: stale,
    },
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
  // earlier branch. `max` keeps the previous behavior as the floor.
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

// ------------------------------------------------------- freshness predicate

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
  // It was already stale under the previous behavior, so reporting it here
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
        body:
          `Codex Review: Didn't find any major ` +
          `issues.\n\n**Reviewed commit:** \`${HEAD_SHA_SHORT}\``,
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
