import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideHousekeeperRouting,
  assertRepoRelative,
  extractProposedEntry,
  enrichEntryWithDag,
  buildFinalManifestEntry,
} from "../../lib/housekeeper-orchestrator-helpers.mjs";
import { buildProposedManifestEntry } from "../post-merge-housekeeper.mjs";

// ───────────────────────────────────────────────────────────────────────────
// decideHousekeeperRouting — exit-code → proceed/halt mapping
//
// These tests pin the mapping so a future drift in the helper surfaces as a
// test failure rather than a runtime misroute. One test per documented exit
// class plus a defensive-fallback test.
// ───────────────────────────────────────────────────────────────────────────

test("decideHousekeeperRouting: exit 0 (success) → proceed", () => {
  const routing = decideHousekeeperRouting({ scriptExitCode: 0 });
  assert.deepEqual(routing, { action: "proceed" });
});

test("decideHousekeeperRouting: exit 6 (script crash boundary) → halt script-crash", () => {
  const routing = decideHousekeeperRouting({ scriptExitCode: 6 });
  assert.equal(routing.action, "halt");
  assert.equal(routing.exitClass, "script-crash");
  assert.match(routing.reason, /crash/);
  assert.match(routing.surfacePromptTemplate, /Operator action required/);
});

test("decideHousekeeperRouting: exit 137 (killed by SIGKILL — common crash) → halt script-crash", () => {
  const routing = decideHousekeeperRouting({ scriptExitCode: 137 });
  assert.equal(routing.action, "halt");
  assert.equal(routing.exitClass, "script-crash");
});

test("decideHousekeeperRouting: defensive fallback for unrecognized exit (negative integer) → halt unknown-exit-code", () => {
  const routing = decideHousekeeperRouting({ scriptExitCode: -1 });
  assert.equal(routing.action, "halt");
  assert.equal(routing.exitClass, "unknown-exit-code");
  assert.match(routing.reason, /unrecognized/);
  assert.match(routing.surfacePromptTemplate, /Operator action required/);
});

test("decideHousekeeperRouting: defensive fallback for non-integer exit (e.g. NaN) → halt unknown-exit-code (not proceed)", () => {
  const routing = decideHousekeeperRouting({ scriptExitCode: NaN });
  assert.equal(routing.action, "halt");
  assert.equal(routing.exitClass, "unknown-exit-code");
});

// ──────────────────────────────────────────────────────────────────────────
// assertRepoRelative — repo-relative path containment
//
// A caller that joins a declared path against the repo root and then reads it
// must first check the path was repo-relative: an absolute path or a
// parent-traversal resolves outside the tree and dead-ends a later
// `git add` with an "outside repository pathspec" error.
//
// Containment is lexical — repo-relative shape plus non-traversal. These four
// tests cover the three branches of the helper (absolute reject, traversal
// reject, accept) plus the internal-navigation shape that stays in the repo.
// ──────────────────────────────────────────────────────────────────────────

test("assertRepoRelative: rejects absolute paths with contract-anchored gap", () => {
  const result = assertRepoRelative("/etc/passwd", "/repo");
  assert.equal(result.ok, false);
  assert.match(result.gap, /^\/etc\/passwd is an absolute path/);
  assert.match(result.gap, /subagent contract requires repo-relative paths under \/repo/);
});

test("assertRepoRelative: rejects parent-traversal paths that escape the repo", () => {
  const result = assertRepoRelative("../../etc/passwd", "/repo");
  assert.equal(result.ok, false);
  assert.match(result.gap, /^\.\.\/\.\.\/etc\/passwd resolves outside the repository/);
  assert.match(result.gap, /subagent contract requires repo-relative paths under \/repo/);
});

test("assertRepoRelative: accepts internal navigation that stays inside the repo", () => {
  // `foo/../bar` resolves to `bar` within /repo — this is a legitimate
  // (if redundant) shape; the validator's job is containment, not style.
  // The negative case `..hidden.md` (literal dotfile-with-extension) also
  // passes because `relative()` returns `..hidden.md` with no separator —
  // distinct from `..` or `../foo`.
  const okResult = assertRepoRelative("foo/../bar", "/repo");
  assert.equal(okResult.ok, true);
  assert.equal(okResult.full, "/repo/bar");

  const dotfileResult = assertRepoRelative("..hidden.md", "/repo");
  assert.equal(dotfileResult.ok, true);
  assert.equal(dotfileResult.full, "/repo/..hidden.md");
});

