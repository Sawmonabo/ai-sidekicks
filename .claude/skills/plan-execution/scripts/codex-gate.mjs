#!/usr/bin/env node
/**
 * codex-gate.mjs — single-shot Codex review verdict for one PR.
 *
 * Exists because the correct ack predicate has been hand-rolled wrong five times
 * (PR #171, #172, #199 r13, #255, #257). Every one of those monitors watched
 * `pulls/N/reviews` (± issue comments) and treated a zero there as "Codex has not
 * reviewed". A zero on the reviews endpoint is the NORMAL shape of a CLEAN pass:
 * a no-findings verdict arrives as a THUMBS_UP reaction on the PR ISSUE and
 * frequently produces no review object and no comment at all.
 *
 * The three terminal states are modelled here so a caller cannot miss one:
 *   1. findings     — review object whose .commit_id is HEAD, with open threads
 *   2. clean        — +1 reaction on the PR issue, newer than the HEAD commit
 *   3. rate-limited — bot issue comment matching /usage limits/ (NON-ack; stop polling)
 *
 * Prints a human block, then a machine-readable final line:
 *   GATE verdict=<...> ack=<0|1> unresolved=<n> ci=<green|red|pending> merge_ok=<0|1>
 *
 * Exit code is always 0 on a successful probe — the verdict is the payload, not
 * the exit status. Exit 1 means the probe itself failed (bad PR, gh error).
 *
 * Usage: node codex-gate.mjs <pr-number> [--repo owner/name]
 */

import { execFileSync } from "node:child_process";
import process from "node:process";
import {
  checkState,
  computeVerdict,
  deriveCiStatus,
  DEFAULT_SETTLE_WINDOW_MS,
} from "./lib/codex-verdict.mjs";

const BOT_REST_LOGIN = "chatgpt-codex-connector[bot]";
const BOT_GRAPHQL_LOGIN = "chatgpt-codex-connector";
const RATE_LIMIT_PATTERN = /usage limits/i;

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function ghJson(args) {
  const raw = gh(args).trim();
  return raw === "" ? null : JSON.parse(raw);
}

function fail(message) {
  process.stderr.write(`codex-gate: ${message}\n`);
  process.exit(1);
}

const positional = [];
let repository = null;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--repo") {
    repository = process.argv[index + 1];
    index += 1;
  } else {
    positional.push(argument);
  }
}

const pullRequestNumber = positional[0];
if (!pullRequestNumber || !/^\d+$/.test(pullRequestNumber)) {
  fail("usage: node codex-gate.mjs <pr-number> [--repo owner/name]");
}

if (!repository) {
  const inferred = ghJson(["repo", "view", "--json", "nameWithOwner"]);
  repository = inferred?.nameWithOwner;
  if (!repository) fail("could not infer repository; pass --repo owner/name");
}

// ---------------------------------------------------------------- PR + HEAD

const pullRequest = ghJson([
  "pr",
  "view",
  pullRequestNumber,
  "--repo",
  repository,
  "--json",
  "headRefOid,isDraft,mergeStateStatus,state,statusCheckRollup,title",
]);
if (!pullRequest) fail(`PR #${pullRequestNumber} not found in ${repository}`);

const headSha = pullRequest.headRefOid;
const headShaShort = headSha.slice(0, 10);

// The HEAD commit's own timestamp is the anchor a reaction must beat. Using the
// PR's updatedAt instead would let a reaction that predates the latest push
// masquerade as an ack of it — the PR #70 false-pass.
const headCommit = ghJson([
  "api",
  `repos/${repository}/commits/${headSha}`,
  "--jq",
  "{date: .commit.committer.date}",
]);
const headCommittedAt = new Date(headCommit.date);

// ---------------------------------------------------- signal 1: review object

