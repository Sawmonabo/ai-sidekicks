// Tests for lib/observation-baseline.mjs: the gate's first sighting of a head, stored on disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeBaseline, resolveBaselinePath } from "../lib/observation-baseline.mjs";
import { HEAD_SHA, OTHER_FULL_SHA } from "./codex-signals.test-support.mjs";

// ------------------------------------------ the baseline store on disk

/** A throwaway state dir; every store test gets its own so none can see another's. */
function withStateDir(run) {
  const stateDir = mkdtempSync(join(tmpdir(), "codex-gate-baseline-"));
  try {
    return run(stateDir);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

const BASELINE_PR = 259;

test("the first sighting is stamped, and reports itself as the first", () => {
  withStateDir((stateDir) => {
    const nowMs = Date.parse("2026-07-27T20:56:24Z");
    const result = observeBaseline({ stateDir, prNumber: BASELINE_PR, headSha: HEAD_SHA, nowMs });
    assert.equal(result.baselineKnown, true);
    assert.equal(result.observedAtMs, nowMs);
    assert.equal(result.firstObservation, true);
    assert.equal(result.baselineError, null);
  });
});

test("a later poll adopts the EARLIER stamp — the floor never ratchets forward", () => {
  // The concurrency case, and the direction matters. If a second run could move
  // the baseline forward it would land on top of an ack that had already
  // arrived, refusing a verdict the first run would have accepted — a stall
  // manufactured by polling twice.
  withStateDir((stateDir) => {
    const firstMs = Date.parse("2026-07-27T20:56:24Z");
    const laterMs = Date.parse("2026-07-27T21:30:00Z");
    observeBaseline({ stateDir, prNumber: BASELINE_PR, headSha: HEAD_SHA, nowMs: firstMs });
    const second = observeBaseline({
      stateDir,
      prNumber: BASELINE_PR,
      headSha: HEAD_SHA,
      nowMs: laterMs,
    });
    assert.equal(second.observedAtMs, firstMs);
    assert.equal(second.firstObservation, false);
    assert.equal(second.baselineKnown, true);
  });
});

test("a different sha on the same PR gets its own baseline", () => {
  withStateDir((stateDir) => {
    const firstMs = Date.parse("2026-07-27T20:00:00Z");
    const secondMs = Date.parse("2026-07-27T21:00:00Z");
    observeBaseline({ stateDir, prNumber: BASELINE_PR, headSha: HEAD_SHA, nowMs: firstMs });
    const other = observeBaseline({
      stateDir,
      prNumber: BASELINE_PR,
      headSha: OTHER_FULL_SHA,
      nowMs: secondMs,
    });
    assert.equal(other.observedAtMs, secondMs);
    assert.equal(other.firstObservation, true);
  });
});

test("a corrupt record is unusable, not silently re-stamped as now", () => {
  // Re-stamping would be the tempting repair and it is the false-merge
  // direction: `now` post-dates every ack on the PR, so the gate would go on
  // to reject genuine acks while reporting a healthy baseline.
  withStateDir((stateDir) => {
    writeFileSync(
      resolveBaselinePath({ stateDir, prNumber: BASELINE_PR, headSha: HEAD_SHA }),
      "{not json",
    );
    const result = observeBaseline({
      stateDir,
      prNumber: BASELINE_PR,
      headSha: HEAD_SHA,
      nowMs: Date.now(),
    });
    assert.equal(result.baselineKnown, false);
    assert.equal(result.observedAtMs, null);
    assert.match(result.baselineError, /unreadable or corrupt/);
  });
});

test("a record naming ANOTHER sha is refused rather than adopted", () => {
  withStateDir((stateDir) => {
    writeFileSync(
      resolveBaselinePath({ stateDir, prNumber: BASELINE_PR, headSha: HEAD_SHA }),
      JSON.stringify({ pr: BASELINE_PR, sha: OTHER_FULL_SHA, observedAtMs: 1 }),
    );
    const result = observeBaseline({
      stateDir,
      prNumber: BASELINE_PR,
      headSha: HEAD_SHA,
      nowMs: Date.now(),
    });
    assert.equal(result.baselineKnown, false);
    assert.match(result.baselineError, /records sha/);
  });
});

test("a record with an unusable timestamp is refused", () => {
  withStateDir((stateDir) => {
    writeFileSync(
      resolveBaselinePath({ stateDir, prNumber: BASELINE_PR, headSha: HEAD_SHA }),
      JSON.stringify({ pr: BASELINE_PR, sha: HEAD_SHA, observedAtMs: "whenever" }),
    );
    const result = observeBaseline({
      stateDir,
      prNumber: BASELINE_PR,
      headSha: HEAD_SHA,
      nowMs: Date.now(),
    });
    assert.equal(result.baselineKnown, false);
    assert.match(result.baselineError, /no usable observedAtMs/);
  });
});

test("a DIRECTORY sitting on the record path is refused, and is a deletable one", () => {
  // Worth pinning because the errno is counter-intuitive. `O_CREAT | O_EXCL`
  // against an existing directory reports EEXIST, not EISDIR — the exclusivity
  // check fires before anything looks at the inode type — so this takes the
  // re-read path and surfaces as an unusable record rather than as an unwritable
  // one. That is the right remediation anyway (delete it), so the classification
  // is correct; it is simply not the one the code shape suggests.
  withStateDir((stateDir) => {
    mkdirSync(resolveBaselinePath({ stateDir, prNumber: BASELINE_PR, headSha: HEAD_SHA }));
    const result = observeBaseline({
      stateDir,
      prNumber: BASELINE_PR,
      headSha: HEAD_SHA,
      nowMs: Date.now(),
    });
    assert.equal(result.baselineKnown, false);
    assert.equal(result.baselineWritable, true, "deletable, so the remediation is to delete it");
    assert.match(result.baselineError, /unreadable or corrupt/);
  });
});

test("a write that fails for any NON-EEXIST reason reports NOT WRITABLE", () => {
  // The two failures need different remediations — delete the file vs repair the
  // path — so the flag has to survive the return rather than collapsing.
  //
  // Provoked with an over-long filename rather than with chmod, deliberately: a
  // permission probe is bypassed when the suite runs as root, which would leave
  // this arm silently unexercised in exactly the environments where nobody is
  // watching. ENAMETOOLONG does not care who is asking.
  withStateDir((stateDir) => {
    const result = observeBaseline({
      stateDir,
      prNumber: "9".repeat(5000),
      headSha: HEAD_SHA,
      nowMs: Date.now(),
    });
    assert.equal(result.baselineKnown, false);
    assert.equal(result.baselineWritable, false);
    assert.match(result.baselineError, /not writable/);
  });
});

test("a state directory that cannot be created is reported, not thrown", () => {
  withStateDir((stateDir) => {
    const blocked = join(stateDir, "a-file");
    writeFileSync(blocked, "not a directory");
    const result = observeBaseline({
      stateDir: join(blocked, "nested"),
      prNumber: BASELINE_PR,
      headSha: HEAD_SHA,
      nowMs: Date.now(),
    });
    assert.equal(result.baselineKnown, false);
    assert.equal(result.baselineWritable, false);
    assert.match(result.baselineError, /not creatable/);
  });
});
