/**
 * Pure logic for the Codex review gate: signal derivation from raw API payloads,
 * plus the verdict decision table. codex-gate.mjs is the I/O shell around it.
 *
 * Split out from codex-gate.mjs because the branches that matter most cannot be
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
 * Isolating this logic makes every one of them directly constructible. The ack
 * predicate specifically has been hand-rolled wrong five times (PR #171, #172,
 * #199 r13, #255, #257) — keeping it in an unimportable script is what let each
 * of those ship untested.
 */

/** Window in which a review's threads may still be materialising. */
export const DEFAULT_SETTLE_WINDOW_MS = 120_000;

/**
 * Conclusions and states that count as a passing check.
 *
 * Enumerated rather than derived because the classification is INVERTED:
 * anything that is neither success-like nor pending is failed. That is the
 * fail-closed direction — a conclusion GitHub adds after this was written, or
 * one nobody thought about, blocks the merge instead of scoring green. The
 * previous shape listed failures explicitly, so `ACTION_REQUIRED` and `STALE`
 * (in neither list) passed through as green on a PR that could not merge.
 *
 * Membership, against the three GraphQL enums introspected 2026-07-27 from the
 * live schema:
 *   - `SUCCESS` — CheckConclusionState and StatusState. Passing.
 *   - `NEUTRAL` — CheckConclusionState. The run completed and declined to
 *     assert failure; GitHub's own branch protection treats it as passing.
 *   - `SKIPPED` — CheckConclusionState. A path-filtered job that did not need
 *     to run. Safe HERE specifically because this repo funnels every leaf job
 *     through the `ci-gate` / `docs-corpus-gate` aggregators: the aggregator is
 *     what branch protection requires and what reports, so a skipped leaf can
 *     never masquerade as a passing required check.
 */
const SUCCESS_LIKE_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * States meaning "not finished yet" — evidence is still outstanding, so the
 * gate waits instead of passing or failing.
 *
 *   - `PENDING` — CheckStatusState and StatusState.
 *   - `EXPECTED` — StatusState. A status the commit declares it is waiting for
 *     and which has not reported.
 *   - `QUEUED`, `IN_PROGRESS`, `WAITING`, `REQUESTED` — CheckStatusState, all
 *     pre-completion.
 *   - `COMPLETED` — CheckStatusState. Reached only when a finished run's
 *     `conclusion` has not propagated yet, since `checkState` prefers
 *     `conclusion`. A conclusion nobody has published is not evidence of
 *     anything; calling it failed would flap the gate red mid-propagation.
 *
 * Everything outside these two sets is failed: CheckConclusionState's
 * `ACTION_REQUIRED` / `TIMED_OUT` / `CANCELLED` / `FAILURE` / `STARTUP_FAILURE`
 * / `STALE`, and StatusState's `ERROR` / `FAILURE`.
 */
const PENDING_STATES = new Set([
  "PENDING",
  "EXPECTED",
  "QUEUED",
  "IN_PROGRESS",
  "WAITING",
  "REQUESTED",
  "COMPLETED",
]);

/**
 * `mergeStateStatus` values that do not block a merge.
 *
 * This is GitHub's own verdict on every merge requirement at once — required
 * contexts that have not reported, unresolved conversations, required reviews,
 * an out-of-date base — and it is the backstop for the hole that required-only
 * CI filtering opens. Two shapes reach it and neither is exotic:
 *   - SOME required rows present, one missing: the row set is incomplete rather
 *     than empty, so the absent check is invisible to a row filter AND the
 *     degradation fallback does not fire.
 *   - NO required row at all: the fallback fires, every row gates, and a rollup
 *     carrying only green advisories scores green. This is the normal state for
 *     the first minutes of a run — see `partitionByRequirement`.
 * GitHub reports `BLOCKED` in both. This conjunct is therefore load-bearing on
 * the common path, not a guard against a rare misconfiguration.
 *
 * MergeStateStatus, introspected 2026-07-27: `BEHIND`, `BLOCKED`, `CLEAN`,
 * `DIRTY`, `HAS_HOOKS`, `UNKNOWN`, `UNSTABLE`.
 *   - `CLEAN` / `HAS_HOOKS` — mergeable, commit status passing.
 *   - `UNSTABLE` — mergeable, commit status NOT passing. This is exactly the
 *     advisory-check-red case that required-only filtering exists to let
 *     through; excluding it would re-block what that filtering unblocked.
 *   - `BEHIND` / `BLOCKED` / `DIRTY` — blocked.
 *   - `UNKNOWN` — GitHub is still computing mergeability. Absence of evidence,
 *     exactly like an empty check rollup; the caller re-polls.
 *
 * Reachability of `CLEAN` on this repo was verified against
 * `branches/develop/protection` (2026-07-27): `required_approving_review_count`
 * is 0, so no human approval is needed and this conjunct cannot pin the gate
 * to `merge_ok=0` forever.
 */
