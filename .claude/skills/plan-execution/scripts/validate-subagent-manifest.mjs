#!/usr/bin/env node
// validate-subagent-manifest.mjs — orchestrator wrapper for `validateManifestSubagentStage`.
// Authoritative validator contract: ../lib/housekeeper-orchestrator-helpers.mjs § validateManifestSubagentStage.
//
// Usage (Phase E step 5, after housekeeper subagent dispatch returns):
//
//   node --experimental-strip-types \
//     .claude/skills/plan-execution/scripts/validate-subagent-manifest.mjs \
//     .agents/tmp/housekeeper-manifest-PR<N>.json \
//     [--stage1 .agents/tmp/housekeeper-stage1-PR<N>.json]
//
// Exit codes:
//   0  — manifest valid (subagent contract satisfied)
//   1  — narration_mode_detected; orchestrator should route to SKILL.md Phase E
//        § Subagent narration auto-deviation fallback (do NOT re-dispatch — the
//        same prompt reproduces the failure)
//   2  — other validation gaps; orchestrator should round-trip the subagent
//        with the gap list
//   3  — invocation error (missing/unreadable manifest, malformed JSON)
//
// Stdout shape (single JSON object on a single line for the orchestrator's
// programmatic consumption — keep it cut-paste-into-jq friendly):
//
//   { valid: bool, narration_detected: bool, gaps: string[] }
//
// Stderr is reserved for diagnostics + the human-readable gap list. The
// orchestrator can `cat the JSON | jq ...` from stdout while a tail of the
// stderr is surfaced to the user when an exit-2 round-trip is required.

import { readFileSync, existsSync } from "node:fs";
import process from "node:process";

import { validateManifestSubagentStage } from "../lib/housekeeper-orchestrator-helpers.mjs";

const REPO_ROOT = process.cwd();

// Use `process.exitCode = main()` rather than `process.exit(N)`. The script
// writes its machine-readable JSON to stdout before terminating; when stdout
// is a pipe (e.g., `... | jq`, CI log collectors), stdout writes are async
// and `process.exit()` does not wait for them to drain — Node can terminate
// mid-write, truncating the JSON payload and breaking orchestrator parsing
// even when validation succeeded. Setting `exitCode` and letting the event
// loop drain naturally avoids the race. (Codex PR #53 R3 P1.)
function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stderr.write(
      "Usage: validate-subagent-manifest.mjs <manifest-path> [--stage1 <stage1-snapshot-path>]\n",
    );
    return 3;
  }

  const manifestPath = args[0];
  let stage1Path = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--stage1") {
      // Trailing `--stage1` with no path argument (or empty string) is a
      // malformed invocation: silently ignoring it would route the orchestrator
      // through the stage-1-absent fallback (validator uses subagent-emitted
      // `manifest._script_stage` as the baseline), changing exit-code semantics
      // from 3 (invocation error) to 1/2 (narration / round-trip). Fail fast.
      const next = args[i + 1];
      if (next == null || next === "") {
        process.stderr.write("error: --stage1 requires a non-empty path argument\n");
        return 3;
      }
      stage1Path = next;
      i++;
    }
  }

  if (!existsSync(manifestPath)) {
    process.stderr.write(`error: manifest not found at ${manifestPath}\n`);
    return 3;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    process.stderr.write(`error: manifest at ${manifestPath} is not valid JSON: ${e.message}\n`);
    return 3;
  }

  // Stage-1 snapshot plumbing — when the orchestrator wrote a sidecar
  // `housekeeper-stage1-PR<N>.json` capturing the script-stage manifest BEFORE
  // subagent dispatch (Phase E step 3), pass it here so the validator's
  // preservation checks (#7/#9/#10/#11) compare against the untamperable
  // baseline. When omitted, the validator falls back to `manifest._script_stage`
  // (subagent-controlled — surfaces a baseline-trust gap that routes through
  // exit 2 / round-trip, so explicit plumbing is functionally required).
  let stage1 = null;
  if (stage1Path) {
    if (!existsSync(stage1Path)) {
      process.stderr.write(`error: stage-1 snapshot not found at ${stage1Path}\n`);
      return 3;
    }
    try {
      stage1 = JSON.parse(readFileSync(stage1Path, "utf8"));
    } catch (e) {
      process.stderr.write(
        `error: stage-1 snapshot at ${stage1Path} is not valid JSON: ${e.message}\n`,
      );
      return 3;
    }
  }

  const result = validateManifestSubagentStage({
    manifest,
    repoRoot: REPO_ROOT,
    scriptAffectedFiles: stage1?.affected_files ?? null,
    scriptSchemaViolations: stage1?.schema_violations ?? null,
    scriptVerificationFailures: stage1?.verification_failures ?? null,
    scriptSemanticWorkPending: stage1?.semantic_work_pending ?? null,
  });

  const gaps = result.valid ? [] : result.gaps;
  const narrationDetected = gaps.some((g) => g.startsWith("narration_mode_detected"));

  // Single-line JSON for the orchestrator's programmatic path. Pretty-printed
  // gap list goes to stderr below so a human reading the output can scan it.
  process.stdout.write(
    JSON.stringify({ valid: result.valid, narration_detected: narrationDetected, gaps }) + "\n",
  );

  if (!result.valid) {
    process.stderr.write(`\n${gaps.length} gap(s):\n`);
    gaps.forEach((g, i) => process.stderr.write(`  ${i + 1}. ${g}\n`));
  }

  // Exit-code routing — narration_mode_detected wins exit 1 only when every
  // gap is "definitional" for narration (i.e., directly downstream of the
  // subagent doing nothing). The narration scenario inherently produces three
  // gap classes:
  //   - check #1: `result` non-canonical
  //   - check #2: per-item semantic_work_pending unaddressed (one per item)
  //   - check #13: narration_mode_detected itself
  // Any OTHER gap (baseline-trust #12, preservation #7/#9/#10/#11, halt-state
  // #8, schema-surfacing #5, placeholder leak, on-disk affected_files
  // failures, etc.) signals state the auto-deviation fallback cannot trust —
  // applying edits from `_script_stage` then would compound the bug. Mixed
  // cases must round-trip / halt through exit 2. (Codex PR #53 R4 P1.)
  const DEFINITIONAL_NARRATION_GAP_PATTERNS = [
    /^narration_mode_detected/,
    /^`result` is /,
    / listed in semantic_work_pending but absent from semantic_edits and concerns /,
  ];
  const allGapsAreDefinitional = gaps.every((g) =>
    DEFINITIONAL_NARRATION_GAP_PATTERNS.some((p) => p.test(g)),
  );
  if (narrationDetected && allGapsAreDefinitional) return 1;
  if (!result.valid) return 2;
  return 0;
}

process.exitCode = main();
