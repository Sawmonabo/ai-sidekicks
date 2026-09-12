// Unit tests for the post-merge housekeeper script.
//
// Run: node --test .claude/skills/plan-execution/scripts/__tests__/post-merge-housekeeper.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  ParseArgsError,
  buildProposedManifestEntry,
  emitManifest,
  parseArgs,
  readTouchedFilesFromPath,
  runHousekeeper,
} from "../post-merge-housekeeper.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- parseArgs ----------

test("parseArgs validates --plan shape (NNN or NNN-partial)", () => {
  assert.equal(parseArgs(["30", "--plan", "024"]).plan, "024");
  assert.equal(parseArgs(["30", "--plan", "023-partial"]).plan, "023-partial");
  assert.throws(() => parseArgs(["30", "--plan", "abc"]), /--plan/);
});

test("parseArgs validates --phase shape (digit or [A-Z])", () => {
  assert.equal(parseArgs(["30", "--plan", "024", "--phase", "1"]).phase, "1");
  assert.equal(parseArgs(["30", "--plan", "024", "--phase", "B"]).phase, "B");
  assert.throws(() => parseArgs(["30", "--plan", "024", "--phase", "ab"]), /--phase/);
});

test("parseArgs validates --task shape (three forms: T<N>, T-NNN-N-N, tier-K)", () => {
  assert.equal(parseArgs(["30", "--plan", "001", "--task", "T5.1"]).task, "T5.1");
  assert.equal(parseArgs(["30", "--plan", "001", "--task", "T5"]).task, "T5");
  assert.equal(parseArgs(["30", "--plan", "024", "--task", "T-024-2-1"]).task, "T-024-2-1");
  assert.equal(parseArgs(["30", "--task", "tier-3"]).task, "tier-3");
  assert.throws(() => parseArgs(["30", "--plan", "024", "--task", "5.1"]), /--task/);
  assert.throws(() => parseArgs(["30", "--task", "tier-3-9"]), /--task/);
});

test("parseArgs validates --squash-sha and --merged-at shapes", () => {
  const args = parseArgs(["30", "--squash-sha", "abc1234", "--merged-at", "2026-05-09"]);
  assert.equal(args.squashSha, "abc1234");
  assert.equal(args.mergedAt, "2026-05-09");
  assert.throws(() => parseArgs(["30", "--squash-sha", "zzz"]), /--squash-sha/);
  assert.throws(() => parseArgs(["30", "--merged-at", "09-05-2026"]), /--merged-at/);
});