export const MERGEABLE_MERGE_STATES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

/**
 * @param {string | null | undefined} mergeStateStatus
 * @returns {boolean}
 */
export function mergeStateAllowsMerge(mergeStateStatus) {
  return MERGEABLE_MERGE_STATES.has(mergeStateStatus);
}

/**
 * The single state string a rollup row is judged on.
 *
 * Three row shapes reach here. A CheckRun carries `conclusion`
 * (CheckConclusionState, null until it completes) and `status`
 * (CheckStatusState); a legacy commit status carries `state` (StatusState) and
 * neither of the others. Preferring `conclusion` judges a finished run on its
 * outcome and an in-flight one on its progress. The `"PENDING"` floor keeps the
 * function total for a row carrying none of the three — unreported, not passing.
 */
export function checkState(check) {
  return check.conclusion || check.status || check.state || "PENDING";
}

function isPassingCheck(check) {
  return SUCCESS_LIKE_STATES.has(checkState(check));
}

function isPendingCheck(check) {
  return PENDING_STATES.has(checkState(check));
}

function isFailingCheck(check) {
  return !isPassingCheck(check) && !isPendingCheck(check);
}

function startedAtMs(check) {
  // `createdAt` is the legacy commit-status timestamp; CheckRun rows carry the
  // other two. Ordering only ever compares rows of the same check name.
  const stamp = check.startedAt ?? check.completedAt ?? check.createdAt ?? null;
  return stamp ? new Date(stamp).getTime() : 0;
}

/**
 * Collapse a status rollup to the newest run per check name.
 *
 * A re-run does not replace its predecessor in the rollup — both rows are
 * returned. When a push supersedes an in-flight run, GitHub CANCELs the old one
 * and the rollup then carries `CANCELLED` alongside the real `SUCCESS` for the
 * same check name. Counting every row makes a fully green PR read as red, which
 * blocks a legitimate merge and sends the reader chasing a phantom failure.
 * Observed live on PR #256: `lychee — outbound HTTP (advisory)` CANCELLED at
 * 00:25:10, SUCCESS at 00:25:59.
 */
export function selectNewestRunPerName(checks) {
  const newestByName = new Map();
  for (const check of checks) {
    const name = check.name ?? check.context ?? "";
    const incumbent = newestByName.get(name);
    if (!incumbent) {
      newestByName.set(name, check);
      continue;
    }
    const incumbentStarted = startedAtMs(incumbent);
    const candidateStarted = startedAtMs(check);
    if (candidateStarted > incumbentStarted) {
      newestByName.set(name, check);
    } else if (candidateStarted === incumbentStarted && !incumbent.conclusion && check.conclusion) {
      // Equal (or absent) timestamps: prefer the row that actually concluded.
      newestByName.set(name, check);
    }
  }
  return [...newestByName.values()];
}

/**
 * Split rollup rows into the ones that gate the merge and the ones that are
 * advisory.
 *
 * `isRequired(pullRequestNumber:)` is the ONLY authority. Verified 2026-07-27
 * against `branches/develop/protection`, whose required contexts (`ci-gate`,
 * `docs-corpus-gate`) matched the `isRequired: true` rows exactly. Name-matching
 * would be wrong on this repo in the direction that matters: `lychee — inbound
 * anchors (required)` and `lane boundary — plan-title token (required)` both
 * carry "(required)" in their names and both report `isRequired: false`.
 *
 * Degradation is deliberate, never silent, and NOT rare. Its dominant cause is
 * timing rather than misconfiguration: a required check that is an aggregator
 * job gets no check run until its `needs:` clear, so it is absent from the rollup
 * for the opening minutes of every run. Measured on PR #259 against the Actions
 * jobs API (2026-07-27): leaf jobs were created 1s after the workflow run,
 * `docs-corpus-gate` at +42s, `ci-gate` at +178s. Any gate polled inside that
 * window sees zero required rows. An unprotected branch, a rollup fetched without
 * the field, or a schema change land here too.
 *
 * Every row then gates. That is the conservative direction but not a safe one on
 * its own: if the rows that happen to exist are all green advisories, this
 * reports green while the checks that actually gate have not run. computeVerdict
 * does not merge on it — `mergeStateStatus` is the conjunct that holds the line,
 * and on this path it is load-bearing rather than defence in depth. The returned
 * `mode` is what the caller prints, so a degraded run is visible rather than
 * quietly permissive.
 *
 * @param {Array<object>} checks
 * @returns {{gating: Array<object>, advisory: Array<object>, mode: "required-only"|"all-checks"}}
 */
export function partitionByRequirement(checks) {
  const required = checks.filter((check) => check.isRequired === true);
  if (required.length === 0) {
    return { gating: checks, advisory: [], mode: "all-checks" };
  }
  return {
    gating: required,
    advisory: checks.filter((check) => check.isRequired !== true),
    mode: "required-only",
  };
}

