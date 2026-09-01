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
 *   4. rate-limited — fresh bot comment matching /usage limits for code reviews/ (NON-ack; stop polling)
 *
 * The ack anchor is the latest of three floors: this gate's own first sighting of
 * the sha as this PR's HEAD (lib/observation-baseline.mjs), the earliest check
 * suite for that sha, and the HEAD commit's timestamp — see derivePushAnchor for
 * the last two and why each was insufficient alone. Commit time is
 * author-controlled, and a check suite dates the sha's first visibility anywhere
 * in the repo rather than the moment it became this PR's head, so both can be
 * predated by an ack of the PREVIOUS head. Only the first sighting cannot.
 *
 * A floor answers one question — could this ack predate HEAD's existence as this
 * PR's head. It does NOT answer which run produced the ack, because a run for the
 * previous head finishes AFTER the push and so clears every floor. That is
 * deriveStaleRunEvidence's question, and neither predicate subsumes the other.
 *
 * Which is why only the ACK legs get the first-sighting floor. Two consumers
 * deliberately read the lower push anchor instead — deriveStaleRunEvidence and
 * the usage-limits non-ack — and passing them the raised floor was a live defect
 * caught in review, not a hypothetical. The stale-run detector asks whether a
 * run for an older commit was in flight ACROSS THE PUSH, so a floor starting at
 * first sighting hides any such run that published in the push-to-sighting gap;
 * on this PR that silently turned a detected stale review into no evidence at
 * all once the baseline landed. The quota notice is not a claim about a commit
 * at all, so attribution is the wrong question to ask of it; floored on first
 * sighting, a genuine notice in the same gap disappears and the gate advises
 * polling at the one moment polling cannot work.
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
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  checkState,
  computeVerdict,
  deriveCiStatus,
  deriveCommentSignals,
  derivePreBaselineAcks,
  derivePushAnchor,
  deriveReactionAck,
  deriveReviewAck,
  deriveStaleRunEvidence,
  mergeStateAllowsMerge,
  selectUnresolvedBotThreads,
  DEFAULT_SETTLE_WINDOW_MS,
} from "./lib/codex-verdict.mjs";
import { observeBaseline } from "./lib/observation-baseline.mjs";
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
  anchorMs: fallbackAnchorMs,
  pushObservedAtMs,
  pushAnchorKnown,
} = derivePushAnchor(headCommittedAtMs, checkSuites);

// The PRIMARY floor: this gate's own first sighting of the sha as this PR's
// HEAD. Every server-side candidate is a proxy for the head-update moment and
// each has been predated in review — the author's commit clock, then the
// earliest check suite, which dates the sha's first visibility ANYWHERE in the
// repo and so predates this PR entirely for a sha pushed on another branch
// first. GitHub exposes no head-update timestamp to replace them with
// (`pushedDate` null, `PullRequestCommit` carries no `createdAt`), so the floor
// has to come from an observation this gate makes itself.
//
// State lives under `.cache/` rather than `.agents/tmp/`, and the difference is
// load-bearing rather than cosmetic. Both are gitignored, but AGENTS.md directs
// agents to delete `.agents/tmp/`, and losing this record is not a self-healing
// failure: the next run stamps a fresh `now` that also post-dates whatever the
// operator just re-triggered. `.cache/` is swept by nobody.
//
// Rooted at the checkout containing this script rather than at `process.cwd()`,
// so a gate invoked from a subdirectory or a worktree still finds the same
// store the previous poll wrote.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const {
  observedAtMs: baselineObservedAtMs,
  baselineKnown: observationBaselineKnown,
  baselineWritable,
  firstObservation: baselineFirstObservation,
  baselinePath,
  baselineError,
} = observeBaseline({
  stateDir: join(repoRoot, ".cache", "codex-gate"),
  prNumber: pullRequestNumber,
  headSha,
  nowMs: Date.now(),
});

// `max`, never replacement — the same rule `derivePushAnchor` already applies
// internally. The baseline dominates in practice, but a suite timestamp skewed
// into the future is a later floor than a local clock reading, and handing that
// back would loosen the gate relative to today's behaviour.
const ackAnchorMs = observationBaselineKnown
  ? Math.max(fallbackAnchorMs, baselineObservedAtMs)
  : fallbackAnchorMs;