test("assertRepoRelative: accepts normal repo-relative paths and returns joined absolute path", () => {
  const result = assertRepoRelative("docs/architecture/system-context.md", "/repo");
  assert.equal(result.ok, true);
  assert.equal(result.full, "/repo/docs/architecture/system-context.md");
});

test("I-3 invariant: post-merge-housekeeper.mjs does NOT import child_process or shell out for git", () => {
  const src = readFileSync(
    ".claude/skills/plan-execution/scripts/post-merge-housekeeper.mjs",
    "utf8",
  );
  // Mechanical guard 1: no `import ... from "node:child_process"` or `require('child_process')`
  assert.doesNotMatch(
    src,
    /(?:import\s+[^;]*from\s+["']node:child_process["']|require\(["']child_process["']\))/,
    "I-3 invariant violated: post-merge-housekeeper.mjs imports child_process — script must not shell out (orchestrator passes diff via flag/file)",
  );
  // Mechanical guard 2: no `spawn('git'` or `execSync('git'` callsite even if child_process imported via dynamic import
  assert.doesNotMatch(
    src,
    /(?:spawn|exec|execSync|spawnSync)\s*\(\s*["']git["']/,
    "I-3 invariant violated: post-merge-housekeeper.mjs invokes git directly — orchestrator-only responsibility",
  );
});

// ---------- buildProposedManifestEntry (script-side) ----------

test("buildProposedManifestEntry: returns null when --squash-sha is missing", () => {
  const args = {
    plan: "024",
    phase: "1",
    task: "T-024-1-1",
    prNumber: 30,
    squashSha: null,
    mergedAt: "2026-05-05",
  };
  assert.equal(buildProposedManifestEntry({ args, diffTouchedFiles: ["a.rs"] }), null);
});

test("buildProposedManifestEntry: returns null when --merged-at is missing", () => {
  const args = {
    plan: "024",
    phase: "1",
    task: "T-024-1-1",
    prNumber: 30,
    squashSha: "deadbee",
    mergedAt: null,
  };
  assert.equal(buildProposedManifestEntry({ args, diffTouchedFiles: ["a.rs"] }), null);
});

test("buildProposedManifestEntry: returns null when task is missing", () => {
  const args = {
    plan: "024",
    phase: "1",
    task: null,
    prNumber: 30,
    squashSha: "deadbee",
    mergedAt: "2026-05-05",
  };
  assert.equal(buildProposedManifestEntry({ args, diffTouchedFiles: ["a.rs"] }), null);
});

test("buildProposedManifestEntry: returns null when phase is non-numeric (Tier-A style)", () => {
  const args = {
    plan: "024",
    phase: "A",
    task: "T-024-A-1",
    prNumber: 30,
    squashSha: "deadbee",
    mergedAt: "2026-05-05",
  };
  assert.equal(buildProposedManifestEntry({ args, diffTouchedFiles: ["a.rs"] }), null);
});

test("buildProposedManifestEntry: happy path returns shaped entry with empty audit fields", () => {
  const args = {
    plan: "024",
    phase: "1",
    task: "T-024-1-1",
    prNumber: 30,
    squashSha: "deadbee",
    mergedAt: "2026-05-05",
  };
  const entry = buildProposedManifestEntry({
    args,
    diffTouchedFiles: ["packages/runtime-daemon/src/foo.rs"],
  });
  assert.deepEqual(entry, {
    phase: 1,
    task: "T-024-1-1",
    pr: 30,
    sha: "deadbee",
    merged_at: "2026-05-05",
    files: ["packages/runtime-daemon/src/foo.rs"],
    verifies_invariant: [],
    spec_coverage: [],
  });
});

test("buildProposedManifestEntry: defaults files to [] when diffTouchedFiles is null", () => {
  const args = {
    plan: "024",
    phase: "1",
    task: "T-024-1-1",
    prNumber: 30,
    squashSha: "deadbee",
    mergedAt: "2026-05-05",
  };
  const entry = buildProposedManifestEntry({ args, diffTouchedFiles: null });
  assert.deepEqual(entry.files, []);
});

// ---------- extractProposedEntry ----------

test("extractProposedEntry: returns null for null/undefined manifest", () => {
  assert.equal(extractProposedEntry(null), null);
  assert.equal(extractProposedEntry(undefined), null);
});

test("extractProposedEntry: returns null when field is absent", () => {
  assert.equal(extractProposedEntry({ pr_number: 30 }), null);
});

test("extractProposedEntry: returns null when script emitted null (graceful degradation)", () => {
  assert.equal(extractProposedEntry({ proposed_manifest_entry: null }), null);
});

test("extractProposedEntry: returns the entry as-is when present", () => {
  const entry = {
    phase: 1,
    task: "T-024-1-1",
    pr: 30,
    sha: "deadbee",
    merged_at: "2026-05-05",
    files: ["a.rs"],
    verifies_invariant: [],
    spec_coverage: [],
  };
  assert.deepEqual(extractProposedEntry({ proposed_manifest_entry: entry }), entry);
});

// ---------- enrichEntryWithDag ----------

const PROPOSED = {
  phase: 5,
  task: "T5.1",
  pr: 30,
  sha: "7e4ae47",
  merged_at: "2026-05-05",
  files: ["packages/client-sdk/src/sessionClient.ts"],
  verifies_invariant: [],
  spec_coverage: [],
};

test("enrichEntryWithDag: merges DAG verifies_invariant + spec_coverage into proposed entry", () => {
  const dagTask = { verifies_invariant: ["I-001-1"], spec_coverage: ["Spec-001 row 4"] };
  const out = enrichEntryWithDag(PROPOSED, dagTask);
  assert.deepEqual(out.verifies_invariant, ["I-001-1"]);
  assert.deepEqual(out.spec_coverage, ["Spec-001 row 4"]);
  // Other fields preserved.
  assert.equal(out.phase, 5);
  assert.equal(out.pr, 30);
});

test("enrichEntryWithDag: notesOverride is attached when provided", () => {
  const out = enrichEntryWithDag(
    PROPOSED,
    { verifies_invariant: [], spec_coverage: [] },
    "Lane A only.",
  );
  assert.equal(out.notes, "Lane A only.");
});

test("enrichEntryWithDag: notes omitted when notesOverride is undefined or empty", () => {
  const a = enrichEntryWithDag(PROPOSED, { verifies_invariant: [], spec_coverage: [] });
  const b = enrichEntryWithDag(PROPOSED, { verifies_invariant: [], spec_coverage: [] }, "");
  assert.ok(!("notes" in a));
  assert.ok(!("notes" in b));
});

test("enrichEntryWithDag: throws when proposedEntry is null", () => {
  assert.throws(
    () => enrichEntryWithDag(null, { verifies_invariant: [], spec_coverage: [] }),
    /script ran without --squash-sha\/--merged-at/,
  );
});

test("enrichEntryWithDag: throws when dagTask is missing", () => {
  assert.throws(() => enrichEntryWithDag(PROPOSED, null), /dagTask is required/);
});

test("enrichEntryWithDag: defaults audit arrays to [] when DAG fields are not arrays", () => {
  const out = enrichEntryWithDag(PROPOSED, { verifies_invariant: undefined, spec_coverage: null });
  assert.deepEqual(out.verifies_invariant, []);
  assert.deepEqual(out.spec_coverage, []);
});

// ---------- buildFinalManifestEntry ----------

test("buildFinalManifestEntry: end-to-end read + extract + enrich", () => {
  const tmp = mkdtempSync(join(tmpdir(), "build-final-"));
  try {
    const manifestPath = join(tmp, "housekeeper-manifest-PR30.json");
    writeFileSync(manifestPath, JSON.stringify({ proposed_manifest_entry: PROPOSED }, null, 2));
    const out = buildFinalManifestEntry({
      housekeeperManifestPath: manifestPath,
      dagTask: { verifies_invariant: ["I-001-1"], spec_coverage: ["Spec-001 row 4"] },
      notesOverride: "Lane A only.",
    });
    assert.deepEqual(out.verifies_invariant, ["I-001-1"]);
    assert.deepEqual(out.spec_coverage, ["Spec-001 row 4"]);
    assert.equal(out.notes, "Lane A only.");
    assert.equal(out.pr, 30);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildFinalManifestEntry: returns null when script emitted no proposed entry", () => {
  const tmp = mkdtempSync(join(tmpdir(), "build-final-"));
  try {
    const manifestPath = join(tmp, "housekeeper-manifest-PR30.json");
    writeFileSync(manifestPath, JSON.stringify({ proposed_manifest_entry: null }, null, 2));
    const out = buildFinalManifestEntry({
      housekeeperManifestPath: manifestPath,
      dagTask: { verifies_invariant: [], spec_coverage: [] },
    });
    assert.equal(out, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildFinalManifestEntry: throws when manifest path does not exist", () => {
  assert.throws(
    () =>
      buildFinalManifestEntry({
        housekeeperManifestPath: "/no/such/path/manifest.json",
        dagTask: { verifies_invariant: [], spec_coverage: [] },
      }),
    /manifest not found/,
  );
});