/**
 * @param {Array<object>} checks Raw rollup rows.
 * @returns {{status: "green"|"red"|"pending"|"none", failed: Array<object>, pending: Array<object>, considered: Array<object>, gating: Array<object>, advisory: Array<object>, advisoryFailed: Array<object>, mode: "required-only"|"all-checks"}}
 *   `considered` is every row after dedupe; `gating` is the subset that drives
 *   `status`. `failed` / `pending` are drawn from `gating` alone —
 *   `advisoryFailed` is real signal for the reader but blocks nothing.
 */
export function deriveCiStatus(checks) {
  const considered = selectNewestRunPerName(checks ?? []);
  const { gating, advisory, mode } = partitionByRequirement(considered);
  const failed = gating.filter(isFailingCheck);
  const pending = gating.filter(isPendingCheck);
  const advisoryFailed = advisory.filter(isFailingCheck);

  // An empty gating set is NOT green. Checks can be absent because none are
  // configured, because none have been reported yet, or because the rollup call
  // degraded — none of which is evidence that CI passed. Calling that "green"
  // is a fail-open that would let merge_ok go true on a PR nothing has verified.
  const status =
    gating.length === 0
      ? "none"
      : failed.length > 0
        ? "red"
        : pending.length > 0
          ? "pending"
          : "green";

  return { status, failed, pending, considered, gating, advisory, advisoryFailed, mode };
}

// ------------------------------------------------------- signal derivation

/**
 * Bot login form splits by API surface, not by data type.
 *
 * Every REST endpoint — reactions, issue comments, AND `pulls/N/reviews` —
 * returns the `[bot]` suffix (verified PR #163, 2026-06-20: the suffixed filter
 * returned the review, the bare form returned null). Every GraphQL author field
 * returns it WITHOUT the suffix, because GraphQL's `Bot.login` carries none. A
 * wrong-form filter silently matches zero rows and the poll never terminates.
 */
export const BOT_REST_LOGIN = "chatgpt-codex-connector[bot]";
export const BOT_GRAPHQL_LOGIN = "chatgpt-codex-connector";

const RATE_LIMIT_PATTERN = /usage limits/i;

/**
 * Ack shape (2) of `references/failure-modes.md` § Codex Verdict Gate, observed
 * verbatim on PRs #120 / #121: "Codex Review: Didn't find any major issues."
 *
 * The apostrophe is ASCII 0x27 in both samples (hexdumped from the live API,
 * 2026-07-27). U+2019 is accepted as well because a typographic-quote swap
 * upstream would make this match zero comments SILENTLY — the same class of
 * break as the wrong-form `[bot]` login above.
 */