// --paginate is mandatory: the reviews endpoint pages at 30 and on a many-round
// PR the newest review rolls onto page 2+, where an unpaginated `last` returns a
// permanently stale review (PR #199 r8).
const allReviews = ghJson([
  "api",
  `repos/${repository}/pulls/${pullRequestNumber}/reviews`,
  "--paginate",
]);
const botReviews = (allReviews ?? []).filter((review) => review.user?.login === BOT_REST_LOGIN);
const latestBotReview = botReviews.at(-1) ?? null;
const reviewAcksHead = latestBotReview?.commit_id === headSha;

// The review object lands SECONDS BEFORE its threads materialise. Inside that
// window a findings review reads as `review-on-HEAD ∧ zero-open-threads`, which is
// byte-identical to a clean pass — and would score merge_ok=1 on a PR that has
// open findings. So a fresh review with no visible threads is NOT clean; it is
// unsettled, and the caller must poll again.
//
// This guard is deliberately scoped to the REVIEW leg. The reaction leg is
// race-free: a 👍 means "no suggestions", so there are no threads pending
// materialisation behind it, and holding on it would stall every clean merge.
// Decision table lives in lib/codex-verdict.mjs so this branch is testable —
// it is unreachable from live data (see that module's header).
const latestReviewAgeMs = latestBotReview?.submitted_at
  ? Date.now() - new Date(latestBotReview.submitted_at).getTime()
  : Number.POSITIVE_INFINITY;

// -------------------------------------------------- signal 2: +1 on the issue

// REST, not GraphQL: GraphQL `reactions.nodes.user` is User-typed, so a Bot
// reactor deserialises to null and no filter can ever match it.
const allReactions = ghJson([
  "api",
  `repos/${repository}/issues/${pullRequestNumber}/reactions`,
  "-H",
  "Accept: application/vnd.github.squirrel-girl-preview+json",
  "--paginate",
]);
const botThumbsUp = (allReactions ?? []).filter(
  (reaction) => reaction.user?.login === BOT_REST_LOGIN && reaction.content === "+1",
);
const freshThumbsUp = botThumbsUp.filter(
  (reaction) => new Date(reaction.created_at) > headCommittedAt,
);
const reactionAcksHead = freshThumbsUp.length > 0;

// --------------------------------- signal 3: comments (rate limit + verdict)

const allComments = ghJson([
  "api",
  `repos/${repository}/issues/${pullRequestNumber}/comments`,
  "--paginate",
]);
const botComments = (allComments ?? []).filter((comment) => comment.user?.login === BOT_REST_LOGIN);
const rateLimited = botComments.some((comment) => RATE_LIMIT_PATTERN.test(comment.body ?? ""));

// A clean-verdict comment can itself carry `**Reviewed commit:** \`<sha10>\`` —
// a HEAD-anchored ack leg in its own right, but inconsistent, so it is an
// additional disjunct and never the sole thing polled.
const commentAcksHead = botComments.some(
  (comment) => comment.body?.includes(headShaShort) && /Reviewed commit/i.test(comment.body ?? ""),
);

// ------------------------------------------------------- unresolved threads

// last:100, not first:N — unresolved findings are the MOST RECENT threads, so a
// leading window on a thread-heavy PR returns 0 unresolved *falsely* (PR #174 r22:
// first:50 of 76 threads reported 0 while 6 findings were open).
const threadQuery = `
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      reviewThreads(last:100) {
        totalCount
        nodes {
          isResolved
          isOutdated
          comments(first:1) { nodes { author { login } path } }
        }
      }
    }
  }
}`;
const [owner, name] = repository.split("/");
const threadResult = ghJson([
  "api",
  "graphql",
  "-f",
  `query=${threadQuery}`,
  "-F",
  `owner=${owner}`,
  "-F",
  `name=${name}`,
  "-F",
  `number=${pullRequestNumber}`,
]);
const threadContainer = threadResult?.data?.repository?.pullRequest?.reviewThreads;
const threadTotal = threadContainer?.totalCount ?? 0;
const threadNodes = threadContainer?.nodes ?? [];
const openBotThreads = threadNodes.filter(
  (thread) =>
    !thread.isResolved &&
    !thread.isOutdated &&
    thread.comments?.nodes?.[0]?.author?.login === BOT_GRAPHQL_LOGIN,
);
const windowTruncated = threadTotal > threadNodes.length;

