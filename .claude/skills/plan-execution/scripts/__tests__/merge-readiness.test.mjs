// Tests for lib/merge-readiness.mjs: the status-check rollup and the merge state.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveCiStatus,
  mergeStateAllowsMerge,
  partitionByRequirement,
  selectNewestRunPerName,
} from "../lib/merge-readiness.mjs";

// --------------------------------------------------------------- CI rollup

function run(name, conclusion, startedAt, extra = {}) {
  return { name, conclusion, startedAt, completedAt: startedAt, ...extra };
}

test("a superseded CANCELLED run beside its real SUCCESS does not make CI red", () => {
  // A push cancels the in-flight advisory lychee run, and the rollup then carries
  // both rows for the same check name.
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
  // The inverse risk of the dedupe above: if it suppressed cancellations
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

test("legacy commit statuses dedupe on createdAt, the only stamp they carry", () => {
  const rollup = [
    { context: "legacy/build", state: "SUCCESS", createdAt: "2026-07-27T00:30:00Z" },
    { context: "legacy/build", state: "FAILURE", createdAt: "2026-07-27T00:31:00Z" },
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.considered.length, 1);
  assert.equal(result.status, "red", "the newer status must win");
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

// ------------------------------------------- CI conclusion / state coverage

// Every member of the three GraphQL enums this gate can receive. The
// classification is INVERTED — anything that is neither success-like nor pending
// is failed — so an unenumerated member blocks the merge instead of scoring green.
// ACTION_REQUIRED and STALE are the two a list of failures would miss.
const CHECK_CONCLUSION_EXPECTATIONS = {
  SUCCESS: "green",
  NEUTRAL: "green",
  SKIPPED: "green",
  ACTION_REQUIRED: "red",
  TIMED_OUT: "red",
  CANCELLED: "red",
  FAILURE: "red",
  STARTUP_FAILURE: "red",
  STALE: "red",
};

const CHECK_STATUS_EXPECTATIONS = {
  REQUESTED: "pending",
  QUEUED: "pending",
  IN_PROGRESS: "pending",
  WAITING: "pending",
  PENDING: "pending",
  // A finished run whose conclusion has not propagated yet. Not evidence of
  // anything, so it waits rather than flapping the gate red.
  COMPLETED: "pending",
};

const STATUS_STATE_EXPECTATIONS = {
  SUCCESS: "green",
  PENDING: "pending",
  EXPECTED: "pending",
  ERROR: "red",
  FAILURE: "red",
};

for (const [conclusion, expected] of Object.entries(CHECK_CONCLUSION_EXPECTATIONS)) {
  test(`CheckConclusionState ${conclusion} classifies as ${expected}`, () => {
    const rollup = [{ name: "check", status: "COMPLETED", conclusion }];
    assert.equal(deriveCiStatus(rollup).status, expected);
  });
}

for (const [status, expected] of Object.entries(CHECK_STATUS_EXPECTATIONS)) {
  test(`CheckStatusState ${status} (no conclusion yet) classifies as ${expected}`, () => {
    const rollup = [{ name: "check", conclusion: null, status }];
    assert.equal(deriveCiStatus(rollup).status, expected);
  });
}

for (const [state, expected] of Object.entries(STATUS_STATE_EXPECTATIONS)) {
  test(`StatusState ${state} classifies as ${expected}`, () => {
    const rollup = [{ context: "legacy/check", state }];
    assert.equal(deriveCiStatus(rollup).status, expected);
  });
}

test("a conclusion GitHub has not invented yet is failed, not green", () => {
  // The point of inverting the classification: an unknown member fails closed.
  const rollup = [{ name: "check", status: "COMPLETED", conclusion: "SOME_FUTURE_STATE" }];
  assert.equal(deriveCiStatus(rollup).status, "red");
});

test("a row carrying no state at all is pending, never green", () => {
  assert.equal(deriveCiStatus([{ name: "check" }]).status, "pending");
});

// ---------------------------------------------- required vs advisory checks

test("only isRequired rows gate when any row reports isRequired", () => {
  const rollup = [
    run("ci-gate", "SUCCESS", "2026-07-27T00:28:55Z", { isRequired: true }),
    run("docs-corpus-gate", "SUCCESS", "2026-07-27T00:28:55Z", { isRequired: true }),
    run("lychee — outbound HTTP (advisory)", "FAILURE", "2026-07-27T00:25:59Z", {
      isRequired: false,
    }),
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.mode, "required-only");
  assert.equal(result.status, "green", "a transient advisory failure must not block the merge");
  assert.equal(result.gating.length, 2);
  assert.equal(result.failed.length, 0);
  assert.equal(result.advisoryFailed.length, 1, "the advisory failure is still reported");
  assert.equal(result.considered.length, 3, "every deduped row is still accounted for");
});

test('a check NAMED "(required)" that reports isRequired:false does not gate', () => {
  // The live trap on this repo: `lychee — inbound anchors (required)` and
  // `lane boundary — plan-title token (required)` both carry "(required)" in
  // their names and both report isRequired:false. Branch protection lists only
  // ci-gate and docs-corpus-gate, so isRequired is the only authority and
  // name-matching would gate on the wrong set.
  const rollup = [
    run("ci-gate", "SUCCESS", "2026-07-27T00:28:55Z", { isRequired: true }),
    run("lychee — inbound anchors (required)", "FAILURE", "2026-07-27T00:25:59Z", {
      isRequired: false,
    }),
  ];
  assert.equal(deriveCiStatus(rollup).status, "green");
});

test("a failing REQUIRED check is still red while advisory checks pass", () => {
  const rollup = [
    run("ci-gate", "FAILURE", "2026-07-27T00:28:55Z", { isRequired: true }),
    run("lychee — outbound HTTP (advisory)", "SUCCESS", "2026-07-27T00:25:59Z", {
      isRequired: false,
    }),
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.status, "red");
  assert.equal(result.failed.length, 1);
});

test("a pending REQUIRED check holds the gate even when everything else is green", () => {
  const rollup = [
    { name: "ci-gate", conclusion: null, status: "IN_PROGRESS", isRequired: true },
    run("gitleaks", "SUCCESS", "2026-07-27T00:25:59Z", { isRequired: false }),
  ];
  assert.equal(deriveCiStatus(rollup).status, "pending");
});

test("degradation: with no isRequired row at all, EVERY check gates", () => {
  // Unprotected branch, or a rollup fetched without the field. Falling back to
  // the conservative set keeps the gate safe; codex-gate.mjs prints the mode so
  // the degradation is never silent.
  const rollup = [
    run("ci-gate", "SUCCESS", "2026-07-27T00:28:55Z"),
    run("lychee — outbound HTTP (advisory)", "FAILURE", "2026-07-27T00:25:59Z"),
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.mode, "all-checks");
  assert.equal(result.status, "red");
  assert.equal(result.advisory.length, 0, "nothing is advisory when nothing is required");
});

test("degradation control: adding one isRequired row flips the same rollup to green", () => {
  // Proves the test above is driven by the missing field, not by the failure.
  const rollup = [
    run("ci-gate", "SUCCESS", "2026-07-27T00:28:55Z", { isRequired: true }),
    run("lychee — outbound HTTP (advisory)", "FAILURE", "2026-07-27T00:25:59Z"),
  ];
  const result = deriveCiStatus(rollup);
  assert.equal(result.mode, "required-only");
  assert.equal(result.status, "green");
});

test("partitionByRequirement treats absent and false isRequired identically", () => {
  const checks = [
    { name: "required", isRequired: true },
    { name: "explicitly-advisory", isRequired: false },
    { name: "field-absent" },
  ];
  const { gating, advisory, mode } = partitionByRequirement(checks);
  assert.equal(mode, "required-only");
  assert.deepEqual(
    gating.map((check) => check.name),
    ["required"],
  );
  assert.deepEqual(
    advisory.map((check) => check.name),
    ["explicitly-advisory", "field-absent"],
  );
});

test("a rollup of only advisory FAILURES is red, not green", () => {
  // Degradation must not become a way to pass: with no required row, the
  // advisory failure gates.
  const rollup = [run("advisory", "FAILURE", "2026-07-27T00:25:59Z", { isRequired: false })];
  assert.equal(deriveCiStatus(rollup).status, "red");
});

// ------------------------------------------------------------- merge state

test("mergeStateAllowsMerge accepts exactly the three mergeable MergeStateStatus values", () => {
  // Every member of GitHub's MergeStateStatus enum.
  const expectations = {
    CLEAN: true,
    HAS_HOOKS: true,
    UNSTABLE: true, // mergeable with a non-passing ADVISORY status
    BLOCKED: false,
    BEHIND: false,
    DIRTY: false,
    UNKNOWN: false,
  };
  for (const [mergeStateStatus, allowed] of Object.entries(expectations)) {
    assert.equal(mergeStateAllowsMerge(mergeStateStatus), allowed, mergeStateStatus);
  }
});