// ---------------------------------------------------- signal 1: review object

// Pagination is mandatory: the reviews endpoint pages at 30 and on a many-round
// PR the newest review rolls onto page 2+, where an unpaginated `last` returns a
// permanently stale review (PR #199 r8).
const allReviews = ghJsonPaginated([
  "api",
  `repos/${repository}/pulls/${pullRequestNumber}/reviews`,
]);
const { botReviews, reviewAcksHead, latestReviewAgeMs, latestReviewAgeUnknown } = deriveReviewAck(
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
  otherCommitCleanVerdictComments,
  cleanVerdictShaComments,
  findingsShaComments,
  commentAcksHead,
  commentAcksHeadBySha,
  commentAssertsClean,
  commentReportsFindings,
  latestCommentAckAgeMs,
  latestCommentAckAgeUnknown,
  rateLimited,
} = deriveCommentSignals(allComments, {
  headShaShort,
  ackAnchorMs,
  // The rate-limit leg is anchored on the push, for the same reason the
  // stale-run detector below is: raising its floor to first sighting would drop
  // a usage-limits notice posted in the push-to-sighting gap, and the gate would
  // then print "no ack yet" — keep polling — at a PR where Codex has run out of
  // quota and polling cannot help.
  freshnessAnchorMs: fallbackAnchorMs,
  nowMs: Date.now(),
});

// ------------------------------- signal 4: a run for an OLDER commit, late
//
// Reads the bot-filtered sets the two derivations above already produced, so the
// `[bot]` login form has exactly one authority. The sha-less ack legs — the +1
// and the fresh clean verdict — cannot tell a verdict on THIS commit from the
// tail of a run for the previous one that finished after the push; this is the
// evidence that such a run exists, and computeVerdict withholds cleanliness from
// those legs while it does.
//
// DELIBERATELY `fallbackAnchorMs`, NOT `ackAnchorMs`. The two floors answer
// different questions and only one of them belongs here. This detector asks "was
// a run for an older commit still in flight when the push landed", which is
// anchored on the PUSH; the baseline asks "could this ack predate the moment we
// first saw the sha as HEAD", which is anchored on OBSERVATION. Passing the
// raised floor clips the detector's window to start at first sighting, so a
// stale review that landed in the gap between the push and that sighting becomes
// invisible — and a bare `+1` arriving after the sighting then reads as a clean
// ack with nothing contradicting it. Verified against this PR: the review for
// 59344aaea9 at 20:56:27Z was detected at a 20:56:24Z push anchor and vanished
// once the baseline moved the floor to 21:58:10Z, with the reviews unchanged.
const { staleReviews, staleCitations, staleCitedShas, staleRunLandedAfterPush } =
  deriveStaleRunEvidence({
    botReviews,
    botComments,
    headSha,
    headShaShort,
    ackAnchorMs: fallbackAnchorMs,
  });