test("parseArgs validates <PR#> is positive integer (positional)", () => {
  assert.throws(() => parseArgs([]), /missing positional/);
  assert.throws(() => parseArgs(["abc", "--plan", "024"]), /<PR#>/);
});

test("parseArgs rejects <PR#> = 0 / 00 / leading-zero (avoids `PR #0` audit-trail corruption)", () => {
  assert.throws(() => parseArgs(["0", "--plan", "024"]), /<PR#>/);
  assert.throws(() => parseArgs(["00", "--plan", "024"]), /<PR#>/);
  assert.throws(() => parseArgs(["01", "--plan", "024"]), /<PR#>/);
});

test("parseArgs rejects unknown flags (defense against orchestrator drift)", () => {
  assert.throws(() => parseArgs(["30", "--bogus"]), /unknown flag.*--bogus/);
});

test("parseArgs: shape-validation violations carry exit code >= 6", () => {
  let err;
  try {
    parseArgs(["30", "--plan", "abc"]);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ParseArgsError, "expected ParseArgsError");
  assert.ok(typeof err.exitCode === "number", "ParseArgsError must carry exitCode");
  assert.ok(err.exitCode >= 6, `expected exitCode >= 6, got ${err.exitCode}`);

  err = undefined;
  try {
    parseArgs([]);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ParseArgsError);
  assert.ok(err.exitCode >= 6);
});

test("parseArgs accepts --touched-files-path with arbitrary string value", () => {
  const args = parseArgs([
    "32",
    "--plan",
    "001",
    "--phase",
    "1",
    "--touched-files-path",
    "/tmp/touched.txt",
  ]);
  assert.equal(args.touchedFilesPath, "/tmp/touched.txt");
});

test("parseArgs leaves touchedFilesPath null when flag is omitted (entrypoint enforces)", () => {
  const args = parseArgs(["32", "--plan", "001", "--phase", "1"]);
  assert.equal(args.touchedFilesPath, null);
});

// ---------- buildProposedManifestEntry ----------

const FULL_ARGS = {
  prNumber: 48,
  plan: "029",
  phase: "2",
  task: "T-029-2-1",
  squashSha: "abc1234",
  mergedAt: "2026-05-09",
};

test("buildProposedManifestEntry populates the script-knowable fields", () => {
  const entry = buildProposedManifestEntry({
    args: FULL_ARGS,
    diffTouchedFiles: ["packages/runtime-daemon/src/index.ts"],
  });
  assert.deepEqual(entry, {
    phase: 2,
    task: "T-029-2-1",
    pr: 48,
    sha: "abc1234",
    merged_at: "2026-05-09",
    files: ["packages/runtime-daemon/src/index.ts"],
    verifies_invariant: [],
    spec_coverage: [],
  });
});

test("buildProposedManifestEntry returns null when merge metadata or identity is missing", () => {
  for (const missing of ["squashSha", "mergedAt", "plan", "phase", "task"]) {
    const args = { ...FULL_ARGS, [missing]: null };
    assert.equal(
      buildProposedManifestEntry({ args, diffTouchedFiles: [] }),
      null,
      `expected null when ${missing} is absent`,
    );
  }
});

test("buildProposedManifestEntry returns null for a letter phase (not expressible as an int)", () => {
  const args = { ...FULL_ARGS, phase: "B" };
  assert.equal(buildProposedManifestEntry({ args, diffTouchedFiles: [] }), null);
});

// ---------- emitManifest ----------

test("emitManifest writes generated_at as the first key when provided", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "manifest-genat-"));
  try {
    const result = emitManifest({
      repoRoot: tmpRepo,
      prNumber: 42,
      generatedAt: "2026-05-03T00:00:00Z",
      scriptExitCode: 0,
    });
    const written = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    assert.equal(written.generated_at, "2026-05-03T00:00:00Z");
    // Ordering matters for readability — assert generated_at is first.
    assert.equal(Object.keys(written)[0], "generated_at");
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// ---------- readTouchedFilesFromPath ----------
//
// The orchestrator computes the PR-wide diff (BEFORE squash-merge) and passes
// its file-list path via `--touched-files-path`; the script never shells out to
// git.

test("readTouchedFilesFromPath reads newline-delimited paths from file", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "tfp-read-"));
  try {
    const touchedFilesPath = join(tmpRepo, "touched.txt");
    writeFileSync(touchedFilesPath, "alpha.md\nbeta.ts\n");
    assert.deepEqual(readTouchedFilesFromPath(touchedFilesPath).sort(), ["alpha.md", "beta.ts"]);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("readTouchedFilesFromPath returns [] for empty file (no diff)", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "tfp-empty-"));
  try {
    const touchedFilesPath = join(tmpRepo, "touched.txt");
    writeFileSync(touchedFilesPath, "");
    assert.deepEqual(readTouchedFilesFromPath(touchedFilesPath), []);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// ---------- runHousekeeper ----------

test("runHousekeeper threads diffTouchedFiles into proposed_manifest_entry.files", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "rh-tf-"));
  try {
    const touched = ["docs/plans/029-orphan-pr-fixture.md", "packages/contracts/src/index.ts"];
    const result = runHousekeeper({
      args: FULL_ARGS,
      repoRoot: tmpRepo,
      today: "2026-05-03",
      diffTouchedFiles: touched,
    });
    assert.equal(result.exitCode, 0);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    assert.equal(manifest.generated_at, "2026-05-03T00:00:00Z");
    assert.equal(manifest.pr_number, 48);
    assert.equal(manifest.plan, "029");
    assert.equal(manifest.phase, "2");
    assert.equal(manifest.task_id, "T-029-2-1");
    assert.equal(manifest.script_exit_code, 0);
    assert.deepEqual(manifest.proposed_manifest_entry.files, touched);
    assert.equal(manifest.proposed_manifest_entry.sha, "abc1234");
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// The script's only writable surface is its own manifest under `.agents/tmp/`.
// The plan file is the orchestrator's to edit, so this pins the boundary rather
// than the absence of any one function.
test("runHousekeeper writes nothing under docs/plans/", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "plan-tree-untouched-"));
  try {
    const planDir = join(tmpRepo, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    const planPath = join(planDir, "029-orphan-pr-fixture.md");
    writeFileSync(planPath, "# Plan-029\n\n## Progress Log\n\n### Shipment Manifest\n");
    const planBytesBefore = readFileSync(planPath);
    const result = runHousekeeper({ args: FULL_ARGS, repoRoot: tmpRepo, today: "2026-05-03" });
    // Guard the guard: an early bail would leave the plan untouched for the
    // wrong reason and make the assertion below vacuous.
    assert.equal(result.exitCode, 0, "expected the run to complete");
    assert.deepEqual(
      readFileSync(planPath),
      planBytesBefore,
      "the housekeeper script must never write under docs/plans/",
    );
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// ---------- CLI entrypoint ----------

test("CLI entrypoint exits 6 with ParseArgsError when --touched-files-path is missing", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "cli-tfp-required-"));
  try {
    const scriptPath = join(HERE, "..", "post-merge-housekeeper.mjs");
    const result = spawnSync(
      process.execPath,
      [scriptPath, "32", "--plan", "001", "--phase", "1"],
      { cwd: tmpRepo, encoding: "utf8" },
    );
    assert.equal(
      result.status,
      6,
      `expected exit 6, got ${result.status}\nstderr: ${result.stderr}`,
    );
    assert.match(result.stderr, /--touched-files-path is required/);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("CLI entrypoint reads --touched-files-path and records it on the proposed entry", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "cli-tfp-read-"));
  try {
    const touchedFilesPath = join(tmpRepo, "touched.txt");
    writeFileSync(touchedFilesPath, "docs/plans/099-stub.md\npackages/contracts/src/index.ts\n");
    const scriptPath = join(HERE, "..", "post-merge-housekeeper.mjs");
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "99",
        "--plan",
        "099",
        "--phase",
        "1",
        "--task",
        "T1.1",
        "--squash-sha",
        "deadbee",
        "--merged-at",
        "2026-05-09",
        "--touched-files-path",
        touchedFilesPath,
      ],
      { cwd: tmpRepo, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
    const manifestPath = join(tmpRepo, ".agents", "tmp", "housekeeper-manifest-PR99.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(manifest.proposed_manifest_entry.files, [
      "docs/plans/099-stub.md",
      "packages/contracts/src/index.ts",
    ]);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});
