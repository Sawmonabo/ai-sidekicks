/**
 * The gate's own first sighting of a sha as a PR's HEAD, persisted per
 * `(pr, sha)` so it survives across invocations.
 *
 * WHY THIS EXISTS, and why the thing it replaces could not be repaired in place.
 * Every timestamp-bound ack leg needs a floor: an instant the ack must post-date
 * to belong to the current head. Three review rounds attacked that floor and
 * each found a different way under it. The local commit time is written by the
 * author's clock, so the commit-to-push gap is a window (round 2). The earliest
 * `check_suite.created_at` is a server-side sighting of the SHA, not of the head
 * update, so a sha pushed earlier on another branch carries a suite that
 * predates this PR entirely (round 5). Both are proxies for a moment GitHub does
 * not expose, and a proxy that has been predated twice will be predated again.
 *
 * GitHub genuinely does not expose it. `Commit.pushedDate` is null.
 * `PullRequest.timelineItems` `PullRequestCommit` nodes carry no `createdAt` at
 * all — verified on PR #259, all seven commits, 2026-07-27. The REST issue
 * timeline's only sha-bearing event is `committed`, whose timestamp is the same
 * author-controlled committer date round 2 already disproved. There is no
 * `head_ref_updated` event for an ordinary push. So there is nothing to query,
 * and a fourth server-side proxy is not available to try.
 *
 * What IS available is the gate's own observation. The first time this gate sees
 * sha X as PR N's HEAD, X is already HEAD — so that instant is at or after the
 * head update by construction, with no proxy in between. It cannot be predated
 * by anything that happened on another branch, during a previous head's review,
 * or in the author's commit-to-push gap, because none of those are moments this
 * gate observed X as HEAD. That is a floor rather than a stand-in for one.
 *
 * SCOPE, stated honestly in both directions. This closes the anchor class. It
 * does NOT close attribution: an ack that lands after the floor may still be the
 * tail of a run for a previous head, because that run finishes after the push
 * and therefore usually after this baseline too. `deriveStaleRunEvidence` is the
 * predicate for that question and neither one subsumes the other.
 *
 * And its protective value against CURRENTLY OBSERVED shapes is near zero, which
 * is worth writing down rather than discovering later: every clean verdict Codex
 * has posted since 2026-06-22 carries a `Reviewed commit:` line, and every
 * sha-bound leg bypasses this floor entirely. This exists for the timestamp-only
 * legs — the bare `+1` above all — which are legacy or unobserved today but are
 * the shapes with no other binding to HEAD.
 *
 * @module observation-baseline
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Filename for one `(pr, sha)` record.
 *
 * One file per pair rather than one file per PR holding a sha map, and that is
 * what makes the write race-free. A map demands read-modify-write, so two polls
 * of the same PR interleave and the later write can clobber a baseline the
 * earlier one already committed to. A dedicated path lets the create itself be
 * the mutual exclusion — see `observeBaseline`.
 *
 * The sha is truncated for readability only; it is also written into the record
 * body, and `observeBaseline` verifies the body rather than trusting the name.
 *
 * @param {{stateDir: string, prNumber: number | string, headSha: string}} input
 * @returns {string}
 */
export function resolveBaselinePath({ stateDir, prNumber, headSha }) {
  return join(stateDir, `codex-gate-baseline-PR${prNumber}-${String(headSha).slice(0, 12)}.json`);
}

/**
 * Read the baseline for `(pr, sha)`, creating it on first sight.
 *
 * The create is `wx` — exclusive, fails if the path exists — so it is atomic
 * against a concurrent gate run rather than merely unlikely to collide. This
 * repo runs multiple agents against one PR, so two polls landing in the same
 * second is an ordinary event, not a corner case. On `EEXIST` the loser re-reads
 * and adopts the winner's stamp, which is the correct outcome: the EARLIER
 * observation is the true first sighting, and a later writer must never be able
 * to move the floor forward onto an ack that has already landed.
 *
 * FAILURE IS NOT COLLAPSED INTO SUCCESS. An unwritable or unparseable record
 * returns `baselineKnown: false` with no timestamp, never a silent `nowMs`.
 * Substituting `nowMs` would look like elegant fail-closed behaviour and would
 * instead be unrecoverable: the caller cannot distinguish "this ack really does
 * predate the first sighting" from "the store is broken", so it prints the wrong
 * remediation, and every subsequent call stamps a fresh `now` that also
 * post-dates whatever the operator re-triggered. The two states get two
 * remediations, so the flag has to survive the return.
 *
 * A record whose body names a DIFFERENT sha is treated as unusable rather than
 * adopted. That only happens through filename collision or hand-editing, and
 * adopting it would silently anchor this head to another commit's sighting —
 * the exact confusion this module exists to end.
 *
 * @param {{stateDir: string, prNumber: number | string, headSha: string, nowMs: number}} input
 * @returns {{observedAtMs: number | null, baselineKnown: boolean, baselineWritable: boolean,
 *   firstObservation: boolean, baselinePath: string, baselineError: string | null}}
 */
export function observeBaseline({ stateDir, prNumber, headSha, nowMs }) {
  const baselinePath = resolveBaselinePath({ stateDir, prNumber, headSha });
  const absent = (baselineError, baselineWritable) => ({
    observedAtMs: null,
    baselineKnown: false,
    baselineWritable,
    firstObservation: false,
    baselinePath,
    baselineError,
  });

  try {
    mkdirSync(stateDir, { recursive: true });
  } catch (error) {
    return absent(`state directory ${stateDir} is not creatable: ${error.message}`, false);
  }

  const record = JSON.stringify({
    pr: Number(prNumber),
    sha: headSha,
    observedAtMs: nowMs,
    observedAt: new Date(nowMs).toISOString(),
  });

  try {
    writeFileSync(baselinePath, record, { flag: "wx" });
    return {
      observedAtMs: nowMs,
      baselineKnown: true,
      baselineWritable: true,
      firstObservation: true,
      baselinePath,
      baselineError: null,
    };
  } catch (error) {
    if (error.code !== "EEXIST") {
      return absent(`baseline is not writable at ${baselinePath}: ${error.message}`, false);
    }
  }

  // EEXIST: some earlier run — possibly one still in flight — already stamped
  // this pair. Its value wins.
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (error) {
    return absent(
      `baseline at ${baselinePath} is unreadable or corrupt: ${error.message}. Delete it to re-stamp.`,
      true,
    );
  }
  if (parsed?.sha !== headSha) {
    return absent(
      `baseline at ${baselinePath} records sha ${parsed?.sha ?? "(none)"}, not ${headSha}. Delete it to re-stamp.`,
      true,
    );
  }
  if (!Number.isFinite(parsed?.observedAtMs)) {
    return absent(
      `baseline at ${baselinePath} carries no usable observedAtMs. Delete it to re-stamp.`,
      true,
    );
  }
  return {
    observedAtMs: parsed.observedAtMs,
    baselineKnown: true,
    baselineWritable: true,
    firstObservation: false,
    baselinePath,
    baselineError: null,
  };
}
