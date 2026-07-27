// node:test suite for lib/codex-verdict.mjs.
// Run via:
//   node --test .claude/skills/plan-execution/scripts/__tests__/codex-verdict.test.mjs
//
// The decision table is unit-tested rather than probed against live PRs because
// the highest-risk branch is unreachable from real data: every findings review in
// the repo is followed by a fix push, so no PR ever shows review.commit_id === HEAD.
// A live probe skips the guard entirely and still reports success.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeVerdict,
  deriveCiStatus,
  selectNewestRunPerName,
  DEFAULT_SETTLE_WINDOW_MS,
} from "../lib/codex-verdict.mjs";

/** A settled, fully clean PR: +1 on the issue, no reviews, CI green. */
function cleanSignals(overrides = {}) {
  return {
    isDraft: false,
    rateLimited: false,
    reviewAcksHead: false,
    reactionAcksHead: true,
    commentAcksHead: false,
    openThreadCount: 0,
    latestReviewAgeMs: Number.POSITIVE_INFINITY,
    ciStatus: "green",
    ...overrides,
  };
}

test("baseline: +1 reaction on green CI is a mergeable clean pass", () => {
  const result = computeVerdict(cleanSignals());
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.ackOfHead, true);
  assert.equal(result.mergeOk, true);
});

test("RACE: a fresh review on HEAD with no visible threads is NOT clean", () => {
  // Codex submits a findings review at T=0; its threads have not materialised.
  // Read naively this is indistinguishable from a clean pass, and scored
  // merge_ok=1 it would merge a PR that has open findings.
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      reviewAcksHead: true,
      openThreadCount: 0,
      latestReviewAgeMs: 3_000,
    }),
  );
  assert.equal(result.verdict, "ack_unsettled");
  assert.equal(result.unsettled, true);
  assert.equal(result.mergeOk, false, "must never merge inside the settle window");
});