const CLEAN_VERDICT_PATTERN = /Didn['’]t find any major issues/i;

/**
 * A findings pass delivered as a COMMENT body instead of as inline threads.
 *
 * Codex reports findings two ways and this gate only ever read one of them. The
 * other is a `### 💡 Codex Review` comment carrying the findings themselves —
 * severity badge, permalink, prose — with no inline thread anywhere, no
 * `Reviewed commit:` line and no clean verdict. It therefore matched NO ack leg:
 * not `shaCitingComments`, which additionally requires "Reviewed commit"; not
 * `freshCleanVerdictComments`, which requires the clean verdict. `ackOfHead`
 * came out false and the gate reported `no_ack_yet` — "Codex has not looked at
 * this yet" — about a commit Codex had reviewed and filed a P1 against.
 *
 * Observed, not hypothesised. On PR #28 the sha `f67a7bb` became head at
 * 02:11:29Z, this comment landed at 02:18:54Z citing that exact sha, the next
 * push was 02:27:03Z, the first bot review 02:30:39Z on a LATER sha, and the
 * only bot `+1` 04:33:50Z. For those 8 minutes every ack leg was false while a
 * P1 sat in a comment naming HEAD.
 *
 * Two markers, either sufficient, because they fail independently: an upstream
 * emoji change kills the heading, a severity-scheme change kills the badge.
 * Accepting either is the fail-closed direction here, since the defect being
 * closed is a findings comment going unseen. Surveyed 2026-07-27 against all 48
 * bot comments in the repo: each marker alone matched the same 5 findings
 * summaries, neither matched any of the 36 clean verdicts or the 6 usage-limits
 * notices, and neither matched the one conversational reply — which a
 * permalink-based test WOULD have captured, so the permalink is deliberately
 * not a marker.
 */
const FINDINGS_SUMMARY_PATTERN = /###\s*.{0,4}\s*Codex Review|!\[P\d+ Badge\]/u;

/**
 * The instant an ack must post-date, given the HEAD commit and its check suites.
 *
 * The commit timestamp is the wrong anchor on its own: it is the LOCAL commit
 * time, written by the author's clock, so every second between committing and
 * pushing is a window in which a `+1` for the PREVIOUS head lands carrying a
 * `created_at` that still beats it. That reaction then acks a commit Codex never
 * saw — the same false-ack the `new Date(null)` epoch bug produced, reached by a
 * different route. The window is not theoretical: on this branch's own
 * `c8bcdc1`, `committedDate` was 18:19:07Z and the first server-side sighting of
 * the sha was 18:20:59Z — 112 seconds — and a commit-then-verify-then-push
 * workflow widens it to minutes.
 *
 * `Commit.pushedDate` would answer this exactly, but GitHub no longer populates
 * it: null on that same commit (GraphQL, 2026-07-27). The earliest
 * `check_suite.created_at` for the sha is the closest available server-side
 * observation, since GitHub creates a suite per installed app on receiving the
 * push. Check suites beat `actions/runs` because they cover non-Actions apps
 * too — on `c8bcdc1` the earliest suite belongs to a third-party app, 5 seconds
 * ahead of the Actions ones.
 *
 * Combined with `max` rather than by replacement, so the anchor can only move
 * LATER than the previous behaviour, never earlier. Three residuals worth naming
 * rather than implying they are closed:
 *   - a sha pushed earlier on another branch carries that earlier suite, so this
 *     is the first moment the sha was visible anywhere in the repo, not the
 *     moment it became this PR's head. Still >= the commit time, so still a
 *     strict improvement — but it is not the push event itself.
 *   - a suite timestamp in the future (clock skew) pins the anchor ahead of
 *     every ack, and the gate reports `no_ack_yet` until wall-clock catches up.
 *     That is the fail-closed direction, and the caller prints the anchor it
 *     chose and which source won, so the cause is legible rather than a silent
 *     spin.
 *   - suite creation and Codex's webhook are INDEPENDENT consumers of the same
 *     push, so nothing orders them: a `+1` posted before the earliest suite is
 *     rejected by an anchor derived from that suite. It does not strand the
 *     gate, because both observed ack shapes also carry a sha-bound leg that no
 *     timestamp can stale. A findings pass posts a review whose `commit_id` is
 *     HEAD (PR #259). A clean pass posts ONE comment that is both the clean
 *     verdict and a `Reviewed commit:` citation (PR #256, 2026-07-27), which
 *     `deriveCommentSignals` matches on the sha via `shaCitingComments`
 *     regardless of the anchor — note the review leg does NOT carry the clean
 *     case: #256 had four bot reviews and none on HEAD. Only a bare `+1` with
 *     neither a review nor a comment would strand it; no observed shape does
 *     that, and `no_ack_yet` already prints the `@codex review` re-trigger,
 *     whose fresh ack post-dates the anchor. Two later changes narrowed this
 *     recovery without removing it, and both are deliberate: the comment leg is
 *     now inside the settle window, so it recovers one window late rather than
 *     immediately, and it must assert cleanliness rather than only cite the sha
 *     — #256's comment does both, so the observed clean shape still recovers.
 *
 * @param {number} committedAtMs
 * @param {Array<object>} checkSuites Raw `check_suites` rows for the head sha.
 * @returns {{anchorMs: number, pushObservedAtMs: number | null, pushAnchorKnown: boolean}}
 */
export function derivePushAnchor(committedAtMs, checkSuites) {
  let earliestMs = null;
  for (const suite of checkSuites ?? []) {
    const createdMs = new Date(suite?.created_at ?? Number.NaN).getTime();
    if (!Number.isFinite(createdMs)) continue;
    if (earliestMs === null || createdMs < earliestMs) earliestMs = createdMs;
  }
  return {
    anchorMs: earliestMs === null ? committedAtMs : Math.max(committedAtMs, earliestMs),
    pushObservedAtMs: earliestMs,
    pushAnchorKnown: earliestMs !== null,
  };
}

/**
 * The `created_at >= BASELINE_TS` freshness predicate from
 * `references/failure-modes.md` § Codex Verdict Gate.
 *
 * Inclusive, not strict. GitHub timestamps are second-granular, so an ack posted
 * inside the anchor's own second carries an identical `created_at`; a strict `>`
 * discarded it and left the verdict poll waiting on an ack that had already
 * landed. An absent or unparseable stamp yields NaN, which compares false — fail
 * closed.
 *
 * @param {string | null | undefined} timestamp
 * @param {number} anchorMs Ack anchor from `derivePushAnchor`, epoch ms.
 * @returns {boolean}
 */
export function isAtOrAfter(timestamp, anchorMs) {
  return new Date(timestamp ?? Number.NaN).getTime() >= anchorMs;
}

/**
 * The newest review by submission time, rather than by array position.
 *
 * `at(-1)` assumed both that the reviews endpoint returns ascending submission
 * order and that the page merge preserves it. Both hold today, but this is the
 * same hazard `selectNewestRunPerName` already exists to handle on the CI side.
 * Its callers now pre-filter to the HEAD-matching set, so ordering no longer
 * decides whether an ack exists — that is set membership — but it still decides
 * which review's age feeds the settle window.
 *
 * A tie, or a payload carrying no `submitted_at` at all, keeps the later array
 * position — so the degenerate case falls back to the documented order instead
 * of to an arbitrary pick.
 *
 * @param {Array<object>} reviews
 * @returns {object | null}
 */
export function selectNewestReview(reviews) {
  let newest = null;
  let newestSubmittedMs = Number.NEGATIVE_INFINITY;
  for (const review of reviews ?? []) {
    const submittedMs = new Date(review.submitted_at ?? Number.NaN).getTime();
    const comparable = Number.isNaN(submittedMs) ? Number.NEGATIVE_INFINITY : submittedMs;
    if (newest === null || comparable >= newestSubmittedMs) {
      newest = review;
      newestSubmittedMs = comparable;
    }
  }
  return newest;
}

/**
 * Ack shape (3): a review object whose `.commit_id` is HEAD.
 *
 * Filtered to HEAD BEFORE the newest is picked, never after. Taking the newest
 * bot review globally and then testing its `commit_id` reports no ack whenever
 * two review runs overlap and the one started on the OLDER head submits last:
 * a review that does name HEAD is sitting in the same payload, ignored. The
 * same inversion fed the settle window the age of a review this leg had just
 * rejected, so both fields were describing the wrong object at once.
 *
 * Intrinsically HEAD-bound, so the ack anchor never reaches this leg. The one
 * timestamp it derives, `latestReviewAgeMs`, is wall-clock relative and belongs
 * to the newest HEAD-matching review, so it can only ever describe a review
 * this leg actually acked. `computeVerdict` folds it into the settle window
 * only while `reviewAcksHead` holds.
 *
 * Pagination at the call site is mandatory — the reviews endpoint pages at 30,
 * and on a many-round PR the newest review rolls onto page 2+ where an
 * unpaginated `last` returns a permanently stale review (PR #199 r8).
 *
 * @param {Array<object>} reviews Every review on the PR.
 * @param {string} headSha
 * @param {number} nowMs
 */
export function deriveReviewAck(reviews, headSha, nowMs) {
  const botReviews = (reviews ?? []).filter((review) => review.user?.login === BOT_REST_LOGIN);
  // An absent headSha must match nothing. Filtering on equality alone would let
  // `undefined === undefined` pair a review carrying no `commit_id` with a head
  // the caller never established — an ack invented out of two missing fields,
  // and the fail-OPEN direction.
  const headBotReviews = headSha ? botReviews.filter((review) => review.commit_id === headSha) : [];
  const latestHeadReview = selectNewestReview(headBotReviews);
  return {
    botReviews,
    headBotReviews,
    latestHeadReview,
    reviewAcksHead: latestHeadReview !== null,
    latestReviewAgeMs: latestHeadReview?.submitted_at
      ? nowMs - new Date(latestHeadReview.submitted_at).getTime()
      : Number.POSITIVE_INFINITY,
  };
}

/**
 * Ack shape (1): a `+1` reaction on the PR issue, at or after the ack anchor.
 *
 * Reactions carry no commit reference, so the timestamp is the only thing
 * binding one to the current HEAD — a stale `+1` from a pre-fix push would
 * otherwise falsely ack it (the PR #70 false-pass).
 *
 * @param {Array<object>} reactions
 * @param {number} ackAnchorMs From `derivePushAnchor`, NOT the commit time alone.
 */
export function deriveReactionAck(reactions, ackAnchorMs) {
  const botThumbsUp = (reactions ?? []).filter(
    (reaction) => reaction.user?.login === BOT_REST_LOGIN && reaction.content === "+1",
  );
  const freshThumbsUp = botThumbsUp.filter((reaction) =>
    isAtOrAfter(reaction.created_at, ackAnchorMs),
  );
  return { botThumbsUp, freshThumbsUp, reactionAcksHead: freshThumbsUp.length > 0 };
}

/**
 * Wall-clock age of the newest row in a set, or Infinity when the set is empty
 * or carries no parseable `created_at`.
 *
 * Every non-finite result collapses to Infinity rather than propagating. A NaN
 * age — from a missing `nowMs`, an unparseable stamp, or arithmetic on either —
 * fails EVERY `<` comparison, so it would read as "comfortably outside the
 * settle window" and wave through the exact false pass that window exists to
 * catch. Infinity means the same thing to a `<` test but says it deliberately.
 *
 * @param {Array<object>} rows
 * @param {number} nowMs
 * @returns {number}
 */
function newestCreatedAgeMs(rows, nowMs) {
  let newestCreatedMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const createdMs = new Date(row.created_at ?? Number.NaN).getTime();
    if (Number.isFinite(createdMs) && createdMs > newestCreatedMs) newestCreatedMs = createdMs;
  }
  const ageMs = nowMs - newestCreatedMs;
  return Number.isFinite(ageMs) ? ageMs : Number.POSITIVE_INFINITY;
}

