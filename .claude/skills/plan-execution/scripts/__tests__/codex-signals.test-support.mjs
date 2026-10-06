// GitHub payload fixtures for the Codex review gate tests: the head commit, bot reviews,
// reactions, comments and threads, and real comment bodies kept verbatim.

import { BOT_GRAPHQL_LOGIN, BOT_REST_LOGIN } from "../lib/codex-signals.mjs";

/** The head commit every fixture is measured against. */
export const HEAD_COMMITTED_AT = "2026-07-27T16:36:20Z";
export const HEAD_COMMITTED_AT_MS = Date.parse(HEAD_COMMITTED_AT);
export const HEAD_SHA = "cea56e227b54544129a1f55c6cbe2f089bcc9aa5";
export const HEAD_SHA_SHORT = HEAD_SHA.slice(0, 10);

/** A bot `+1` on the PR issue, fresh against the head commit. */
export function reaction(overrides = {}) {
  return {
    user: { login: BOT_REST_LOGIN },
    content: "+1",
    created_at: "2026-07-27T16:40:00Z",
    ...overrides,
  };
}

/** The sha-less clean-verdict comment as Codex posts it (ASCII apostrophe, 0x27). */
export const CLEAN_VERDICT_BODY =
  "Codex Review: Didn't find any major issues. What shall we delve next?";

/** A bot comment carrying the clean verdict, fresh against the head commit. */
export function comment(overrides = {}) {
  return {
    user: { login: BOT_REST_LOGIN },
    body: CLEAN_VERDICT_BODY,
    created_at: "2026-07-27T16:40:00Z",
    ...overrides,
  };
}

/** 5 min after the default comment fixture — well outside the settle window. */
export const COMMENT_NOW_MS = Date.parse("2026-07-27T16:45:00Z");

/** The comment-signal anchors for the head commit. */
export const commentAnchors = {
  headShaShort: HEAD_SHA_SHORT,
  ackAnchorMs: HEAD_COMMITTED_AT_MS,
  nowMs: COMMENT_NOW_MS,
};

/** A review thread, unresolved and opened by the bot unless overridden. */
export function thread({ isResolved = false, isOutdated = false, login = BOT_GRAPHQL_LOGIN } = {}) {
  return { isResolved, isOutdated, comments: { nodes: [{ author: { login }, path: "a.ts" }] } };
}

/** A bot review on the head commit. */
export function review(overrides = {}) {
  return {
    user: { login: BOT_REST_LOGIN },
    commit_id: HEAD_SHA,
    submitted_at: "2026-07-27T16:40:00Z",
    ...overrides,
  };
}

/**
 * The opening of a real findings-summary comment, kept verbatim from the API.
 *
 * A real payload rather than a hand-written fixture, because a fixture written to
 * match the classifier proves only that the author can copy a regex twice. The emoji
 * is U+1F4A1 and the sha appears solely inside a blob permalink, and both are what
 * the classifier has to survive.
 */
export const PR28_FINDINGS_SHA = "f67a7bba0a28b5bdbd6003f649d91fcb0d91e906";
export const PR28_FINDINGS_BODY =
  "\n### 💡 Codex Review\n\n" +
  `https://github.com/Sawmonabo/ai-sidekicks/blob/${PR28_FINDINGS_SHA}` +
  "/.claude/skills/plan-execution/scripts/preflight.mjs#L102\n" +
  "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  " +
  "Parse all declared precondition blocks before gating phases**\n\n" +
  "`gatePreconditions` silently skips dependency checks when the fenced block is not matched.";

/** The comment-signal anchors for the head that findings comment reviewed. */
export const pr28Anchors = {
  headShaShort: PR28_FINDINGS_SHA.slice(0, 10),
  ackAnchorMs: Date.parse("2026-05-03T02:11:29Z"),
  nowMs: Date.parse("2026-05-03T02:25:00Z"),
};

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
export const PREVIOUS_HEAD_SHA_SHORT = "9f3c1d77aa";
export const PREVIOUS_HEAD_CLEAN_BODY =
  `Codex Review: Didn't find any major issues. ` +
  `:tada:\n\n**Reviewed commit:** \`${PREVIOUS_HEAD_SHA_SHORT}\``;

/**
 * A full sha for a DIFFERENT commit, sharing its prefix with the previous-head
 * fixture above so the two blocks describe the same imagined history. It must
 * differ from HEAD_SHA within the first 12 characters, because that is the width
 * `resolveBaselinePath` puts in the filename.
 */
export const OTHER_FULL_SHA = `${PREVIOUS_HEAD_SHA_SHORT}40fbdb98acad7aa6cc37ec3b20997b`;
