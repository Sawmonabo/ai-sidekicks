// Tests for the review ack leg and the unresolved review threads in lib/codex-signals.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOT_GRAPHQL_LOGIN,
  BOT_REST_LOGIN,
  deriveReviewAck,
  selectNewestReview,
  selectUnresolvedBotThreads,
} from "../lib/codex-signals.mjs";
import { computeVerdict } from "../lib/codex-verdict.mjs";
import { HEAD_SHA, review, thread } from "./codex-signals.test-support.mjs";
import { cleanSignals } from "./codex-verdict.test-support.mjs";

// ------------------------------------------------------- unresolved threads

test("an unresolved thread counts even when the fix push marked it OUTDATED", () => {
  // GitHub's require-conversation-resolution keys on resolution, not on whether
  // the diff position is outdated, so dropping outdated threads would report
  // merge_ok=1 while GitHub reports BLOCKED.
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
  // A positional pick like `at(-1)` trusts the endpoint's ordering and the page
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
  // signal left, so this must degrade to array position rather than to an
  // arbitrary pick.
  const first = review({ submitted_at: undefined, commit_id: "aaaaaaaaaa" });
  const second = review({ submitted_at: undefined, commit_id: "bbbbbbbbbb" });
  assert.equal(selectNewestReview([first, second]), second);
});

test("selectNewestReview ignores an unparseable stamp in favor of a real one", () => {
  const real = review({ submitted_at: "2026-07-27T09:00:00Z", commit_id: "aaaaaaaaaa" });
  const broken = review({ submitted_at: "not a date", commit_id: "bbbbbbbbbb" });
  assert.equal(selectNewestReview([real, broken]), real);
});

test("selectNewestReview is empty-safe", () => {
  assert.equal(selectNewestReview([]), null);
  assert.equal(selectNewestReview(undefined), null);
});

test("a newest review sitting on a pre-fix commit does not ack HEAD", () => {
  // Reviews on earlier commits, none on the final HEAD. A reviews-only poll
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

test("no bot review leaves a known Infinite age, which never trips the settle guard", () => {
  // No review at all has no unknown age either — there is no leg to date.
  const result = deriveReviewAck([], HEAD_SHA, Date.now());
  assert.equal(result.latestReviewAgeMs, Number.POSITIVE_INFINITY);
  assert.equal(result.latestReviewAgeUnknown, false);
  assert.equal(computeVerdict(cleanSignals({ latestReviewAgeMs: Infinity })).verdict, "ack_clean");
});

test("a HEAD review with NO submitted_at is undatable, not ancient", () => {
  // A review that EXISTS acks HEAD, so the leg fires; what is missing is its age.
  // Infinity would mean "no review at all" and read as comfortably outside the
  // settle window, so an undatable review must report 0 instead.
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

test("a HEAD review with an UNPARSEABLE submitted_at is undatable too", () => {
  // `"not a date"` is truthy, so a truthiness check would do the arithmetic and
  // return a raw NaN, which reads as settled at the decision table.
  const result = deriveReviewAck([review({ submitted_at: "not a date" })], HEAD_SHA, Date.now());
  assert.equal(result.reviewAcksHead, true);
  assert.equal(result.latestReviewAgeMs, 0);
  assert.equal(Number.isNaN(result.latestReviewAgeMs), false, "and never a raw NaN");
});

test("a missing nowMs cannot date a review either", () => {
  const result = deriveReviewAck([review()], HEAD_SHA, undefined);
  assert.equal(result.latestReviewAgeMs, 0);
});

// ------------------------------------------ filter to HEAD, THEN take the newest

test("a HEAD review is found even when an older-head review submits LAST", () => {
  // Overlapping review runs, the one started on the PREVIOUS head finishing
  // second. Taking the newest bot review globally and then testing its
  // commit_id would report NO ack while a review naming HEAD sits in the same
  // payload, and would feed the settle window the rejected review's age.
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