/**
 * Comment-borne signals: three ack legs, a separate cleanliness assertion, a
 * separate findings assertion, and the usage-limits non-ack.
 *
 * The three ack legs are bound to HEAD by DIFFERENT anchors and must not be
 * collapsed. A comment carrying `**Reviewed commit:** \`<sha10>\`` names the
 * commit it reviewed, so the sha IS the anchor and no timestamp filter applies.
 * A findings summary is bound the same way, by the sha in its permalinks. The
 * clean-verdict comment carries no sha at all, so `created_at >= ackAnchorMs`
 * is the only thing tying it to the current push.
 *
 * "Acks HEAD" and "asserts HEAD is clean" are also kept apart, because folding
 * them together was a false pass. Citing a sha proves only that Codex looked at
 * this commit; it says nothing whatever about what it found. A findings-bearing
 * comment naming HEAD therefore satisfied the ack leg on its own, and in the
 * window before its inline threads materialise the gate saw an ack with zero
 * open threads and called it `ack_clean`. `commentAssertsClean` is the narrower
 * fact — a comment that both names this commit and declares it clean, or a
 * clean verdict fresh enough to belong to this push.
 *
 * `commentReportsFindings` is the opposite-signed narrow fact, and it is not the
 * negation of the other: most comments assert neither. It says the body carries
 * findings for THIS commit, which is what lets the caller distinguish "Codex
 * reviewed this and its findings are in a comment" from "Codex has not looked
 * yet" — two states that demand opposite next actions, and which the gate
 * previously collapsed into `no_ack_yet`.
 *
 * `latestCommentAckAgeMs` is the age of the NEWEST acking comment, and newest
 * rather than oldest is the conservative pick: the most recent ack is the one
 * whose threads are likeliest still in flight.
 *
 * The usage-limits non-ack takes the same freshness binding, which
 * failure-modes.md already documents and the gate had drifted from: because
 * `rate_limited` outranks every ack leg in computeVerdict, one historic
 * usage-limits comment pinned the gate to `rate_limited` permanently — even
 * after a later HEAD collected a valid clean ack.
 *
 * @param {Array<object>} comments
 * @param {{headShaShort: string, ackAnchorMs: number, nowMs: number}} anchors
 */
