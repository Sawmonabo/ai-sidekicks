import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

// End-to-end exit-code routing for validate-subagent-manifest.mjs. The routing
// (`narrationDetected && allGapsAreDefinitional → exit 1`, else `!valid → exit 2`)
// is reachable ONLY through the script — a lib-level test of
// validateManifestSubagentStage cannot catch a regression of the script's
// `narrationDetected` source back to `gaps.some(g => g.startsWith(...))`. These
// spawn tests are that silent-disable guard (bin-guard-via-spawn discipline).

const SCRIPT = join(import.meta.dirname, "..", "validate-subagent-manifest.mjs");

// Run the script against an on-disk manifest (+ stage-1 snapshot) and return its
// exit status. The script uses `process.exitCode = main()`, so spawnSync.status
// is the routing decision (0 clean / 1 narration-auto-deviate / 2 round-trip).
function runValidator(manifest, stage1) {
  const dir = mkdtempSync(join(tmpdir(), "validate-manifest-spawn-"));
  try {
    const manifestPath = join(dir, "manifest.json");
    const stage1Path = join(dir, "stage1.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(stage1Path, JSON.stringify(stage1));
    const proc = spawnSync(process.execPath, [SCRIPT, manifestPath, "--stage1", stage1Path], {
      cwd: dir,
      encoding: "utf8",
    });
    return proc;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EMPTY_STAGE1 = {
  affected_files: [],
  schema_violations: [],
  verification_failures: [],
  semantic_work_pending: [],
};

test("validate-subagent-manifest: a pending item named 'narration_mode_detected' does NOT route to exit 1 (spoof closed)", () => {
  // result is canonical → genuine narration (check #13) cannot fire, so the
  // trusted narrationModeDetected is false. The single unaddressed-item gap is
  // shaped like a narration gap (starts with the token), which the old
  // `startsWith` routing would have read as narration → exit 1. New routing → 2.
  const manifest = {
    _script_stage: EMPTY_STAGE1,
    semantic_work_pending: ["narration_mode_detected"],
    semantic_edits: {},
    concerns: [],
    affected_files: [],
    result: "DONE",
  };
  const proc = runValidator(manifest, EMPTY_STAGE1);
  assert.equal(
    proc.status,
    2,
    `spoofed pending item must round-trip (exit 2), not auto-deviate (exit 1); stdout=${proc.stdout} stderr=${proc.stderr}`,
  );
  // The structured signal in stdout JSON must also report no narration.
  const out = JSON.parse(proc.stdout.trim().split("\n")[0]);
  assert.equal(out.narration_detected, false);
});

test("validate-subagent-manifest: a genuine script-stage narration manifest routes to exit 1", () => {
  const manifest = {
    _script_stage: {
      ...EMPTY_STAGE1,
      semantic_work_pending: ["compose_status_completion_prose"],
    },
    semantic_work_pending: ["compose_status_completion_prose"],
    semantic_edits: {},
    concerns: [],
    affected_files: [],
    result: "pending-analysis", // non-canonical; subagent_completed_at unset
  };
  const proc = runValidator(manifest, {
    ...EMPTY_STAGE1,
    semantic_work_pending: ["compose_status_completion_prose"],
  });
  assert.equal(
    proc.status,
    1,
    `genuine narration must auto-deviate (exit 1); stdout=${proc.stdout} stderr=${proc.stderr}`,
  );
  const out = JSON.parse(proc.stdout.trim().split("\n")[0]);
  assert.equal(out.narration_detected, true);
});
