/**
 * Pure verdict logic for the Codex review gate.
 *
 * Split out from codex-gate.mjs because the most dangerous branch — the
 * review-landed-before-its-threads race — cannot be reached from live GitHub
 * data. Every findings review in the repo is followed by a fix push, so no open
 * PR ever exhibits `review.commit_id === HEAD`; a probe against real PRs
 * therefore never executes the guard and reports success without testing it.
 * Isolating the decision table makes the race directly constructible.
 */

/** Window in which a review's threads may still be materialising. */
export const DEFAULT_SETTLE_WINDOW_MS = 120_000;

const FAILED_STATES = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "STARTUP_FAILURE"]);
const PENDING_STATES = new Set(["PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED"]);

/** Conclusion (check runs) or state (legacy commit statuses). */
export function checkState(check) {
  return check.conclusion || check.state || "PENDING";
}

function startedAtMs(check) {
  const stamp = check.startedAt ?? check.completedAt ?? null;
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
 * @param {Array<object>} checks Raw `statusCheckRollup` rows.
 * @returns {{status: "green"|"red"|"pending"|"none", failed: Array<object>, pending: Array<object>, considered: Array<object>}}
 */
export function deriveCiStatus(checks) {
  const considered = selectNewestRunPerName(checks ?? []);
  const failed = considered.filter((check) => FAILED_STATES.has(checkState(check)));
  const pending = considered.filter((check) => PENDING_STATES.has(checkState(check)));

  // An empty rollup is NOT green. Checks can be absent because none are configured,
  // because none have been reported yet, or because the rollup call degraded — none
  // of which is evidence that CI passed. Calling that "green" is a fail-open that
  // would let merge_ok go true on a PR nothing has actually verified.
  const status =
    considered.length === 0
      ? "none"
      : failed.length > 0
        ? "red"
        : pending.length > 0
          ? "pending"
          : "green";

  return { status, failed, pending, considered };
}

/**
 * @typedef {object} CodexSignals
 * @property {boolean} isDraft            PR is a draft (Codex does not auto-review drafts).
 * @property {boolean} rateLimited        Bot posted a usage-limits comment.
 * @property {boolean} reviewAcksHead     Newest bot review's commit_id === HEAD sha.
 * @property {boolean} reactionAcksHead   Bot +1 on the PR issue, newer than the HEAD commit.
 * @property {boolean} commentAcksHead    Bot comment citing the HEAD sha.
 * @property {number}  openThreadCount    Bot threads that are unresolved AND not outdated.
 * @property {number}  latestReviewAgeMs  Age of the newest bot review; Infinity when none.
 * @property {"green"|"red"|"pending"|"none"} ciStatus
 * @property {number}  [settleWindowMs]
 */

/**
 * @param {CodexSignals} signals
 * @returns {{verdict: string, ackOfHead: boolean, mergeOk: boolean, unsettled: boolean}}
 */
export function computeVerdict(signals) {
  const settleWindowMs = signals.settleWindowMs ?? DEFAULT_SETTLE_WINDOW_MS;

  const ackOfHead = signals.reviewAcksHead || signals.reactionAcksHead || signals.commentAcksHead;

  // Scoped to the review leg only. A +1 means "no suggestions", so nothing is
  // pending behind it; gating the reaction leg would stall every clean merge.
  const unsettled =
    signals.reviewAcksHead &&
    signals.openThreadCount === 0 &&
    signals.latestReviewAgeMs < settleWindowMs;

  let verdict;
  if (signals.rateLimited) {
    verdict = "rate_limited";
  } else if (signals.isDraft) {
    verdict = "draft_not_eligible";
  } else if (ackOfHead && signals.openThreadCount > 0) {
    verdict = "ack_with_findings";
  } else if (unsettled) {
    verdict = "ack_unsettled";
  } else if (ackOfHead) {
    verdict = "ack_clean";
  } else {
    verdict = "no_ack_yet";
  }

  // ciStatus "none" is an empty rollup — absence of evidence, not a pass.
  const mergeOk =
    verdict === "ack_clean" && signals.ciStatus === "green" && signals.openThreadCount === 0;

  return { verdict, ackOfHead, mergeOk, unsettled };
}
