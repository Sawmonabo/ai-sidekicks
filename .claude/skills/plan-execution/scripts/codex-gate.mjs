#!/usr/bin/env node
/**
 * codex-gate.mjs — single-shot Codex review verdict for one PR.
 *
 * Exists because the correct ack predicate has been hand-rolled wrong five times
 * (PR #171, #172, #199 r13, #255, #257). Every one of those monitors watched
 * `pulls/N/reviews` (± issue comments) and treated a zero there as "Codex has not
 * reviewed". A zero on the reviews endpoint is the NORMAL shape of a CLEAN pass:
 * a no-findings verdict arrives as a THUMBS_UP reaction on the PR ISSUE and
 * frequently produces no review object at all.
 *
 * The terminal states are modelled here so a caller cannot miss one:
 *   1. findings     — review object whose .commit_id is HEAD, with open threads
 *   2. clean        — +1 reaction on the PR issue, at or after the ack anchor
 *   3. clean        — "Didn't find any major issues" comment, same freshness bind
 *   4. rate-limited — fresh bot comment matching /usage limits/ (NON-ack; stop polling)
 *
 * The ack anchor is the later of the HEAD commit's timestamp and the earliest
 * check suite for that sha — see derivePushAnchor. Commit time alone is
 * author-controlled, so it lets an ack of the PREVIOUS head count for this one.
 *
 * This file is the I/O shell only: it fetches, then prints. Every predicate that
 * decides anything lives in lib/codex-verdict.mjs, where it is unit-tested —
 * see that module's header for why a live probe cannot test them.
 *
 * Prints a human block, then a machine-readable final line:
 *   GATE verdict=<...> ack=<0|1> unresolved=<n> ci=<green|red|pending|none> state=<...> merge_state=<...> merge_ok=<0|1> head_sha=<40-hex>
 *
 * `head_sha` names the commit every other field on that line was measured
 * against. Pass it to `gh pr merge --match-head-commit` so the merge refuses a
 * head that moved after the gate printed.
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
  deriveCommentSignals,
  derivePushAnchor,
  deriveReactionAck,
  deriveReviewAck,
  mergeStateAllowsMerge,
  selectUnresolvedBotThreads,
  DEFAULT_SETTLE_WINDOW_MS,
} from "./lib/codex-verdict.mjs";
import {
  describeTruncation,
  drainConnection,
  flattenSlurpedPages,
  parseGhJson,
} from "./lib/gh-api.mjs";

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function ghJson(args) {
  return parseGhJson(gh(args));
}

/**
 * Run a paginated `gh api` call and return the merged rows.
 *
 * `--slurp` is appended here rather than at the call sites so the `.flat()` that
 * undoes its page wrapping can never be forgotten. It only applies alongside
 * `--paginate`, so the unpaginated calls keep using `ghJson` directly.
 *
 * A call needing server-side filtering cannot come through here: gh refuses
 * `--slurp` with `--jq` outright ("the `--slurp` option is not supported with
 * `--jq` or `--template`", exit 1), so the combination fails loudly at the CLI
 * rather than reaching `flattenSlurpedPages` in a shape it would misread.
 */