test("RACE control: the settle window is what changes the verdict, nothing else", () => {
  // Same signals, window collapsed to zero. If this did NOT flip to ack_clean the
  // test above would be passing for some unrelated reason.
  const signals = cleanSignals({
    reactionAcksHead: false,
    reviewAcksHead: true,
    openThreadCount: 0,
    latestReviewAgeMs: 3_000,
    settleWindowMs: 0,
  });
  const result = computeVerdict(signals);
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("a review older than the settle window with no threads is a genuine clean pass", () => {
  const result = computeVerdict(
    cleanSignals({
      reactionAcksHead: false,
      reviewAcksHead: true,
      openThreadCount: 0,
      latestReviewAgeMs: DEFAULT_SETTLE_WINDOW_MS + 1,
    }),
  );
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("the settle guard does NOT apply to the reaction leg", () => {
  // A +1 means "no suggestions", so no threads are pending behind it. Holding
  // the reaction leg would stall every clean merge for two minutes.
  const result = computeVerdict(cleanSignals({ latestReviewAgeMs: 1_000 }));
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("open bot threads outrank any ack leg", () => {
  const result = computeVerdict(cleanSignals({ openThreadCount: 3 }));
  assert.equal(result.verdict, "ack_with_findings");
  assert.equal(result.mergeOk, false);
});

test("rate limiting is a NON-ack terminal that outranks everything", () => {
  const result = computeVerdict(cleanSignals({ rateLimited: true, openThreadCount: 2 }));
  assert.equal(result.verdict, "rate_limited");
  assert.equal(result.mergeOk, false);
});

test("a draft is not review-eligible", () => {
  const result = computeVerdict(cleanSignals({ isDraft: true }));
  assert.equal(result.verdict, "draft_not_eligible");
  assert.equal(result.mergeOk, false);
});

test("no ack of HEAD is never mergeable", () => {
  const result = computeVerdict(
    cleanSignals({ reactionAcksHead: false, reviewAcksHead: false, commentAcksHead: false }),
  );
  assert.equal(result.verdict, "no_ack_yet");
  assert.equal(result.ackOfHead, false);
  assert.equal(result.mergeOk, false);
});

test("a comment citing the HEAD sha is a valid ack leg on its own", () => {
  const result = computeVerdict(cleanSignals({ reactionAcksHead: false, commentAcksHead: true }));
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, true);
});

test("an empty check rollup is not a pass", () => {
  // "none" means no checks were reported — absence of evidence, not evidence of green.
  const result = computeVerdict(cleanSignals({ ciStatus: "none" }));
  assert.equal(result.verdict, "ack_clean");
  assert.equal(result.mergeOk, false);
});

for (const ciStatus of ["red", "pending", "none"]) {
  test(`mergeOk is false when CI is ${ciStatus}`, () => {
    assert.equal(computeVerdict(cleanSignals({ ciStatus })).mergeOk, false);
  });
}

test("invariant: mergeOk implies ack, zero open threads, and green CI", () => {
  const booleans = [true, false];
  const ciStates = ["green", "red", "pending", "none"];
  const threadCounts = [0, 1];
  const reviewAges = [1_000, DEFAULT_SETTLE_WINDOW_MS + 1];
  let mergeableCases = 0;

  for (const isDraft of booleans)
    for (const rateLimited of booleans)
      for (const reviewAcksHead of booleans)
        for (const reactionAcksHead of booleans)
          for (const commentAcksHead of booleans)
            for (const openThreadCount of threadCounts)
              for (const latestReviewAgeMs of reviewAges)
                for (const ciStatus of ciStates) {
                  const signals = {
                    isDraft,
                    rateLimited,
                    reviewAcksHead,
                    reactionAcksHead,
                    commentAcksHead,
                    openThreadCount,
                    latestReviewAgeMs,
                    ciStatus,
                  };
                  const result = computeVerdict(signals);
                  if (!result.mergeOk) continue;
                  mergeableCases += 1;
                  assert.equal(result.ackOfHead, true, JSON.stringify(signals));
                  assert.equal(openThreadCount, 0, JSON.stringify(signals));
                  assert.equal(ciStatus, "green", JSON.stringify(signals));
                  assert.equal(isDraft, false, JSON.stringify(signals));
                  assert.equal(rateLimited, false, JSON.stringify(signals));
                  assert.equal(result.unsettled, false, JSON.stringify(signals));
                }

  // Guard against the invariant passing vacuously because nothing was mergeable.
  assert.ok(mergeableCases > 0, "no mergeable case in the sweep — invariant proved nothing");
});

// --------------------------------------------------------------- CI rollup

function run(name, conclusion, startedAt) {
  return { name, conclusion, startedAt, completedAt: startedAt };
}

test("a superseded CANCELLED run beside its real SUCCESS does not make CI red", () => {
  // Verbatim shape observed on PR #256: a push cancelled the in-flight advisory
  // lychee run, and the rollup then carried both rows for the same check name.
  const rollup = [
    run("ci-gate", "SUCCESS", "2026-07-27T00:28:55Z"),
    run("lychee — outbound HTTP (advisory)", "CANCELLED", "2026-07-27T00:25:10Z"),
    run("lychee — outbound HTTP (advisory)", "SUCCESS", "2026-07-27T00:25:59Z"),
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.status, "green");
  assert.equal(result.failed.length, 0);
  assert.equal(result.considered.length, 2, "two distinct check names survive dedupe");
});

test("dedupe does NOT hide a cancellation that is the newest run", () => {
  // The inverse risk of the fix above: if dedupe suppressed cancellations
  // generally, the gate would go blind to real failures.
  const rollup = [
    run("flaky-job", "SUCCESS", "2026-07-27T00:25:10Z"),
    run("flaky-job", "CANCELLED", "2026-07-27T00:25:59Z"),
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.status, "red");
  assert.equal(result.failed.length, 1);
});

test("a genuine FAILURE on the newest run is red", () => {
  const result = deriveCiStatus([run("test", "FAILURE", "2026-07-27T00:25:10Z")]);
  assert.equal(result.status, "red");
});

test("an in-flight rerun leaves CI pending, not green", () => {
  const rollup = [
    run("test", "SUCCESS", "2026-07-27T00:25:10Z"),
    { name: "test", conclusion: null, status: "IN_PROGRESS", startedAt: "2026-07-27T00:26:00Z" },
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.status, "pending");
});

test("an empty rollup is 'none', never green", () => {
  assert.equal(deriveCiStatus([]).status, "none");
  assert.equal(deriveCiStatus(undefined).status, "none");
});

test("legacy commit statuses (context/state, no timestamps) still dedupe", () => {
  const rollup = [
    { context: "legacy/build", state: "FAILURE" },
    { context: "legacy/build", state: "SUCCESS", completedAt: "2026-07-27T00:30:00Z" },
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.considered.length, 1);
  assert.equal(result.status, "green");
});

test("selectNewestRunPerName keeps exactly one row per name", () => {
  const rollup = [
    run("a", "SUCCESS", "2026-07-27T00:01:00Z"),
    run("a", "SUCCESS", "2026-07-27T00:02:00Z"),
    run("b", "SUCCESS", "2026-07-27T00:01:00Z"),
  ];
  const names = selectNewestRunPerName(rollup).map((check) => check.name);
  assert.deepEqual(names.sort(), ["a", "b"]);
});
