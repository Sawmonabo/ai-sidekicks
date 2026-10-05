/**
 * GitHub's side of merge readiness for the Codex review gate: the status-check rollup reduced to
 * one CI status, and the merge state that backstops it. codex-verdict.mjs decides on both.
 */

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
 * and on this path it is load-bearing rather than defense in depth. The returned
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
 * @returns {{status: "green"|"red"|"pending"|"none", failed: Array<object>, pending: Array<object>,
 *     considered: Array<object>, gating: Array<object>, advisory: Array<object>,
 *     advisoryFailed: Array<object>, mode: "required-only"|"all-checks"}}
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