function ghJsonPaginated(args) {
  return flattenSlurpedPages(ghJson([...args, "--paginate", "--slurp"]));
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
const [owner, name] = repository.split("/");

/**
 * Run one GraphQL page.
 *
 * `-F` (typed) is used only for `number`, which the schema declares `Int!`.
 * Every other variable goes through `-f` (raw string) so a base64 cursor is
 * never reinterpreted as a number, a boolean, or an `@file` reference.
 */
function graphqlPage(query, stringVariables) {
  const args = ["api", "graphql", "-f", `query=${query}`, "-F", `number=${pullRequestNumber}`];
  for (const [variableName, value] of Object.entries(stringVariables)) {
    if (value === null || value === undefined) continue;
    args.push("-f", `${variableName}=${value}`);
  }
  return ghJson(args);
}

// ---------------------------------------------------------------- PR + HEAD

const pullRequest = ghJson([
  "pr",
  "view",
  pullRequestNumber,
  "--repo",
  repository,
  "--json",
  "headRefOid,isDraft,mergeStateStatus,state,title",
]);
if (!pullRequest) fail(`PR #${pullRequestNumber} not found in ${repository}`);

const headSha = pullRequest.headRefOid;
if (!headSha) {
  fail(`PR #${pullRequestNumber} returned no headRefOid — the gate cannot anchor to a commit`);
}
const headShaShort = headSha.slice(0, 10);

// One half of the ack anchor. Using the PR's updatedAt instead would let a
// reaction that predates the latest push masquerade as an ack of it — the PR #70
// false-pass. The commit timestamp alone is not enough either, because it is
// author-controlled; derivePushAnchor pairs it with the push observation below.
const headCommit = ghJson([
  "api",
  `repos/${repository}/commits/${headSha}`,
  "--jq",
  "{date: .commit.committer.date}",
]);
// Validated rather than trusted, because both failure directions are silent and
// one of them fails OPEN. `new Date(null)` is the EPOCH, not Invalid Date, so a
// field that resolves to null made every `created_at >= anchor` comparison true
// and every stale reaction on the PR acked the current HEAD — measured by
// degrading this very fetch: the gate printed `committed
// 1970-01-01T00:00:00.000Z` and still exited 0. A wholly failed fetch goes the
// other way, to NaN, where nothing can ever ack. A probe that cannot establish
// its own anchor must stop rather than pick a direction to be wrong in.
const headCommittedAtMs = new Date(headCommit?.date ?? Number.NaN).getTime();
if (!Number.isFinite(headCommittedAtMs)) {
  fail(
    `could not read the HEAD commit timestamp for ${headShaShort} (got ${JSON.stringify(headCommit?.date)})`,
  );
}
const headCommittedAt = new Date(headCommittedAtMs);

// Check suites date the PUSH — the moment the sha first became visible
// server-side, which is what an ack actually has to post-date. This is the one
// object-typed paginated endpoint the gate calls: each page is
// `{total_count, check_suites}`, so the slurped pages arrive as page objects
// rather than as rows, and the rows come out of them here.
const checkSuites = ghJsonPaginated([
  "api",
  `repos/${repository}/commits/${headSha}/check-suites`,
]).flatMap((page) => page?.check_suites ?? []);
const {
  anchorMs: ackAnchorMs,
  pushObservedAtMs,
  pushAnchorKnown,
} = derivePushAnchor(headCommittedAtMs, checkSuites);

// ---------------------------------------------------- signal 1: review object

// Pagination is mandatory: the reviews endpoint pages at 30 and on a many-round
// PR the newest review rolls onto page 2+, where an unpaginated `last` returns a
// permanently stale review (PR #199 r8).
const allReviews = ghJsonPaginated([
  "api",
  `repos/${repository}/pulls/${pullRequestNumber}/reviews`,
]);
const { botReviews, reviewAcksHead, latestReviewAgeMs } = deriveReviewAck(
  allReviews,
  headSha,
  Date.now(),
);

// -------------------------------------------------- signal 2: +1 on the issue

// REST, not GraphQL: GraphQL `reactions.nodes.user` is User-typed, so a Bot
// reactor deserialises to null and no filter can ever match it.
const allReactions = ghJsonPaginated([
  "api",
  `repos/${repository}/issues/${pullRequestNumber}/reactions`,
  "-H",
  "Accept: application/vnd.github.squirrel-girl-preview+json",
]);
const { botThumbsUp, freshThumbsUp, reactionAcksHead } = deriveReactionAck(
  allReactions,
  ackAnchorMs,
);

// --------------------------------- signal 3: comments (rate limit + verdict)

const allComments = ghJsonPaginated([
  "api",
  `repos/${repository}/issues/${pullRequestNumber}/comments`,
]);
const {
  botComments,
  shaCitingComments,
  freshCleanVerdictComments,
  cleanVerdictShaComments,
  findingsShaComments,
  commentAcksHead,
  commentAssertsClean,
  commentReportsFindings,
  latestCommentAckAgeMs,
  rateLimited,
} = deriveCommentSignals(allComments, { headShaShort, ackAnchorMs, nowMs: Date.now() });

// ------------------------------------------------------- unresolved threads

// Drained to completion, not windowed. The old `last:100` window existed because
// unresolved findings are the MOST RECENT threads, so a leading `first:N` window
// returns 0 unresolved *falsely* on a thread-heavy PR (PR #174 r22: first:50 of
// 76 threads reported 0 while 6 findings were open). Full pagination retires that
// trade-off entirely — every thread is fetched — and any shortfall against
// totalCount becomes a fail-closed verdict rather than a printed warning that
// never reached the decision.
const REVIEW_THREAD_QUERY = `
query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      reviewThreads(first:100, after:$cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          comments(first:1) { nodes { author { login } path } }
        }
      }
    }
  }
}`;

const threadDrain = drainConnection((cursor) => {
  const page = graphqlPage(REVIEW_THREAD_QUERY, { owner, name, cursor });
  return page?.data?.repository?.pullRequest?.reviewThreads;
});
const {
  nodes: threadNodes,
  totalCount: threadTotal,
  truncated: threadWindowTruncated,
} = threadDrain;

const { unresolved: unresolvedBotThreads, outdatedCount: outdatedUnresolvedCount } =
  selectUnresolvedBotThreads(threadNodes);

// ------------------------------------------------------------------ CI state

// Fetched via GraphQL rather than `gh pr view --json statusCheckRollup` for one
// field the CLI does not expose: `isRequired(pullRequestNumber:)`. Without it the
// gate cannot tell a branch-protection-required check from an advisory one, and a
// transient advisory failure (`lychee — outbound HTTP (advisory)`, which
// .github/workflows/docs-corpus.yml deliberately excludes from docs-corpus-gate)
// blocked a merge every required check had already cleared.
//
// OID-anchored on the HEAD sha rather than `commits(last:1)`, matching the
// BASELINE_TS discipline in references/failure-modes.md: the rollup must belong
// to the commit the ack legs are anchored to, not to whatever the commit
// connection happens to return.
const CHECK_ROLLUP_QUERY = `
query($owner:String!, $name:String!, $number:Int!, $headSha:GitObjectID!, $cursor:String) {
  repository(owner:$owner, name:$name) {
    object(oid:$headSha) {
      ... on Commit {
        statusCheckRollup {
          contexts(first:100, after:$cursor) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on CheckRun {
                name
                status
                conclusion
                startedAt
                completedAt
                isRequired(pullRequestNumber:$number)
              }
              ... on StatusContext {
                context
                state
                createdAt
                isRequired(pullRequestNumber:$number)
              }
            }
          }
        }
      }
    }
  }
}`;

const rollupDrain = drainConnection((cursor) => {
  const page = graphqlPage(CHECK_ROLLUP_QUERY, { owner, name, headSha, cursor });
  return page?.data?.repository?.object?.statusCheckRollup?.contexts;
});
const { nodes: rollupNodes, truncated: checkWindowTruncated } = rollupDrain;

// Deduped to the newest run per check name — a superseded CANCELLED row sitting
// beside its real SUCCESS would otherwise read as red. See lib/codex-verdict.mjs.
const {
  status: ciStatus,
  failed: failedChecks,
  pending: pendingChecks,
  considered: dedupedChecks,
  gating: gatingChecks,
  advisoryFailed: advisoryFailedChecks,
  mode: ciMode,
} = deriveCiStatus(rollupNodes);
const supersededCount = rollupNodes.length - dedupedChecks.length;

function checkName(check) {
  return check.name ?? check.context ?? "(unnamed check)";
}

// -------------------------------------------------------- HEAD, re-read last

// Every probe above hangs off `headSha`, captured before any of them ran. A push
// landing mid-probe leaves the acks, the threads and the CI status all describing
// a commit that is no longer the one a merge would take, while merge_ok says go.
// Re-read HEAD after the last probe so the window this cannot see shrinks to the
// gap between here and the print — and the caller closes even that by passing
// the printed head_sha to `gh pr merge --match-head-commit`, which makes the
// merge itself refuse a head that moved after this line.
const pullRequestAtFinish = ghJson([
  "pr",
  "view",
  pullRequestNumber,
  "--repo",
  repository,
  "--json",
  "headRefOid",
]);
const headShaAtFinish = pullRequestAtFinish?.headRefOid;
// A re-read that returns nothing is not evidence HEAD held still. Stopping is
// the only honest option: reporting `head_moved` would name a move nobody saw,
// and carrying on would authorise a merge against an unconfirmed head.
if (!headShaAtFinish) {
  fail(
    `could not re-read HEAD for PR #${pullRequestNumber} — the gate cannot confirm what it read`,
  );
}
const headUnchanged = headShaAtFinish === headSha;

// ------------------------------------------------------------------ verdict

const mergeStateStatus = pullRequest.mergeStateStatus;
const isOpen = pullRequest.state === "OPEN";
const { verdict, ackOfHead, mergeOk, unsettledAckLeg, threadBearingAckAgeMs } = computeVerdict({
  isDraft: pullRequest.isDraft,
  isOpen,
  headUnchanged,
  pushAnchorKnown,
  rateLimited,
  reviewAcksHead,
  reactionAcksHead,
  commentAcksHead,
  commentAssertsClean,
  commentReportsFindings,
  openThreadCount: unresolvedBotThreads.length,
  latestReviewAgeMs,
  latestCommentAckAgeMs,
  threadWindowTruncated,
  checkWindowTruncated,
  ciStatus,
  mergeStateStatus,
  settleWindowMs: DEFAULT_SETTLE_WINDOW_MS,
});

// ------------------------------------------------------------------- output

const mergeStateAllows = mergeStateAllowsMerge(mergeStateStatus);

// Printed because the two sources can differ by minutes and the anchor — not the
// commit time — is what every timestamp-bound ack leg is judged against. A clock
// skew that pushes the anchor into the future would otherwise strand the gate at
// `no_ack_yet` with nothing on screen to explain it.
const ackAnchorSource = !pushAnchorKnown
  ? "commit time — NO check suite dates this sha, so the push time is unknown"
  : ackAnchorMs === pushObservedAtMs
    ? `earliest check suite, ${Math.round((ackAnchorMs - headCommittedAtMs) / 1000)}s after the commit`
    : "commit time — later than the earliest check suite, so it wins the max";

const lines = [
  `PR #${pullRequestNumber} — ${pullRequest.title}`,
  `  repo            ${repository}`,
  `  HEAD            ${headShaShort}  committed ${headCommittedAt.toISOString()}`,
  `  ack anchor      ${new Date(ackAnchorMs).toISOString()}  (${ackAnchorSource})`,
  `  draft           ${pullRequest.isDraft}   state ${pullRequest.state}   mergeState ${mergeStateStatus}${mergeStateAllows ? "" : "  (BLOCKS MERGE)"}`,
  "",
  "  ack legs (disjunction — any one is a valid ack of HEAD):",
  `    review .commit_id == HEAD   ${reviewAcksHead ? "YES" : "no "}   (${botReviews.length} bot review(s) total)`,
  `    +1 on issue at/after anchor ${reactionAcksHead ? "YES" : "no "}   (${botThumbsUp.length} bot +1 total, ${freshThumbsUp.length} fresh)`,
  `    comment acks HEAD           ${commentAcksHead ? "YES" : "no "}   (${botComments.length} bot comment(s): ${shaCitingComments.length} cite the sha, ${freshCleanVerdictComments.length} fresh clean verdict(s))`,
  `    ..and that ack says CLEAN   ${commentAssertsClean ? "YES" : "no "}   (${cleanVerdictShaComments.length} sha-cited clean verdict(s); citing a sha is not a verdict)`,
  `    ..or carries FINDINGS       ${commentReportsFindings ? "YES" : "no "}   (${findingsShaComments.length} findings summary(ies) naming HEAD, findings in the body not in threads)`,
  "",
  `  unresolved bot threads  ${unresolvedBotThreads.length}  (${outdatedUnresolvedCount} outdated, counted anyway) of ${threadTotal} total thread(s)`,
  `  CI                ${ciStatus}  (${gatingChecks.length} of ${dedupedChecks.length} check(s) gate the merge [${ciMode}], ${failedChecks.length} failed, ${pendingChecks.length} pending${supersededCount > 0 ? `, ${supersededCount} superseded run(s) ignored` : ""})`,
];

if (ciMode === "all-checks" && dedupedChecks.length > 0) {
  lines.push("  !! no check reported isRequired=true — gating on EVERY reported check instead.");
  lines.push(
    "     Expected early in a run, not a misconfiguration: an aggregator job has no check run",
  );
  lines.push(
    "     until its `needs:` clear, so a required check is simply absent yet — re-poll. (Also",
  );
  lines.push(
    "     fits an unprotected branch.) While this shows, merge_ok rests on mergeStateStatus.",
  );
}
if (!pushAnchorKnown) {
  lines.push(
    "  !! no check suite dates this sha, so the ack anchor falls back to the author-controlled",
  );
  lines.push(
    "     commit time — a +1 for the PREVIOUS head can land inside the commit-to-push gap and",
  );
  lines.push("     satisfy it. merge_ok is 0 until a suite appears; re-poll.");
}
if (threadWindowTruncated) {
  lines.push(
    `  !! review-thread connection truncated [${threadDrain.truncationReason}]: ${describeTruncation(threadDrain)} — the unresolved count is a floor, not a total. NOT mergeable.`,
  );
}
if (checkWindowTruncated) {
  lines.push(
    `  !! check-rollup connection truncated [${rollupDrain.truncationReason}]: ${describeTruncation(rollupDrain)} — CI status is unverified. NOT mergeable.`,
  );
}
for (const check of failedChecks) {
  lines.push(`  !! failed gating check: ${checkName(check)} = ${checkState(check)}`);
}
for (const check of advisoryFailedChecks) {
  lines.push(
    `  -- advisory check failed (real signal, does not block merge): ${checkName(check)} = ${checkState(check)}`,
  );
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
if (verdict === "signal_truncated") {
  lines.push("  -> a connection did not drain fully; re-run the gate. Do NOT merge on this probe.");
}
if (verdict === "ack_unsettled") {
  lines.push(
    `  !! ${unsettledAckLeg} ack of HEAD is ${Math.round(threadBearingAckAgeMs / 1000)}s old with 0 visible threads —`,
  );
  lines.push(
    "     cannot distinguish 'clean' from 'threads not yet materialised'. Re-poll; do NOT merge.",
  );
}
if (verdict === "ack_findings_no_threads") {
  lines.push(
    `  !! Codex filed findings for HEAD in ${findingsShaComments.length} comment body(ies), with 0 review threads.`,
  );
  lines.push(
    "     There is nothing to resolve, so require-conversation-resolution will NOT block this",
  );
  lines.push(
    "     merge — this gate is the only thing that does. Read the comment(s), fix, re-push.",
  );
}
if (verdict === "ack_without_verdict") {
  lines.push(
    "  !! Codex named this commit but published neither findings nor a clean verdict on it.",
  );
  lines.push(
    "     A 'Reviewed commit:' citation says only that it looked. Re-poll for the verdict.",
  );
}
if (verdict === "head_moved") {
  lines.push(
    `  !! HEAD moved mid-probe: ${headShaShort} -> ${headShaAtFinish.slice(0, 10)}. Every signal above`,
  );
  lines.push(
    "     describes the OLD commit, so none of it decides anything. Re-run the gate on the new head.",
  );
}
if (!isOpen) {
  lines.push(
    `  !! PR state is ${pullRequest.state}, not OPEN — there is nothing left to merge, so merge_ok is 0`,
  );
  lines.push("     regardless of the review verdict.");
}
// Suppressed on a non-OPEN PR: a merged one reports mergeStateStatus=UNKNOWN,
// and blaming that on an unmet merge requirement would send the reader hunting
// a phantom blocker when the real answer is "it already merged".
if (verdict === "ack_clean" && isOpen && !mergeStateAllows) {
  lines.push(
    `  !! Codex is clean but GitHub reports mergeStateStatus=${mergeStateStatus} — a merge requirement is unmet`,
  );
  lines.push(
    "     (a required check with no rollup row, an unresolved human conversation, or a stale base).",
  );
}

lines.push("");
// `head_sha` is the sha every signal on this line was measured against, and it
// is emitted on EVERY verdict rather than only the mergeable ones — a reader
// diagnosing a refusal needs to know which commit was judged just as much as a
// merger does. Feed it to `gh pr merge --match-head-commit` so the merge refuses
// a head that moved between this print and the call.
lines.push(
  `GATE verdict=${verdict} ack=${ackOfHead ? 1 : 0} unresolved=${unresolvedBotThreads.length} ci=${ciStatus} state=${pullRequest.state} merge_state=${mergeStateStatus} merge_ok=${mergeOk ? 1 : 0} head_sha=${headSha}`,
);

process.stdout.write(`${lines.join("\n")}\n`);