export function deriveCommentSignals(comments, { headShaShort, ackAnchorMs, nowMs }) {
  const botComments = (comments ?? []).filter((comment) => comment.user?.login === BOT_REST_LOGIN);
  // An absent or empty headShaShort must cite nothing. `"anything".includes("")`
  // is true, so an unset head would turn EVERY bot comment into a sha citation —
  // an ack invented out of a missing field, the same fail-OPEN that
  // `deriveReviewAck` guards on the review side.
  const citesHead = (body) => Boolean(headShaShort) && body?.includes(headShaShort) === true;
  const shaCitingComments = botComments.filter(
    (comment) => citesHead(comment.body) && /Reviewed commit/i.test(comment.body ?? ""),
  );
  const freshCleanVerdictComments = botComments.filter(
    (comment) =>
      CLEAN_VERDICT_PATTERN.test(comment.body ?? "") &&
      isAtOrAfter(comment.created_at, ackAnchorMs),
  );
  // Sha-cited AND clean: asserts cleanliness with no timestamp involved, which
  // is what keeps an escape hatch open when the push anchor is wrong.
  const cleanVerdictShaComments = shaCitingComments.filter((comment) =>
    CLEAN_VERDICT_PATTERN.test(comment.body ?? ""),
  );
  // Findings in a comment body bind to HEAD by the sha their permalinks carry,
  // with no timestamp involved — the same anchoring `shaCitingComments` uses, and
  // the same shape: the 10-char head prefix appearing anywhere in the body, a
  // substring test rather than an equality one, so a permalink to any commit
  // sharing those 10 hex chars matches too. That is git's own abbreviation width,
  // and a collision inside one PR's comments is not a practical risk. Binding to
  // the sha at all is the point: a summary naming an OLDER sha is findings against
  // a commit that has since been rewritten, and firing on it would pin the gate to
  // a stale verdict forever. PR #235 is that case — the author pushed 108 seconds
  // before the summary landed — and this leg staying silent there is the filter
  // working, not a gap.
  const findingsShaComments = botComments.filter(
    (comment) => FINDINGS_SUMMARY_PATTERN.test(comment.body ?? "") && citesHead(comment.body),
  );
  const freshRateLimitComments = botComments.filter(
    (comment) =>
      RATE_LIMIT_PATTERN.test(comment.body ?? "") && isAtOrAfter(comment.created_at, ackAnchorMs),
  );
  const ackComments = [
    ...new Set([...shaCitingComments, ...freshCleanVerdictComments, ...findingsShaComments]),
  ];
  return {
    botComments,
    shaCitingComments,
    freshCleanVerdictComments,
    cleanVerdictShaComments,
    findingsShaComments,
    freshRateLimitComments,
    ackComments,
    commentAcksHead: ackComments.length > 0,
    commentAssertsClean: cleanVerdictShaComments.length > 0 || freshCleanVerdictComments.length > 0,
    commentReportsFindings: findingsShaComments.length > 0,
    latestCommentAckAgeMs: newestCreatedAgeMs(ackComments, nowMs),
    rateLimited: freshRateLimitComments.length > 0,
  };
}