// ------------------------- signal 5: acks the observation baseline refused
//
// Raising the anchor to the baseline makes the derivations above drop these rows
// silently, so without this the ladder would report `no_ack_yet` — "Codex has
// not looked" — at a PR where Codex has looked, published, and simply landed
// before this gate first saw the sha. Reconstructed from the raw payloads
// against BOTH floors so the gate can name which one refused.
const { preBaselineReactions, preBaselineCleanComments, ackPredatesBaseline } =
  derivePreBaselineAcks({
    reactions: allReactions,
    comments: allComments,
    headShaShort,
    fallbackAnchorMs,
    baselineMs: baselineObservedAtMs,
  });

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
const {
  verdict,
  ackOfHead,
  mergeOk,
  unsettledAckLeg,
  threadBearingAckAgeMs,
  ackAgeUnknown,
  shaBoundAckOfHead,
  timestampOnlyAckUnvouchable,
} = computeVerdict({
  isDraft: pullRequest.isDraft,
  isOpen,
  headUnchanged,
  pushAnchorKnown,
  rateLimited,
  reviewAcksHead,
  reactionAcksHead,
  commentAcksHead,
  commentAcksHeadBySha,
  commentAssertsClean,
  commentReportsFindings,
  staleRunLandedAfterPush,
  observationBaselineKnown,
  ackPredatesBaseline,
  openThreadCount: unresolvedBotThreads.length,
  latestReviewAgeMs,
  latestReviewAgeUnknown,
  latestCommentAckAgeMs,
  latestCommentAckAgeUnknown,
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
function describeAckAnchor() {
  if (observationBaselineKnown && ackAnchorMs === baselineObservedAtMs) {
    return `this gate's FIRST SIGHTING of the sha as HEAD${baselineFirstObservation ? ", recorded just now" : ""}`;
  }
  if (!pushAnchorKnown) {
    return "commit time — NO check suite dates this sha, so the push time is unknown";
  }
  if (ackAnchorMs === pushObservedAtMs) {
    return `earliest check suite, ${Math.round((ackAnchorMs - headCommittedAtMs) / 1000)}s after the commit`;
  }
  return "commit time — later than the earliest check suite, so it wins the max";
}
const ackAnchorSource = describeAckAnchor();

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
  `    comment acks HEAD           ${commentAcksHead ? "YES" : "no "}   (${botComments.length} bot comment(s): ${shaCitingComments.length} cite the sha, ${freshCleanVerdictComments.length} fresh clean verdict(s), ${otherCommitCleanVerdictComments.length} clean verdict(s) naming ANOTHER commit)`,
  `    ..and that ack says CLEAN   ${commentAssertsClean ? "YES" : "no "}   (${cleanVerdictShaComments.length} sha-cited clean verdict(s); citing a sha is not a verdict)`,
  `    ..or carries FINDINGS       ${commentReportsFindings ? "YES" : "no "}   (${findingsShaComments.length} findings summary(ies) naming HEAD, findings in the body not in threads)`,
  `    ack is BOUND BY SHA         ${shaBoundAckOfHead ? "YES" : "no "}   (a review on HEAD or a comment naming the sha; the +1 and a sha-less clean verdict rest on the anchor alone)`,
  `    stale-run evidence          ${staleRunLandedAfterPush ? "YES" : "no "}   (${staleReviews.length} review(s) + ${staleCitations.length} citation(s) for a NON-head commit published after the anchor${staleCitedShas.length > 0 ? `: ${staleCitedShas.join(", ")}` : ""})`,
  `    first-sighting baseline     ${observationBaselineKnown ? "OK " : "NO "}   ${
    observationBaselineKnown
      ? `${new Date(baselineObservedAtMs).toISOString()}${baselineFirstObservation ? " (stamped by THIS run)" : ""}`
      : (baselineError ?? "unavailable")
  }${timestampOnlyAckUnvouchable ? "  <- cannot vouch for the current ack" : ""}`,
  `    acks refused as pre-baseline ${ackPredatesBaseline ? "YES" : "no "}  (${preBaselineReactions.length} +1(s), ${preBaselineCleanComments.length} sha-less clean verdict(s) older than that sighting)`,
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
  lines.push(
    "  !! Codex reports code-review usage limits reached — NON-ack terminal, stop polling",
  );
}
if (verdict === "no_ack_yet") {
  lines.push(
    "  -> no ack of current HEAD yet. Past ~15 min, comment '@codex review' to trigger manually.",
  );
}
// Without this the reader sees "no ack yet" while a fresh clean verdict sits
// visibly on the PR, and concludes the gate is broken. It is not: the verdict
// names a commit that is not this one, so it acks the previous head, and the
// generic "wait ~15 min" above is the wrong advice — the retrigger is correct
// immediately, because nothing is in flight for HEAD.
if (verdict === "no_ack_yet" && otherCommitCleanVerdictComments.length > 0) {
  lines.push(
    `     NOTE: ${otherCommitCleanVerdictComments.length} clean verdict(s) ARE on this PR, each naming a DIFFERENT commit${staleCitedShas.length > 0 ? ` (${staleCitedShas.join(", ")})` : ""} —`,
  );
  lines.push(
    "     the tail of a run for the previous head, not a verdict on this one. Re-trigger now.",
  );
}
if (verdict === "ack_with_findings") {
  lines.push("  -> reply BEFORE resolve on each open thread, then re-push and re-gate.");
}
if (verdict === "signal_truncated") {
  lines.push("  -> a connection did not drain fully; re-run the gate. Do NOT merge on this probe.");
}
if (verdict === "ack_unsettled" && !ackAgeUnknown) {
  lines.push(
    `  !! ${unsettledAckLeg} ack of HEAD is ${Math.round(threadBearingAckAgeMs / 1000)}s old with 0 visible threads —`,
  );
  lines.push(
    "     cannot distinguish 'clean' from 'threads not yet materialised'. Re-poll; do NOT merge.",
  );
}
// Same verdict, different remediation, and printing the other one here would be
// advice that cannot work: an ack carrying no usable timestamp never ages out of
// the settle window, so "re-poll" is an instruction to loop forever. The gate
// holds it because an ack it cannot date is one it cannot rule out as brand new.
if (verdict === "ack_unsettled" && ackAgeUnknown) {
  lines.push(
    `  !! the ${unsettledAckLeg} ack of HEAD carries NO usable timestamp, so its age is unknown and`,
  );
  lines.push(
    "     the settle window can never expire on it. Re-polling will not clear this. Comment",
  );
  lines.push(
    "     '@codex review' for a datable ack, or merge by hand once you have confirmed the threads.",
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
if (verdict === "ack_unattributable") {
  lines.push(
    `  !! the only ack of HEAD is TIMESTAMP-bound (+1 and/or a sha-less clean verdict), and a Codex run`,
  );
  lines.push(
    `     for an OLDER commit published AFTER this push (${staleReviews.length} review(s), ${staleCitations.length} citation(s)${staleCitedShas.length > 0 ? ` naming ${staleCitedShas.join(", ")}` : ""}).`,
  );
  lines.push(
    "     That ack cannot be told apart from the older run's tail, so it is not a verdict on HEAD and",
  );
  lines.push(
    "     the settle window is not what is missing. A pass for THIS commit cites the sha — re-poll for",
  );
  lines.push("     that, and comment '@codex review' if it does not arrive. Do NOT merge.");
}
if (verdict === "ack_baseline_unavailable") {
  lines.push(
    "  !! the only ack of HEAD is TIMESTAMP-bound, and this gate has no trustworthy floor to date",
  );
  lines.push(`     it against: ${baselineError ?? "the first-sighting baseline is unavailable"}`);
  lines.push(
    `     Nothing is wrong with the ack — the gap is in this gate's own state at ${baselinePath}.`,
  );
  lines.push(
    baselineWritable
      ? "     Delete that file and re-run: the next poll re-stamps it and the ack is judged normally."
      : "     Fix the path's permissions (or free the disk) and re-run. Re-polling alone will NOT clear this.",
  );
  lines.push(
    "     A sha-bound verdict needs no baseline at all, so '@codex review' also clears it.",
  );
}
if (verdict === "ack_predates_baseline") {
  lines.push(
    `  !! Codex HAS acked, and this gate refused the ack: ${preBaselineReactions.length} +1(s) and`,
  );
  lines.push(
    `     ${preBaselineCleanComments.length} sha-less clean verdict(s) predate this gate's first sighting of ${headShaShort} as HEAD`,
  );
  lines.push(
    `     (${new Date(baselineObservedAtMs).toISOString()}). Neither carries a sha, so nothing else binds them to THIS commit —`,
  );
  lines.push(
    "     and an ack that landed before the gate ever saw this head cannot be told from one for a",
  );
  lines.push("     previous head. This is NOT 'Codex has not looked yet'.");
  lines.push(
    "     Re-polling will never clear it: Codex does not re-ack a head it already acked, and that",
  );
  lines.push(
    "     timestamp does not move. Comment '@codex review' — the fresh verdict post-dates the",
  );
  lines.push("     sighting and, in today's format, cites the sha outright.");
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
