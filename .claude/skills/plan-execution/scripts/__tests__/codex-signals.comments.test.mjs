// Tests for the comment-borne signals in lib/codex-signals.mjs: ack legs, clean and findings
// assertions, the usage-limits notice, and a clean verdict naming another commit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BOT_GRAPHQL_LOGIN, deriveCommentSignals } from "../lib/codex-signals.mjs";
import {
  comment,
  commentAnchors,
  HEAD_COMMITTED_AT,
  HEAD_COMMITTED_AT_MS,
  HEAD_SHA,
  HEAD_SHA_SHORT,
  PR28_FINDINGS_BODY,
  PR28_FINDINGS_SHA,
  pr28Anchors,
  PREVIOUS_HEAD_CLEAN_BODY,
} from "./codex-signals.test-support.mjs";

// --------------------------------------------------------- comment signals

test("a fresh clean-verdict comment is an ack leg in its own right", () => {
  // Ack shape (2), observed on PRs #120 / #121. The gate used to match only
  // "Reviewed commit" + sha, so a clean-comment ack read as no_ack_yet.
  //
  // It is also the control for refusing a clean verdict that names another
  // commit: this shape carries no citation at all, and a no-findings pass often
  // produces no review object either. Requiring a sha would refuse it and stall
  // every clean merge in the historical shape.
  const result = deriveCommentSignals([comment()], commentAnchors);
  assert.equal(result.commentAcksHead, true);
  assert.equal(result.freshCleanVerdictComments.length, 1);
  assert.equal(result.commentAssertsClean, true);
  assert.equal(result.otherCommitCleanVerdictComments.length, 0);
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
    [
      comment({
        body: "You have reached your Codex usage limits for code reviews. Please try again later.",
      }),
    ],
    commentAnchors,
  );
  assert.equal(result.rateLimited, true);
});

test("a security-review usage-limits comment is NOT a rate-limit terminal", () => {
  // The minimal pair of the test above — same freshness, same author, the other
  // reviewer's quota. The bot runs two reviewers off separate quotas; observed
  // on PRs #395 / #396 / #397 (2026-08-31), this exact body posted while the
  // code review ran to Completed with findings. The bare /usage limits/ pattern
  // matched it and parked the gate on rate_limited with those findings unread;
  // only the code-review quota stops the review this gate polls for.
  const result = deriveCommentSignals(
    [
      comment({
        body:
          "You have reached your Codex usage limits " +
          "for security reviews. Please try again later.",
      }),
    ],
    commentAnchors,
  );
  assert.equal(result.rateLimited, false, "security-review quota must not terminate the poll");
});

test("a usage-limits comment from a PRIOR head does NOT pin the gate", () => {
  // computeVerdict gives rate_limited precedence over every ack leg, so an
  // unbounded scan let one historic usage-limits comment pin the gate to
  // rate_limited forever — even after a later HEAD collected a clean ack.
  const result = deriveCommentSignals(
    [
      comment({
        body: "You have reached your Codex usage limits for code reviews. Please try again later.",
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
    [comment({ body: "usage limits for code reviews reached", created_at: HEAD_COMMITTED_AT })],
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
  // materialized. Naming a commit proves Codex looked; it is not a verdict.
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
  // the verdict AND the sha. Both facts must fire off that one comment, and the
  // comment, matching both ack legs, is counted once. It is also the control
  // for a clean verdict naming ANOTHER commit: the cited sha is the only bit
  // that differs.
  const result = deriveCommentSignals(
    [
      comment({
        body:
          `Codex Review: Didn't find any major issues. ` +
          `:tada:\n\n**Reviewed commit:** \`${HEAD_SHA_SHORT}\``,
      }),
    ],
    commentAnchors,
  );
  assert.equal(result.commentAcksHead, true);
  assert.equal(result.commentAssertsClean, true);
  assert.equal(result.cleanVerdictShaComments.length, 1);
  assert.equal(result.otherCommitCleanVerdictComments.length, 0);
  assert.equal(result.shaCitingComments.length, 1);
  assert.equal(result.freshCleanVerdictComments.length, 1);
  assert.equal(result.ackComments.length, 1, "the same comment must not be double-counted");
});

test("the sha-cited clean verdict asserts clean at ANY age — the sha is the anchor", () => {
  // Anchor independence is what keeps the escape hatch open when the push
  // anchor is wrong (see derivePushAnchor's third residual). Tightening the
  // cleanliness fact must not smuggle a timestamp back onto this leg.
  const result = deriveCommentSignals(
    [
      comment({
        body:
          `Codex Review: Didn't find any major ` +
          `issues.\n\n**Reviewed commit:** \`${HEAD_SHA_SHORT}\``,
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

// ------------- findings delivered as a comment body (the PR #28 shape)

test("the real PR #28 findings comment is recognized as findings against HEAD", () => {
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
    [
      comment({
        body: "You have reached your Codex usage limits for code reviews. Please try again later.",
      }),
    ],
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

test("an unrecognized comment body asserts nothing — CLEAN fails closed", () => {
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

// ---------- a clean verdict for the PREVIOUS head, landing after the push (R4-2)

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