/**
 * Bot review threads that are still unresolved.
 *
 * Unresolved is the ENTIRE predicate; `isOutdated` is diagnostic metadata only.
 * GitHub's require-conversation-resolution keys on RESOLUTION, so a fix push
 * that marks a thread outdated without resolving it still blocks the merge.
 * Filtering outdated threads out dropped exactly those, and the gate reported
 * merge_ok=1 while GitHub reported BLOCKED — a false pass of the class this
 * script exists to kill.
 *
 * @param {Array<object>} threadNodes
 * @returns {{unresolved: Array<object>, outdatedCount: number}}
 */
export function selectUnresolvedBotThreads(threadNodes) {
  const unresolved = (threadNodes ?? []).filter(
    (thread) =>
      !thread.isResolved && thread.comments?.nodes?.[0]?.author?.login === BOT_GRAPHQL_LOGIN,
  );
  return {
    unresolved,
    outdatedCount: unresolved.filter((thread) => thread.isOutdated).length,
  };
}

/**
 * An age is usable only if it is a real number. NaN and undefined both map to
 * Infinity — "no evidence of recency" — because NaN fails every `<` comparison
 * and would otherwise read as "safely outside the settle window", re-opening
 * the false pass that window exists to close. `??` does not catch NaN, so the
 * test has to be `Number.isFinite`.
 *
 * @param {number | undefined} ageMs
 * @returns {number}
 */
function finiteAgeOrInfinity(ageMs) {
  return Number.isFinite(ageMs) ? ageMs : Number.POSITIVE_INFINITY;
}

/**
 * @typedef {object} CodexSignals
 * @property {boolean} isDraft                 PR is a draft (Codex does not auto-review drafts).
 * @property {boolean} isOpen                  PR state is OPEN — not CLOSED, not MERGED.
 * @property {boolean} headUnchanged           HEAD re-read after every probe still matches the snapshot they used.
 * @property {boolean} pushAnchorKnown         A check suite dated the push, so the ack anchor is server-side.
 * @property {boolean} rateLimited             Bot usage-limits comment at or after the ack anchor.
 * @property {boolean} reviewAcksHead          A bot review names the HEAD sha in its commit_id.
 * @property {boolean} reactionAcksHead        Bot +1 on the PR issue, at or after the ack anchor.
 * @property {boolean} commentAcksHead         Bot comment citing the HEAD sha, or a fresh clean verdict.
 * @property {boolean} commentAssertsClean     A bot comment asserts CLEAN, not merely that it read HEAD.
 * @property {boolean} commentReportsFindings  A bot comment carries findings for HEAD in its own body.
 * @property {number}  openThreadCount         Bot threads that are unresolved, outdated or not.
 * @property {number}  latestReviewAgeMs       Age of the newest HEAD-matching bot review; Infinity when none.
 * @property {number}  latestCommentAckAgeMs   Age of the newest acking bot comment; Infinity when none.
 * @property {boolean} [threadWindowTruncated] Review-thread connection did not drain fully.
 * @property {boolean} [checkWindowTruncated]  Check-rollup connection did not drain fully.
 * @property {"green"|"red"|"pending"|"none"} ciStatus
 * @property {string}  [mergeStateStatus]      GitHub's own MergeStateStatus for the PR.
 * @property {number}  [settleWindowMs]
 */

/**
 * @param {CodexSignals} signals
 * @returns {{verdict: string, ackOfHead: boolean, cleanAssertingAck: boolean, mergeOk: boolean, unsettled: boolean, unsettledAckLeg: "review"|"comment"|null, threadBearingAckAgeMs: number, signalTruncated: boolean}}
 */