// ------------------------------------------------------------------ CI state

// Deduped to the newest run per check name — a superseded CANCELLED row sitting
// beside its real SUCCESS would otherwise read as red. See lib/codex-verdict.mjs.
const rawChecks = pullRequest.statusCheckRollup ?? [];
const {
  status: ciStatus,
  failed: failedChecks,
  pending: pendingChecks,
  considered: checks,
} = deriveCiStatus(rawChecks);
const supersededCount = rawChecks.length - checks.length;

// ------------------------------------------------------------------ verdict

const { verdict, ackOfHead, mergeOk } = computeVerdict({
  isDraft: pullRequest.isDraft,
  rateLimited,
  reviewAcksHead,
  reactionAcksHead,
  commentAcksHead,
  openThreadCount: openBotThreads.length,
  latestReviewAgeMs,
  ciStatus,
  settleWindowMs: DEFAULT_SETTLE_WINDOW_MS,
});

// ------------------------------------------------------------------- output

const lines = [
  `PR #${pullRequestNumber} — ${pullRequest.title}`,
  `  repo            ${repository}`,
  `  HEAD            ${headShaShort}  committed ${headCommittedAt.toISOString()}`,
  `  draft           ${pullRequest.isDraft}   mergeState ${pullRequest.mergeStateStatus}`,
  "",
  "  ack legs (disjunction — any one is a valid ack of HEAD):",
  `    review .commit_id == HEAD   ${reviewAcksHead ? "YES" : "no "}   (${botReviews.length} bot review(s) total)`,
  `    +1 on issue newer than HEAD ${reactionAcksHead ? "YES" : "no "}   (${botThumbsUp.length} bot +1 total, ${freshThumbsUp.length} fresh)`,
  `    comment cites HEAD sha      ${commentAcksHead ? "YES" : "no "}   (${botComments.length} bot comment(s) total)`,
  "",
  `  open bot threads  ${openBotThreads.length}  (of ${threadTotal} total threads)`,
  `  CI                ${ciStatus}  (${checks.length} checks, ${failedChecks.length} failed, ${pendingChecks.length} pending${supersededCount > 0 ? `, ${supersededCount} superseded run(s) ignored` : ""})`,
];

if (windowTruncated) {
  lines.push(
    `  !! thread window truncated: fetched ${threadNodes.length} of ${threadTotal} — widen before trusting the unresolved count`,
  );
}
if (failedChecks.length > 0) {
  for (const check of failedChecks) {
    lines.push(`  !! failed check: ${check.name ?? check.context} = ${checkState(check)}`);
  }
}
if (rateLimited) {
  lines.push("  !! Codex reports usage limits reached — NON-ack terminal, stop polling");
}
if (verdict === "no_ack_yet") {
  lines.push(
    "  -> no ack of current HEAD yet. Past ~15 min, comment '@codex review' to trigger manually.",
  );
}
if (verdict === "ack_with_findings") {
  lines.push("  -> reply BEFORE resolve on each open thread, then re-push and re-gate.");
}
if (verdict === "ack_unsettled") {
  lines.push(
    `  !! review on HEAD is ${Math.round(latestReviewAgeMs / 1000)}s old with 0 visible threads —`,
  );
  lines.push(
    "     cannot distinguish 'clean' from 'threads not yet materialised'. Re-poll; do NOT merge.",
  );
}

lines.push("");
lines.push(
  `GATE verdict=${verdict} ack=${ackOfHead ? 1 : 0} unresolved=${openBotThreads.length} ci=${ciStatus} merge_ok=${mergeOk ? 1 : 0}`,
);

process.stdout.write(`${lines.join("\n")}\n`);