export function computeVerdict(signals) {
  const settleWindowMs = signals.settleWindowMs ?? DEFAULT_SETTLE_WINDOW_MS;

  const ackOfHead = signals.reviewAcksHead || signals.reactionAcksHead || signals.commentAcksHead;

  // Exactly ONE shape is excluded from carrying a clean verdict: a comment that
  // acks HEAD without asserting HEAD is clean, when it is the ONLY ack. Citing a
  // sha — or filing findings against it — proves Codex read this commit and is
  // silent on what it found, so by itself it can never reach `ack_clean`.
  //
  // Written as a single named exclusion rather than as a general "an ack must
  // assert clean" rule, and the difference is not stylistic. The general form
  // silently drops any ack leg nobody remembers to re-add to it, and the live
  // example is the bare `+1`: Codex uses it to mean "no suggestions", so a
  // general rule would stop every reaction-only clean pass reaching `ack_clean`
  // and stall those merges — a worse regression than the false pass being
  // closed. The review leg is outside the exclusion for the same reason: a clean
  // pass posts no HEAD review at all, so a review ON head whose threads are every
  // one resolved is the ordinary fix-then-resolve-then-merge state.
  const unverdictedCommentIsTheOnlyAck =
    ackOfHead &&
    signals.reviewAcksHead !== true &&
    signals.reactionAcksHead !== true &&
    signals.commentAssertsClean !== true;
  const cleanAssertingAck = ackOfHead && !unverdictedCommentIsTheOnlyAck;

  // The settle window covers every ack leg that can be FOLLOWED by inline
  // threads — the review object and the acking comment — because the race it
  // guards is thread materialisation lagging the ack that announces it. Scoping
  // it to the review leg let a findings-bearing comment slip through the same
  // window on the comment side. A leg that did not fire contributes Infinity,
  // never a real age: feeding in the age of a leg the gate REJECTED would let
  // that leg shorten a window it has no standing in. The reaction leg stays out
  // on purpose — a +1 means "no suggestions", so nothing is pending behind it,
  // and gating it would stall every clean merge.
  const reviewAckAgeMs = signals.reviewAcksHead
    ? finiteAgeOrInfinity(signals.latestReviewAgeMs)
    : Number.POSITIVE_INFINITY;
  const commentAckAgeMs = signals.commentAcksHead
    ? finiteAgeOrInfinity(signals.latestCommentAckAgeMs)
    : Number.POSITIVE_INFINITY;
  const threadBearingAckAgeMs = Math.min(reviewAckAgeMs, commentAckAgeMs);
  const unsettled = signals.openThreadCount === 0 && threadBearingAckAgeMs < settleWindowMs;

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
    // mistaking "threads not yet materialised" for "clean"; here the answer is
    // already in hand, so waiting a window to re-ask a settled question would
    // only delay an actionable report.
    verdict = "ack_findings_no_threads";
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
    // Reached only by a citation with no recognisable body, so it is also where
    // an UNRECOGNISED comment shape lands — which is the fail-closed direction
    // and the reason this branch sits ahead of `ack_clean` rather than falling
    // through to it. Zero live instances across the 48-comment corpus survey;
    // every real findings pass carries a marker and lands on the branch above.
    verdict = "ack_without_verdict";
  } else if (ackOfHead) {
    verdict = "ack_clean";
  } else {
    verdict = "no_ack_yet";
  }

  // ciStatus "none" is an empty gating set — absence of evidence, not a pass.
  // `!signalTruncated` is redundant against the ladder above and deliberately
  // kept: it is the conjunct that survives a future reordering of the verdict
  // branches, the same defence the `unsettled` guard gets from `ack_clean`.
  //
  // `isOpen` is NOT redundant against mergeStateStatus. A merged PR happens to
  // report UNKNOWN today, which the last conjunct already refuses — but that is
  // an observed GitHub behaviour, not a documented contract, and nothing
  // promises a merged PR will never report CLEAN. Asking the question directly
  // also lets the caller name the real reason instead of blaming a phantom
  // merge requirement. Compared `=== true` so an absent signal fails closed,
  // matching how `mergeStateAllowsMerge` treats an absent merge state.
  //
  // `pushAnchorKnown` is the same shape of question about the freshness anchor.
  // Without a check suite to date the push, the anchor falls back to the
  // author-controlled commit time, and every timestamp-bound ack leg — the +1,
  // the clean-verdict comment, and the usage-limits non-ack — rests on it. A
  // window with no server-side sighting of the sha is already unmergeable for
  // other reasons today, but only incidentally, and this gate has been wrong
  // once already by blocking for a cause it could not name.
  //
  // `headUnchanged` is compared `=== true` while the verdict branch above tests
  // `=== false`, and the asymmetry is the point: a caller that never re-read
  // HEAD leaves the field undefined, which must not be reported as a move that
  // was observed, but equally must not authorise a merge on a head nobody
  // confirmed. Undefined therefore names no verdict and grants no merge.
  const mergeOk =
    verdict === "ack_clean" &&
    signals.isOpen === true &&
    signals.headUnchanged === true &&
    signals.pushAnchorKnown === true &&
    signals.ciStatus === "green" &&
    signals.openThreadCount === 0 &&
    !signalTruncated &&
    mergeStateAllowsMerge(signals.mergeStateStatus);

  return {
    verdict,
    ackOfHead,
    cleanAssertingAck,
    mergeOk,
    unsettled,
    unsettledAckLeg,
    threadBearingAckAgeMs,
    signalTruncated,
  };
}
