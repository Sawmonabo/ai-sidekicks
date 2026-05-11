import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  buildHousekeeperPrompt,
  validateManifestSubagentStage,
  detectAffectedFilesSprawl,
  decideHousekeeperRouting,
  assertRepoRelative,
  extractProposedEntry,
  enrichEntryWithDag,
  buildFinalManifestEntry,
} from "../../lib/housekeeper-orchestrator-helpers.mjs";
import { emitManifest, buildProposedManifestEntry } from "../post-merge-housekeeper.mjs";

// Production-path simulation: in Phase E the orchestrator reads the script-stage
// manifest in SKILL.md step 3 BEFORE subagent dispatch, stores the four snapshot
// fields in its conversation memory, and plumbs them forward as `scriptXXX`
// params on the subsequent `validateManifestSubagentStage` call. That stored
// stage-1 snapshot is the untamperable baseline (the dispatched subagent runs
// in a separated context and cannot rewrite what the orchestrator already saw).
// Honest test fixtures simulate the production path by spreading the helper so
// `manifest._script_stage` (which in honest cases mirrors what the orchestrator
// would have stored) becomes the four `scriptXXX` params:
//
//     validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) })
//
// Tampering / forgot-to-plumb tests intentionally OMIT this spread so the
// validator's snapshot-fallback path runs and the baseline-trust gap fires.
const stageOneFromManifest = (manifest) => ({
  scriptAffectedFiles: manifest._script_stage?.affected_files,
  scriptSchemaViolations: manifest._script_stage?.schema_violations,
  scriptVerificationFailures: manifest._script_stage?.verification_failures,
  scriptSemanticWorkPending: manifest._script_stage?.semantic_work_pending,
});

test("buildHousekeeperPrompt: includes manifest path + exit code", () => {
  const prompt = buildHousekeeperPrompt({
    manifestPath: "/tmp/m.json",
    scriptExitCode: 0,
    prNumber: 30,
  });
  assert.match(prompt, /\/tmp\/m\.json/);
  assert.match(prompt, /exit code: 0/);
  assert.match(prompt, /PR #30/);
});

test("buildHousekeeperPrompt: AUTO-CREATE mode wording for exit 0 + auto_create.reserved_ns_nn populated", () => {
  const manifest = { auto_create: { reserved_ns_nn: 24 } };
  const prompt = buildHousekeeperPrompt({
    manifestPath: "...",
    scriptExitCode: 0,
    prNumber: 30,
    manifest,
  });
  assert.match(prompt, /AUTO-CREATE/);
  assert.match(prompt, /NS-24/);
});

test("buildHousekeeperPrompt: schema-violation mode wording for exit 5", () => {
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    schema_violations: [
      { kind: "PRs_block_malformed", field: "PRs:", detail: "missing annotation" },
    ],
  };
  const prompt = buildHousekeeperPrompt({
    manifestPath: "...",
    scriptExitCode: 5,
    prNumber: 30,
    manifest,
  });
  assert.match(prompt, /schema_violations/);
  assert.match(prompt, /RESULT: BLOCKED/);
});

test("validateManifestSubagentStage: entry guard surfaces structured gap (no TypeError) when manifest is null", () => {
  // A malformed subagent output (JSON literal `null`) would otherwise crash
  // on the first `manifest.X` dereference before gap collection runs. The
  // validator MUST surface this as a structured gap and short-circuit so
  // Phase E's contract-violation recovery path stays intact.
  const result = validateManifestSubagentStage({ manifest: null });
  assert.equal(result.valid, false);
  assert.equal(result.gaps.length, 1);
  assert.match(result.gaps[0], /manifest is not a JSON object \(got null\)/);
  assert.match(result.gaps[0], /subagent contract requires emitting a manifest object/);
});

test("validateManifestSubagentStage: entry guard surfaces structured gap when manifest is undefined", () => {
  const result = validateManifestSubagentStage({ manifest: undefined });
  assert.equal(result.valid, false);
  assert.equal(result.gaps.length, 1);
  assert.match(result.gaps[0], /manifest is not a JSON object \(got undefined\)/);
});

test("validateManifestSubagentStage: entry guard surfaces structured gap when manifest is a non-object scalar", () => {
  const numberResult = validateManifestSubagentStage({ manifest: 42 });
  assert.equal(numberResult.valid, false);
  assert.match(numberResult.gaps[0], /manifest is not a JSON object \(got number\)/);
  const stringResult = validateManifestSubagentStage({ manifest: "oops" });
  assert.equal(stringResult.valid, false);
  assert.match(stringResult.gaps[0], /manifest is not a JSON object \(got string\)/);
});

test("validateManifestSubagentStage: entry guard surfaces structured gap when manifest is an array root", () => {
  // JSON arrays at the root (e.g. subagent emits `[]` instead of `{}`) are
  // technically `typeof === "object"` in JS — must catch via Array.isArray.
  const result = validateManifestSubagentStage({ manifest: [] });
  assert.equal(result.valid, false);
  assert.equal(result.gaps.length, 1);
  assert.match(result.gaps[0], /manifest is not a JSON object \(got array\)/);
});

test("validateManifestSubagentStage: pass when every pending item has semantic_edits or concerns entry", () => {
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: ["compose_status_completion_prose", "ready_set_re_derivation"],
    semantic_edits: { compose_status_completion_prose: "...", ready_set_re_derivation: "..." },
    concerns: [],
    affected_files: ["docs/architecture/cross-plan-dependencies.md"],
    result: "DONE",
  };
  assert.deepEqual(validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) }), {
    valid: true,
  });
});

test("validateManifestSubagentStage: fail when pending item is unaddressed", () => {
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: ["compose_status_completion_prose", "ready_set_re_derivation"],
    semantic_edits: { compose_status_completion_prose: "..." },
    concerns: [],
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.equal(result.gaps.length, 1);
  assert.match(result.gaps[0], /^ready_set_re_derivation listed in semantic_work_pending/);
  // Gap message now hints at the contract requirement (addressing: <item-key>) — Codex P1 fix on PR #33.
  assert.match(result.gaps[0], /addressing: "ready_set_re_derivation"/);
});

test("validateManifestSubagentStage: fails when affected_files entry is missing from disk", () => {
  // Codex P1 (PR #33 R6 / Finding 10): the placeholder-scan loop's `if (existsSync(full))`
  // gate had no else-branch, so a subagent run that DELETED a declared affected_files entry
  // (e.g. accidentally `rm`-ing docs/architecture/cross-plan-dependencies.md) silently passed
  // validation — the loop just moved on. The contract clause "affected_files ⊇ files actually
  // edited" implies those files exist post-edit; deletion is destructive out-of-scope behavior
  // and MUST surface as a gap rather than slipping through. Negative case (file present, no
  // placeholder) is covered by the existing happy-path test at line 54 — manifest declares
  // docs/architecture/cross-plan-dependencies.md against the real cwd, file exists, no gap.
  const tmpRepo = mkdtempSync(join(tmpdir(), "validate-missing-"));
  try {
    // Intentionally do NOT mkdirSync/writeFileSync — the file is absent on disk.
    const manifest = {
      _script_stage: {
        affected_files: [],
        schema_violations: [],
        verification_failures: [],
        semantic_work_pending: [],
      },
      semantic_work_pending: [],
      semantic_edits: {},
      concerns: [],
      affected_files: ["docs/architecture/cross-plan-dependencies.md"],
      result: "DONE",
    };
    const result = validateManifestSubagentStage({
      manifest,
      repoRoot: tmpRepo,
      ...stageOneFromManifest(manifest),
    });
    assert.equal(result.valid, false);
    assert.equal(result.gaps.length, 1);
    assert.match(
      result.gaps[0],
      /^docs\/architecture\/cross-plan-dependencies\.md declared in affected_files but missing from disk/,
    );
    assert.match(result.gaps[0], /destructive out-of-scope behavior/);
    assert.match(result.gaps[0], /deletion is not permitted/);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("validateManifestSubagentStage: fails with gap (not crash) when affected_files entry is a directory", () => {
  // The placeholder-scan loop calls readFileSync unconditionally after the
  // existsSync gate, so a subagent that declared a directory path in
  // affected_files (or readFileSync hit any I/O error) would crash the
  // orchestrator with EISDIR / ENOENT instead of routing through the
  // validator's gap collection. The contract requires affected_files entries
  // to be regular files (the script edits line-level content); a directory is
  // a contract violation that MUST surface as a gap so Phase E can re-dispatch
  // — not an unhandled exception that halts orchestration.
  const tmpRepo = mkdtempSync(join(tmpdir(), "validate-nonfile-"));
  try {
    // Create a DIRECTORY at the path the manifest will declare as a file.
    mkdirSync(join(tmpRepo, "docs/architecture/cross-plan-dependencies.md"), {
      recursive: true,
    });
    const manifest = {
      _script_stage: {
        affected_files: [],
        schema_violations: [],
        verification_failures: [],
        semantic_work_pending: [],
      },
      semantic_work_pending: [],
      semantic_edits: {},
      concerns: [],
      affected_files: ["docs/architecture/cross-plan-dependencies.md"],
      result: "DONE",
    };
    // The bug surface: prior code threw EISDIR here. The fix routes to gaps.push.
    const result = validateManifestSubagentStage({
      manifest,
      repoRoot: tmpRepo,
      ...stageOneFromManifest(manifest),
    });
    assert.equal(result.valid, false);
    assert.equal(result.gaps.length, 1);
    assert.match(
      result.gaps[0],
      /^docs\/architecture\/cross-plan-dependencies\.md declared in affected_files but is not a regular file/,
    );
    assert.match(result.gaps[0], /subagent contract requires regular files for line-level edits/);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("validateManifestSubagentStage: fail when <TODO subagent prose> placeholder still present in any affected file", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "validate-todo-"));
  try {
    mkdirSync(join(tmpRepo, "docs/architecture"), { recursive: true });
    writeFileSync(
      join(tmpRepo, "docs/architecture/cross-plan-dependencies.md"),
      "### NS-01: foo\n- Status: `completed` (resolved 2026-05-03 via PR #30 — <TODO subagent prose>)\n",
    );
    const manifest = {
      _script_stage: {
        affected_files: [],
        schema_violations: [],
        verification_failures: [],
        semantic_work_pending: [],
      },
      semantic_work_pending: [],
      semantic_edits: {},
      concerns: [],
      affected_files: ["docs/architecture/cross-plan-dependencies.md"],
      result: "DONE",
    };
    const result = validateManifestSubagentStage({
      manifest,
      repoRoot: tmpRepo,
      ...stageOneFromManifest(manifest),
    });
    assert.equal(result.valid, false);
    assert.match(result.gaps[0], /<TODO subagent prose>/);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("validateManifestSubagentStage: fail when <TODO subagent prose> placeholder appears in semantic_edits values (P2 fix)", () => {
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: ["compose_status_completion_prose"],
    semantic_edits: {
      compose_status_completion_prose: "(resolved 2026-05-03 via PR #30 — <TODO subagent prose>)",
    },
    concerns: [],
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some(
      (g) =>
        g.includes("<TODO subagent prose>") &&
        g.includes("semantic_edits.compose_status_completion_prose"),
    ),
    `expected gap to mention semantic_edits.compose_status_completion_prose carries the placeholder; got: ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: scans nested semantic_edits values (e.g. arrays of prose strings)", () => {
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: ["line_cite_sweep"],
    semantic_edits: {
      line_cite_sweep: [
        "Updated cite at line 42",
        "Updated cite at line 57 — <TODO subagent prose>",
      ],
    },
    concerns: [],
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some((g) => g.includes("semantic_edits.line_cite_sweep")),
    `expected gap to mention semantic_edits.line_cite_sweep; got: ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: schema_violations require per-entry concerns match (1 generic concern cannot satisfy N violations)", () => {
  // Codex P1 regression (PR #33): the prior `.some(c => c.kind === "schema_violation")`
  // predicate ignored `sv` entirely, so a single generic concern absorbed every violation.
  // Two violations with distinct fields + only one matching concern MUST gap on the unmatched one.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    schema_violations: [
      { kind: "schema_violation", field: "status", ns_id: "NS-15" },
      { kind: "schema_violation", field: "type", ns_id: "NS-15" },
    ],
    concerns: [{ kind: "schema_violation", field: "status", ns_id: "NS-15", detail: "..." }],
    affected_files: [],
    result: "BLOCKED",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some((g) => g.includes("NS-15.type") && !g.includes("NS-15.status")),
    `expected exactly the 'type' violation to gap (status is matched); got: ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: schema_violations pass when each entry has a matching concerns entry by field+ns_id", () => {
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    schema_violations: [
      { kind: "schema_violation", field: "status", ns_id: "NS-15" },
      { kind: "schema_violation", field: "type", ns_id: "NS-15" },
    ],
    concerns: [
      { kind: "schema_violation", field: "status", ns_id: "NS-15", detail: "..." },
      { kind: "schema_violation", field: "type", ns_id: "NS-15", detail: "..." },
    ],
    affected_files: [],
    result: "BLOCKED",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, true);
});

test("validateManifestSubagentStage: schema_violations match by field alone when ns_id is absent (--candidate-ns shape)", () => {
  // Per script line 1394: --candidate-ns mode emits violations without ns_id.
  // Matching falls back to `field` alone in that case.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    schema_violations: [{ kind: "schema_violation", field: "summary" }],
    concerns: [{ kind: "schema_violation", field: "summary", detail: "..." }],
    affected_files: [],
    result: "BLOCKED",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, true);
});

test("validateManifestSubagentStage: distinct-kind violations require kind-discriminated concerns (Codex P2 fix on PR #33)", () => {
  // Codex P2 (PR #33 R3): when both sv and a generic concern lack `field`,
  // `c.field !== sv.field` was trivially false (undefined !== undefined),
  // letting one concern absorb every violation. Adding `kind` to the match
  // key prevents distinct-kind violations from sharing a concern.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    schema_violations: [
      { kind: "auto_create_title_seed_underivable" },
      { kind: "schema_violation", field: "summary" },
    ],
    // Only the schema_violation has a matching concern; the auto_create kind has none.
    concerns: [{ kind: "schema_violation", field: "summary", detail: "..." }],
    affected_files: [],
    result: "BLOCKED",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.equal(result.gaps.length, 1);
  assert.ok(
    result.gaps[0].includes("auto_create_title_seed_underivable"),
    `expected gap on auto_create_title_seed_underivable; got: ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: auto_create_title_seed_underivable singleton matches by kind alone (no field/ns_id)", () => {
  // Per script line 899: emits `[{ kind: "auto_create_title_seed_underivable" }]` with no
  // field/ns_id. The matching concern needs the same `kind`; field/ns_id are absent on both
  // sides and the matcher must treat that as a valid pairing (not a trivial-false gap).
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    schema_violations: [{ kind: "auto_create_title_seed_underivable" }],
    concerns: [{ kind: "auto_create_title_seed_underivable", detail: "..." }],
    affected_files: [],
    result: "BLOCKED",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, true);
});

test("validateManifestSubagentStage: fieldless-violation gap message uses (kind: ...) label and matchReqs", () => {
  // When sv lacks both ns_id and field, idLabel falls back to `(kind: <kind>)` so the
  // failure message remains identifiable instead of printing `undefined`.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    schema_violations: [{ kind: "auto_create_title_seed_underivable" }],
    concerns: [],
    affected_files: [],
    result: "BLOCKED",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.equal(result.gaps.length, 1);
  assert.match(result.gaps[0], /\(kind: auto_create_title_seed_underivable\)/);
  assert.match(result.gaps[0], /need entry with kind: "auto_create_title_seed_underivable"/);
  assert.doesNotMatch(result.gaps[0], /matching field|matching ns_id/);
});

test("validateManifestSubagentStage: BLOCKED result waives per-item pairing for semantic_work_pending (Codex P1 false-gap fix)", () => {
  // Codex P1 (PR #33 R2): when subagent halts at BLOCKED, it cannot complete every
  // semantic_work_pending item. The validator MUST skip the per-item check, otherwise
  // legitimate BLOCKED outcomes get round-tripped as false gaps (forcing wasted dispatches).
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [
      "compose_status_completion_prose",
      "ready_set_re_derivation",
      "line_cite_sweep",
    ],
    semantic_edits: {},
    concerns: [{ kind: "blocking_dependency", detail: "missing input X" }],
    affected_files: [],
    result: "BLOCKED",
  };
  assert.deepEqual(validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) }), {
    valid: true,
  });
});

test("validateManifestSubagentStage: NEEDS_CONTEXT result waives per-item pairing for semantic_work_pending", () => {
  // Same waiver as BLOCKED — subagent halted before completing semantic work.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: ["compose_status_completion_prose"],
    semantic_edits: {},
    concerns: [{ kind: "needs_input", detail: "ambiguous spec" }],
    affected_files: [],
    result: "NEEDS_CONTEXT",
  };
  assert.deepEqual(validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) }), {
    valid: true,
  });
});

test("validateManifestSubagentStage: DONE_WITH_CONCERNS still requires per-item pairing (waiver narrowly scoped to halt-states)", () => {
  // DONE_WITH_CONCERNS means the subagent completed its work (with caveats) — the
  // per-item check still applies. Only BLOCKED/NEEDS_CONTEXT (true halts) waive it.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: ["compose_status_completion_prose"],
    semantic_edits: {},
    concerns: [{ kind: "general_observation", detail: "unrelated note" }],
    affected_files: [],
    result: "DONE_WITH_CONCERNS",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.equal(result.gaps.length, 1);
  assert.match(result.gaps[0], /^compose_status_completion_prose listed in semantic_work_pending/);
});

test("validateManifestSubagentStage: per-item pairing matches by `addressing: <item-key>` exactly (concern.kind is irrelevant)", () => {
  // Per the canonical template (responsibility #5): concerns deferring a pending item set
  // `addressing: <exact-pending-item-key>`. The kind field is the subagent's choice;
  // only `addressing` is the validator's match key.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: ["set_quantifier_reverification", "line_cite_sweep"],
    semantic_edits: { line_cite_sweep: "..." },
    concerns: [{ kind: "deferred_for_followup", addressing: "set_quantifier_reverification" }],
    affected_files: [],
    result: "DONE_WITH_CONCERNS",
  };
  assert.deepEqual(validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) }), {
    valid: true,
  });
});

// ---------- Non-empty semantic_edits payload required ----------
// hasOwnProperty.call(...) only checks key presence, so a subagent could ship
// DONE / DONE_WITH_CONCERNS with `semantic_edits.compose_status_prose = undefined`
// (or null / "" / [] / {}) and the validator would accept zero payload. The contract
// (responsibility #5: "containing the composed output") requires an actual payload.
// These tests pin the value-must-be-meaningful rule and the differentiated gap message
// (key-present-but-empty distinguished from key-missing-entirely).

test("validateManifestSubagentStage: fails when semantic_edits[item] is undefined", () => {
  // The literal motivating shape from the finding: subagent assigned the key but never
  // composed a value (e.g. `semantic_edits.compose_status_completion_prose = undefined`).
  // hasOwnProperty would return true, masking the missing payload — gap MUST fire.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: ["compose_status_completion_prose"],
    semantic_edits: { compose_status_completion_prose: undefined },
    concerns: [],
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.equal(result.gaps.length, 1);
  assert.match(
    result.gaps[0],
    /^compose_status_completion_prose listed in semantic_work_pending: semantic_edits\["compose_status_completion_prose"\] exists but value is empty/,
  );
  assert.match(result.gaps[0], /canonical-template responsibility #5/);
});

test("validateManifestSubagentStage: fails when semantic_edits[item] is null", () => {
  // null is JSON's explicit empty value — equally invalid as undefined under the
  // contract (responsibility #5 requires composed output).
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: ["ready_set_re_derivation"],
    semantic_edits: { ready_set_re_derivation: null },
    concerns: [],
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.equal(result.gaps.length, 1);
  assert.match(
    result.gaps[0],
    /^ready_set_re_derivation listed in semantic_work_pending: semantic_edits\["ready_set_re_derivation"\] exists but value is empty/,
  );
});

test("validateManifestSubagentStage: fails when semantic_edits[item] is empty string", () => {
  // Empty / whitespace-only strings are not "composed output". isMeaningfulPayload
  // trims before checking length so "" and "   " both fail.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: ["line_cite_sweep"],
    semantic_edits: { line_cite_sweep: "" },
    concerns: [],
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.equal(result.gaps.length, 1);
  assert.match(
    result.gaps[0],
    /^line_cite_sweep listed in semantic_work_pending: semantic_edits\["line_cite_sweep"\] exists but value is empty/,
  );
});

test("validateManifestSubagentStage: fails when semantic_edits[item] is empty object", () => {
  // `{}` is the placeholder shape a careless subagent might emit when stubbing the slot.
  // Object.keys(value).length === 0 catches it before it slips through.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: ["set_quantifier_reverification"],
    semantic_edits: { set_quantifier_reverification: {} },
    concerns: [],
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.equal(result.gaps.length, 1);
  assert.match(
    result.gaps[0],
    /^set_quantifier_reverification listed in semantic_work_pending: semantic_edits\["set_quantifier_reverification"\] exists but value is empty/,
  );
});

test("validateManifestSubagentStage: passes when semantic_edits[item] is a non-empty object", () => {
  // Negative control — proves the new check accepts the canonical happy-path shape
  // (e.g. `mechanical_edits.status_flip.to_line` echoed back into semantic_edits as an
  // object with composed-prose fields). This pairs with the four failing-payload tests
  // above to lock the meaningful-payload boundary in both directions.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: ["compose_status_completion_prose"],
    semantic_edits: {
      compose_status_completion_prose: {
        to_line:
          "- Status: `completed` (resolved 2026-05-06 via PR #33 — housekeeper validator now requires non-empty semantic_edits payload)",
      },
    },
    concerns: [],
    affected_files: [],
    result: "DONE",
  };
  assert.deepEqual(validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) }), {
    valid: true,
  });
});

// ---------- Scalar payloads rejected as non-output-bearing ----------
// A permissive catch-all in `isMeaningfulPayload` returned `true` for any
// non-null scalar (booleans, numbers), so a subagent could satisfy
// `semantic_work_pending` with `false`/`0` and still pass validation. The
// contract is composed completion-prose — scalars cannot carry composed
// output. These tests pin the rejection boundary.

test("validateManifestSubagentStage: fails when semantic_edits[item] is `false`", () => {
  // Boolean `false` is the most plausible misuse — a careless subagent might emit
  // `{compose_status_completion_prose: false}` thinking it's a "no-op marker".
  // The contract requires composed prose; `false` is not output-bearing.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: ["compose_status_completion_prose"],
    semantic_edits: { compose_status_completion_prose: false },
    concerns: [],
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.equal(result.gaps.length, 1);
  assert.match(
    result.gaps[0],
    /^compose_status_completion_prose listed in semantic_work_pending: semantic_edits\["compose_status_completion_prose"\] exists but value is empty/,
  );
});

test("validateManifestSubagentStage: fails when semantic_edits[item] is `0`", () => {
  // Number `0` is the second plausible misuse (e.g. an int counter the subagent
  // confused for a payload). Same rejection rule as `false`.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: ["ready_set_re_derivation"],
    semantic_edits: { ready_set_re_derivation: 0 },
    concerns: [],
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.equal(result.gaps.length, 1);
  assert.match(
    result.gaps[0],
    /^ready_set_re_derivation listed in semantic_work_pending: semantic_edits\["ready_set_re_derivation"\] exists but value is empty/,
  );
});

// ---------- Canonical exit-state enforcement ----------
// The validator MUST reject manifests whose `result` is not one of the four
// canonical exit-states (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED)
// per Plan Invariant I-2. Prior validator behavior: `result === undefined`
// slipped through silently and only `BLOCKED`/`NEEDS_CONTEXT` were ever
// consulted (for the halt-state waiver), breaking deterministic Phase-E
// routing.

test("validateManifestSubagentStage: fails when result is null", () => {
  // `result: null` is the script-stage stub shape (per contract §Manifest schema line 62).
  // If the subagent returns this unchanged, the orchestrator can't route Phase E — gap MUST fire.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    affected_files: [],
    result: null,
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some(
      (g) =>
        g.includes("`result` is null") &&
        g.includes("DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED") &&
        g.includes("Plan Invariant I-2"),
    ),
    `expected gap citing canonical states + Plan Invariant I-2 for null result; got: ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: fails when result is an unknown string", () => {
  // Off-canon literals (typos, hallucinated states, legacy values) MUST gap.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    affected_files: [],
    result: "MAYBE",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some(
      (g) =>
        g.includes(`\`result\` is "MAYBE"`) &&
        g.includes("DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED"),
    ),
    `expected gap citing canonical states for unknown result "MAYBE"; got: ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: passes when result is 'DONE'", () => {
  // Round-trip a clean DONE manifest — proves the canonical-state check accepts the
  // happy path and doesn't false-fire when the contract is satisfied.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    affected_files: [],
    result: "DONE",
  };
  assert.deepEqual(validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) }), {
    valid: true,
  });
});

// ---------- BLOCKED-when-schema-violations enforcement ----------
// Contract clause (`references/post-merge-housekeeper-contract.md` §Validation invariants
// line 93): "Every entry in schema_violations appears in concerns ... AND result === BLOCKED".
// The matcher loop already enforces the SURFACE half; this check enforces the EXIT-STATE half.
// Without it, a subagent could ship `DONE`/`DONE_WITH_CONCERNS` while schema_violations
// is non-empty, bypassing the orchestrator's halt/routing-path determinism in Phase E.

test("validateManifestSubagentStage: fails when schema_violations present but result is 'DONE_WITH_CONCERNS'", () => {
  // Subagent surfaced the violation in concerns (so the per-entry matcher passes) BUT
  // returned a non-BLOCKED state. The contract requires BOTH conditions; this case MUST gap.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    schema_violations: [{ kind: "schema_violation", field: "summary", ns_id: "NS-15" }],
    concerns: [{ kind: "schema_violation", field: "summary", ns_id: "NS-15", detail: "..." }],
    affected_files: [],
    result: "DONE_WITH_CONCERNS",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some(
      (g) =>
        g.includes("schema_violations present") &&
        g.includes(`result is "DONE_WITH_CONCERNS"`) &&
        g.includes(`result === "BLOCKED"`),
    ),
    `expected gap citing BLOCKED-required-when-schema_violations; got: ${JSON.stringify(result.gaps)}`,
  );
  // The matcher (check #5) is satisfied (violation has matching concern), so the only
  // gap should be the BLOCKED-state requirement — proves the two checks are independent.
  assert.equal(result.gaps.length, 1);
});

test("validateManifestSubagentStage: passes when schema_violations present AND result is 'BLOCKED'", () => {
  // Both halves of the contract clause satisfied: violations surface in concerns AND
  // result is BLOCKED. The validator returns valid:true (no schema-violation gaps).
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    schema_violations: [{ kind: "schema_violation", field: "summary", ns_id: "NS-15" }],
    concerns: [{ kind: "schema_violation", field: "summary", ns_id: "NS-15", detail: "..." }],
    affected_files: [],
    result: "BLOCKED",
  };
  assert.deepEqual(validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) }), {
    valid: true,
  });
});

// ---------- BLOCKED-when-verification_failures enforcement ----------
// Mirror of Finding 6's schema_violations BLOCKED check. Contract clause from
// `references/post-merge-housekeeper-contract.md` §exit-code 2 line 79: "candidate
// verification failed (Type-signature / file-overlap / plan-identity mismatch — halt
// BLOCKED via subagent surfacing of `verification_failures`)". Without this check, a
// subagent could ship `DONE` / `DONE_WITH_CONCERNS` while verification_failures is
// non-empty, bypassing the orchestrator's halt/routing-path determinism in Phase E.

test("validateManifestSubagentStage: fails when verification_failures present but result is 'DONE_WITH_CONCERNS'", () => {
  // Script exit-2 path: candidate verification failed (e.g. type_signature_mismatch,
  // file_overlap_zero, plan_identity_mismatch). Subagent must end in BLOCKED;
  // returning DONE_WITH_CONCERNS bypasses the documented halt path.
  // verification_failures shape mirrors the script's emission (lines 1209/1426/1446/1466/1495)
  // and the existing fixtures (e.g. fixtures/05-type-signature-violation/expected-manifest.json
  // at line 18: `[{ "kind": "type_signature_mismatch" }]`).
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    verification_failures: [{ kind: "type_signature_mismatch" }],
    concerns: [{ kind: "type_signature_mismatch", detail: "..." }],
    affected_files: [],
    result: "DONE_WITH_CONCERNS",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some(
      (g) =>
        g.includes("verification_failures present") &&
        g.includes(`result is "DONE_WITH_CONCERNS"`) &&
        g.includes(`result === "BLOCKED"`),
    ),
    `expected gap citing BLOCKED-required-when-verification_failures; got: ${JSON.stringify(result.gaps)}`,
  );
  // Only the BLOCKED-state requirement should gap — proves this check is independent
  // of the schema_violations check (which is empty here).
  assert.equal(result.gaps.length, 1);
});

test("validateManifestSubagentStage: passes when verification_failures present AND result is 'BLOCKED'", () => {
  // Both halves of the contract clause satisfied: verification failure surfaced AND
  // result is BLOCKED. The validator returns valid:true (no verification_failures gap).
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    verification_failures: [{ kind: "file_overlap_zero" }],
    concerns: [{ kind: "file_overlap_zero", detail: "..." }],
    affected_files: [],
    result: "BLOCKED",
  };
  assert.deepEqual(validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) }), {
    valid: true,
  });
});

// ---------- Task 4.8: Layer 2 unit tests for D-7 rows 12-15 + I-1/I-2/I-3 invariants ----------

test("buildHousekeeperPrompt: emitted prompt matches the canonical template in references/post-merge-housekeeper-contract.md (D-7 row 12)", () => {
  const contractPath =
    ".claude/skills/plan-execution/references/post-merge-housekeeper-contract.md";
  const contractText = readFileSync(contractPath, "utf8");
  // Extract the canonical template fenced block (delimited by `## Canonical Subagent Prompt Template` heading + first ``` fence)
  const m = contractText.match(/## Canonical Subagent Prompt Template[\s\S]*?```\n([\s\S]+?)```/);
  assert.ok(
    m,
    "contract MUST contain a `## Canonical Subagent Prompt Template` section with a fenced template block",
  );
  const canonicalTemplate = m[1];
  // Render the template with deterministic placeholder values so the comparison is stable
  const emitted = buildHousekeeperPrompt({
    manifestPath: "/tmp/m.json",
    scriptExitCode: 0,
    prNumber: 30,
    manifest: { auto_create: null, schema_violations: [] },
  });
  // Strip placeholder-substitution variance: replace concrete values with the contract's `<placeholders>`
  // so the structural shape matches even if values differ (the test pins SHAPE, not VALUES).
  // Use replaceAll for `<manifest-path>` because the canonical template embeds it twice (line 1
  // "Manifest:" + responsibility #7 "Write back the updated manifest"); buildHousekeeperPrompt's
  // replaceAll substitutes both occurrences and the snapshot must invert both.
  const normalized = emitted
    .replaceAll("/tmp/m.json", "<manifest-path>")
    .replaceAll("PR #30", "PR #<N>")
    .replaceAll("exit code: 0", "exit code: <N>");
  assert.equal(
    normalized.trim(),
    canonicalTemplate.trim(),
    "buildHousekeeperPrompt drift from contract — update one to match the other (Plan §Decisions-Locked D-1: contract is canonical)",
  );
});

// Defined inline here for test isolation; the production schema lives in
// .claude/skills/plan-execution/lib/manifest-schema.mjs (a dependency of housekeeper-orchestrator-helpers.mjs).
const ManifestSchema = z.object({
  pr_number: z.number().int().positive(),
  script_exit_code: z.number().int().min(0).max(7),
  result: z.enum(["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"]).nullable(),
  matched_entry: z
    .object({
      ns_id: z.string().regex(/^NS-\d+[a-z]?$/),
      heading: z.string(),
      shape: z.enum(["single-pr", "multi-pr"]),
      file: z.string(),
      heading_line: z.number().int().positive(),
    })
    .nullable(),
  mechanical_edits: z.object({}).passthrough(),
  semantic_edits: z.object({}).passthrough(),
  schema_violations: z.array(z.object({ kind: z.string() }).passthrough()),
  semantic_work_pending: z.array(z.string()),
  affected_files: z.array(z.string()),
  concerns: z.array(z.object({ kind: z.string() }).passthrough()),
  auto_create: z
    .object({ reserved_ns_nn: z.number().int().positive(), derived_title_seed: z.string() })
    .nullable(),
});

test("emitManifest output passes zod parse against §5.3 schema (D-7 row 13)", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "manifest-zod-"));
  try {
    const result = emitManifest({
      repoRoot: tmpRepo,
      prNumber: 30,
      plan: "024",
      phase: "1",
      taskId: null,
      scriptExitCode: 0,
      matchedEntry: {
        nsId: "NS-01",
        heading: "### NS-01: Plan-024 Phase 1 — Rust crate scaffolding",
        shape: "single-pr",
        file: "docs/architecture/cross-plan-dependencies.md",
        headingLine: 342,
      },
      mechanicalEdits: { status_flip: { from: "ready", to: "completed" } },
      schemaViolations: [],
      affectedFiles: ["docs/architecture/cross-plan-dependencies.md"],
      semanticWorkPending: [],
    });
    const written = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    const parsed = ManifestSchema.safeParse(written);
    assert.ok(parsed.success, `zod parse failed: ${JSON.stringify(parsed.error?.issues, null, 2)}`);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("validateManifestSubagentStage: subagent-emitted affected_files is superset of script-detected overlap (D-7 row 14)", () => {
  // The script's stage-1 manifest declares affected_files = ["docs/architecture/cross-plan-dependencies.md"].
  // The subagent's stage-2 manifest must include EVERY file the script declared, plus any it added.
  const scriptAffectedFiles = [
    "docs/architecture/cross-plan-dependencies.md",
    "docs/plans/024-rust-pty-sidecar.md",
  ];
  const subagentManifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    affected_files: ["docs/architecture/cross-plan-dependencies.md"], // missing the second file → must FAIL
    result: "DONE",
  };
  const result = validateManifestSubagentStage({
    manifest: subagentManifest,
    ...stageOneFromManifest(subagentManifest),
    scriptAffectedFiles,
  });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some(
      (g) => g.includes("docs/plans/024-rust-pty-sidecar.md") && g.includes("affected_files"),
    ),
    `expected gap to mention the dropped file; got ${JSON.stringify(result.gaps)}`,
  );
});

// ---------- Script-stage schema_violations preservation ----------
// The validator's check #6 enforces BLOCKED routing on the subagent-written
// `manifest.schema_violations`, but never checks the subagent retained the
// script-stage entries. Without an immutable comparison, a subagent could clear
// the array and return DONE/DONE_WITH_CONCERNS, bypassing BLOCKED entirely.
// Mirrors the scriptAffectedFiles superset semantics (D-7 row 14).

test("validateManifestSubagentStage: subagent-emitted schema_violations is superset of script-stage snapshot", () => {
  const scriptSchemaViolations = [
    { kind: "schema_violation", field: "PRs", ns_id: "NS-02" },
    { kind: "auto_create_title_seed_underivable", field: null, ns_id: null },
  ];
  // Subagent dropped both entries — bypassing the BLOCKED enforcement.
  const subagentManifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    schema_violations: [], // CLEARED by careless / malicious subagent
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({
    manifest: subagentManifest,
    ...stageOneFromManifest(subagentManifest),
    scriptSchemaViolations,
  });
  assert.equal(result.valid, false);
  // Both script-stage violations must surface as gaps.
  assert.ok(
    result.gaps.some(
      (g) =>
        g.includes("kind=schema_violation") && g.includes("field=PRs") && g.includes("ns_id=NS-02"),
    ),
    `expected gap for the schema_violation entry; got ${JSON.stringify(result.gaps)}`,
  );
  assert.ok(
    result.gaps.some((g) => g.includes("kind=auto_create_title_seed_underivable")),
    `expected gap for the auto_create entry; got ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: subagent passes when schema_violations preserves script-stage snapshot", () => {
  // Subagent retains the script-stage violation AND surfaces it in concerns AND
  // returns BLOCKED — the canonical happy-path shape under exit-5 halt.
  const scriptSchemaViolations = [{ kind: "schema_violation", field: "PRs", ns_id: "NS-02" }];
  const subagentManifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [
      {
        kind: "schema_violation",
        field: "PRs",
        ns_id: "NS-02",
        addressing: "schema_violation",
        detail: "PRs block missing on NS-02; surfaced for user adjudication",
      },
    ],
    schema_violations: [
      { kind: "schema_violation", field: "PRs", ns_id: "NS-02" }, // PRESERVED
    ],
    affected_files: [],
    result: "BLOCKED",
  };
  assert.deepEqual(
    validateManifestSubagentStage({
      manifest: subagentManifest,
      ...stageOneFromManifest(subagentManifest),
      scriptSchemaViolations,
    }),
    { valid: true },
  );
});

test("validateManifestSubagentStage: subagent may ADD new schema_violations beyond script-stage snapshot", () => {
  // Mirror of the affected_files extension allowance — subagent surfaces a NEW
  // schema problem the script missed. Allowed because check #9 is a superset
  // check, not a strict-equality check.
  const scriptSchemaViolations = [{ kind: "schema_violation", field: "PRs", ns_id: "NS-02" }];
  const subagentManifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [
      { kind: "schema_violation", field: "PRs", ns_id: "NS-02", addressing: "schema_violation" },
      { kind: "schema_violation", field: "Status", ns_id: "NS-04", addressing: "schema_violation" },
    ],
    schema_violations: [
      { kind: "schema_violation", field: "PRs", ns_id: "NS-02" }, // preserved
      { kind: "schema_violation", field: "Status", ns_id: "NS-04" }, // ADDED by subagent
    ],
    affected_files: [],
    result: "BLOCKED",
  };
  assert.deepEqual(
    validateManifestSubagentStage({
      manifest: subagentManifest,
      ...stageOneFromManifest(subagentManifest),
      scriptSchemaViolations,
    }),
    { valid: true },
  );
});

// ---------- Script-stage verification_failures preservation ----------
// Mirror of the schema_violations preservation tests above — same bypass
// shape but for the exit-2 halt path.
// Without an immutable comparison, a subagent could clear
// manifest.verification_failures and return DONE/DONE_WITH_CONCERNS, bypassing
// check #8's BLOCKED enforcement for Type-signature / file-overlap /
// plan-identity mismatch / multi_pr_task_not_in_block.

test("validateManifestSubagentStage: subagent-emitted verification_failures is superset of script-stage snapshot", () => {
  const scriptVerificationFailures = [
    { kind: "type_signature_mismatch" },
    { kind: "file_overlap_zero" },
    { kind: "auto_create_duplicate_title", colliding_with: "NS-15" },
  ];
  // Subagent dropped all three entries — bypassing the BLOCKED enforcement.
  const subagentManifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    verification_failures: [], // CLEARED by careless / malicious subagent
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({
    manifest: subagentManifest,
    ...stageOneFromManifest(subagentManifest),
    scriptVerificationFailures,
  });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some((g) => g.includes("type_signature_mismatch")),
    `expected gap for type_signature_mismatch; got ${JSON.stringify(result.gaps)}`,
  );
  assert.ok(
    result.gaps.some((g) => g.includes("file_overlap_zero")),
    `expected gap for file_overlap_zero; got ${JSON.stringify(result.gaps)}`,
  );
  assert.ok(
    result.gaps.some((g) => g.includes("auto_create_duplicate_title") && g.includes("NS-15")),
    `expected gap for auto_create_duplicate_title with colliding_with field; got ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: subagent passes when verification_failures preserves script-stage snapshot", () => {
  // Canonical happy-path under exit-2 halt — subagent retains script-stage
  // failure AND surfaces it in concerns AND returns BLOCKED.
  const scriptVerificationFailures = [{ kind: "type_signature_mismatch" }];
  const subagentManifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [
      {
        kind: "type_signature_mismatch",
        addressing: "type_signature_mismatch",
        detail: "candidate Type signature mismatch; surfaced for user adjudication",
      },
    ],
    verification_failures: [{ kind: "type_signature_mismatch" }], // PRESERVED
    affected_files: [],
    result: "BLOCKED",
  };
  assert.deepEqual(
    validateManifestSubagentStage({
      manifest: subagentManifest,
      ...stageOneFromManifest(subagentManifest),
      scriptVerificationFailures,
    }),
    { valid: true },
  );
});

test("validateManifestSubagentStage: key-order-independent JSON canonicalization for verification_failures", () => {
  // The check #10 key uses JSON.stringify with sorted keys, so the subagent can
  // serialize entries with keys in a different order than the script and the
  // comparison still matches. Verifies the determinism property of the canonical
  // key — protects against false-positive gaps when the subagent re-stringifies.
  const scriptVerificationFailures = [
    { kind: "auto_create_duplicate_title", colliding_with: "NS-15" },
  ];
  const subagentManifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [{ kind: "auto_create_duplicate_title", addressing: "auto_create_duplicate_title" }],
    verification_failures: [
      // Same logical entry but keys deliberately re-ordered (subagent re-stringified).
      { colliding_with: "NS-15", kind: "auto_create_duplicate_title" },
    ],
    affected_files: [],
    result: "BLOCKED",
  };
  assert.deepEqual(
    validateManifestSubagentStage({
      manifest: subagentManifest,
      ...stageOneFromManifest(subagentManifest),
      scriptVerificationFailures,
    }),
    { valid: true },
  );
});

// ---------- Script-stage semantic_work_pending preservation ----------

test("validateManifestSubagentStage: cleared semantic_work_pending no longer bypasses per-item iteration", () => {
  // The per-item pairing iteration at L180 reads
  // `manifest.semantic_work_pending`, so a subagent could clear that array and
  // return DONE/DONE_WITH_CONCERNS — the iteration would loop zero times and
  // emit zero gaps, letting unaddressed semantic work pass validation. Same
  // bypass shape as schema_violations and verification_failures preservation
  // above, but structurally different fix: instead of a separate preservation
  // check (which would force a 3-round dance — array-shrink gap → re-add →
  // unaddressed), feed the existing iteration with the UNION of script-stage +
  // subagent arrays so the gap message stays "X listed but unaddressed" —
  // directly actionable in ONE round-trip. The script snapshot is the
  // immutable contract.
  const scriptSemanticWorkPending = ["compose_status_completion_prose", "ready_set_re_derivation"];
  const subagentManifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [], // CLEARED — pre-fix this bypassed validation entirely.
    semantic_edits: {}, // No prose composed.
    concerns: [], // No concerns recorded.
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({
    manifest: subagentManifest,
    ...stageOneFromManifest(subagentManifest),
    scriptSemanticWorkPending,
  });
  assert.equal(result.valid, false);
  assert.equal(
    result.gaps.length,
    2,
    `expected 2 gaps (one per script-stage pending item); got: ${JSON.stringify(result.gaps)}`,
  );
  assert.ok(
    result.gaps.some((g) => g.startsWith("compose_status_completion_prose listed in")),
    `expected gap for compose_status_completion_prose; got: ${JSON.stringify(result.gaps)}`,
  );
  assert.ok(
    result.gaps.some((g) => g.startsWith("ready_set_re_derivation listed in")),
    `expected gap for ready_set_re_derivation; got: ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: subagent passes when all script-stage pending items are addressed", () => {
  // Canonical happy path: subagent preserves the script-stage pending list and
  // addresses every item via semantic_edits or concerns.addressing.
  const scriptSemanticWorkPending = ["compose_status_completion_prose", "ready_set_re_derivation"];
  const subagentManifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: ["compose_status_completion_prose", "ready_set_re_derivation"],
    semantic_edits: {
      compose_status_completion_prose: "(resolved 2026-05-06 via PR #33 — auto-housekeeping prose)",
    },
    concerns: [
      {
        kind: "deferred_for_followup",
        addressing: "ready_set_re_derivation",
        detail: "subagent surfaces ready-set rederivation as deferred",
      },
    ],
    affected_files: [],
    result: "DONE_WITH_CONCERNS",
  };
  assert.deepEqual(
    validateManifestSubagentStage({
      manifest: subagentManifest,
      ...stageOneFromManifest(subagentManifest),
      scriptSemanticWorkPending,
    }),
    { valid: true },
  );
});

test("validateManifestSubagentStage: subagent-added pending items are also iterated (union semantics)", () => {
  // The validator uses Set union of script-stage + subagent-stage so
  // subagent-added pending items are caught too. If subagent commits to
  // addressing a new item by adding it to semantic_work_pending, the iteration
  // must check it for pairing — otherwise the subagent could add work and
  // silently skip addressing it.
  const scriptSemanticWorkPending = ["compose_status_completion_prose"];
  const subagentManifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    // Subagent ADDED `line_cite_sweep` (committed to addressing it) but did NOT
    // pair it with semantic_edits or concerns.
    semantic_work_pending: ["compose_status_completion_prose", "line_cite_sweep"],
    semantic_edits: {
      compose_status_completion_prose: "(resolved 2026-05-06 via PR #33 — prose)",
    },
    concerns: [],
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({
    manifest: subagentManifest,
    ...stageOneFromManifest(subagentManifest),
    scriptSemanticWorkPending,
  });
  assert.equal(result.valid, false);
  assert.equal(
    result.gaps.length,
    1,
    `expected exactly 1 gap (line_cite_sweep unaddressed; compose_status_completion_prose IS addressed); got: ${JSON.stringify(result.gaps)}`,
  );
  assert.ok(
    result.gaps.some((g) => g.startsWith("line_cite_sweep listed in")),
    `expected gap for subagent-added line_cite_sweep; got: ${JSON.stringify(result.gaps)}`,
  );
});

// ---------- manifest._script_stage embedded-snapshot regression tests ----------
// These four tests pin the embedded-snapshot fix: the validator reads the
// script-stage snapshot from manifest._script_stage when scriptXXX params are
// absent, and a structural-tampering check catches subagents that try to
// bypass preservation checks by removing or corrupting the snapshot.

test("validateManifestSubagentStage: snapshot-fallback path still surfaces preservation gaps when orchestrator forgot to plumb scriptXXX", () => {
  // Defense-in-depth: even when the orchestrator forgets to plumb scriptXXX
  // from its stage-1 conversation memory (the production-path described in
  // SKILL.md step 5), the validator falls back to manifest._script_stage so
  // the per-field preservation checks (#7/#9/#10/#11) still catch a bypass
  // attempt where the subagent cleared all four top-level emit arrays. This
  // test pins that fallback path: NO scriptXXX param is passed, the
  // script-stage snapshot is in the manifest, the subagent attempted to clear
  // all four arrays, and the validator catches the bypass via the
  // manifest-embedded snapshot. The new baseline-trust gap ALSO fires (it
  // surfaces the missing scriptXXX plumbing as the primary defense; the
  // snapshot-fallback gaps are a secondary belt-and-braces signal that must
  // remain functional in case the orchestrator misses both layers).
  const subagentManifest = {
    _script_stage: {
      affected_files: ["docs/plans/024-rust-pty-sidecar.md"],
      schema_violations: [{ kind: "schema_violation", field: "PRs", ns_id: "NS-02" }],
      verification_failures: [{ kind: "type_signature_mismatch" }],
      semantic_work_pending: ["compose_status_completion_prose"],
    },
    // Subagent CLEARED all four — bypass attempt
    affected_files: [],
    schema_violations: [],
    verification_failures: [],
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest: subagentManifest });
  assert.equal(result.valid, false);
  // Expect 5 gaps: baseline-trust (orchestrator-MUST-plumb), affected_files
  // superset (#7), schema_violations preservation (#9), verification_failures
  // preservation (#10), semantic_work_pending union (#11). No structural-
  // tampering gap because _script_stage IS present and well-formed.
  assert.ok(
    result.gaps.some(
      (g) =>
        g.includes("manifest._script_stage is subagent-emitted and may be tampered") &&
        g.includes("orchestrator MUST plumb"),
    ),
    `expected baseline-trust gap surfacing missing scriptXXX plumbing; got: ${JSON.stringify(result.gaps)}`,
  );
  assert.ok(
    result.gaps.some(
      (g) => g.includes("docs/plans/024-rust-pty-sidecar.md") && g.includes("D-7 row 14"),
    ),
    `expected affected_files superset gap (check #7); got: ${JSON.stringify(result.gaps)}`,
  );
  assert.ok(
    result.gaps.some((g) => g.includes("script-stage schema_violation") && g.includes("NS-02")),
    `expected schema_violations preservation gap (check #9); got: ${JSON.stringify(result.gaps)}`,
  );
  assert.ok(
    result.gaps.some(
      (g) =>
        g.includes("script-stage verification_failure") && g.includes("type_signature_mismatch"),
    ),
    `expected verification_failures preservation gap (check #10); got: ${JSON.stringify(result.gaps)}`,
  );
  assert.ok(
    result.gaps.some((g) =>
      g.startsWith("compose_status_completion_prose listed in semantic_work_pending"),
    ),
    `expected semantic_work_pending union gap (check #11) sourced from _script_stage; got: ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: missing _script_stage emits structural tampering gap (alongside baseline-trust gap)", () => {
  // Tertiary-attack defense: subagent CLEARS schema_violations AND ALSO
  // removes _script_stage to defeat the manifest-embedded snapshot path. The
  // primary defense is the orchestrator's stage-1 conversation-memory plumbing
  // (surfaced as the baseline-trust gap when scriptXXX is omitted, as in this
  // test); the structural sub-check #12 is a secondary signal for the case
  // where the orchestrator missed plumbing AND the subagent also tampered with
  // the manifest-embedded snapshot.
  const tamperedManifest = {
    // _script_stage REMOVED by subagent (bypass attempt)
    affected_files: [],
    schema_violations: [],
    verification_failures: [],
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest: tamperedManifest });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some(
      (g) =>
        g.includes("manifest._script_stage is subagent-emitted and may be tampered") &&
        g.includes("orchestrator MUST plumb"),
    ),
    `expected baseline-trust gap surfacing missing scriptXXX plumbing; got: ${JSON.stringify(result.gaps)}`,
  );
  assert.ok(
    result.gaps.some(
      (g) =>
        g.includes("manifest._script_stage missing") &&
        g.includes("circumvents preservation checks #7/#9/#10/#11"),
    ),
    `expected structural-tampering gap for missing _script_stage; got: ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: malformed _script_stage (string instead of object) emits gap (alongside baseline-trust gap)", () => {
  // Tampering variant: subagent replaces _script_stage with a non-object value
  // (string, array, scalar). The structural-tampering check rejects all three
  // shapes — only `{affected_files, schema_violations, verification_failures,
  // semantic_work_pending}` (each an array) satisfies the contract. The
  // baseline-trust gap also fires because scriptXXX is omitted (orchestrator
  // forgot to plumb stage-1 memory; structural check #12 then catches the
  // secondary tampering on the manifest-embedded snapshot).
  const tamperedManifest = {
    _script_stage: "tampered-by-subagent",
    affected_files: [],
    schema_violations: [],
    verification_failures: [],
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest: tamperedManifest });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some(
      (g) =>
        g.includes("manifest._script_stage is subagent-emitted and may be tampered") &&
        g.includes("orchestrator MUST plumb"),
    ),
    `expected baseline-trust gap surfacing missing scriptXXX plumbing; got: ${JSON.stringify(result.gaps)}`,
  );
  assert.ok(
    result.gaps.some(
      (g) => g.includes("manifest._script_stage is not an object") && g.includes("got string"),
    ),
    `expected structural-tampering gap naming the string kind; got: ${JSON.stringify(result.gaps)}`,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Baseline-trust gap (Codex P1 fix on PR #33 thread AyDCN — "Require external
// script snapshot for preservation checks")
//
// The untamperable baseline for the four preservation/iteration checks
// (#7/#9/#10/#11) is the orchestrator-LLM's stage-1 conversation memory of
// the script-emitted manifest (read in SKILL.md step 3, frozen in context
// before subagent dispatch, inaccessible to the dispatched subagent which
// runs in a separated context). The orchestrator MUST plumb that stored
// snapshot forward as the four `scriptXXX` params on this validator call.
// When ANY scriptXXX is omitted, the validator's snapshot-fallback path
// reads `manifest._script_stage` instead — which is subagent-emitted and
// thus potentially tampered (the structural sub-check #12 catches outright
// shape tampering but not the narrower case where `_script_stage.{field}`
// is cleared to `[]` while shape stays intact, matching a corresponding
// cleared top-level emit field). The baseline-trust gap surfaces the
// missing scriptXXX plumbing as a primary defense so Phase E re-routes
// through the explicit-plumbing path before a tampered snapshot silently
// bypasses preservation enforcement.
// ──────────────────────────────────────────────────────────────────────────

test("validateManifestSubagentStage: baseline-trust gap fires when scriptXXX omitted (orchestrator forgot to plumb stage-1 snapshot)", () => {
  // Positive: healthy `_script_stage`, scriptXXX completely omitted, baseline-
  // trust gap MUST fire. Validates the gap-push at the head of the
  // `if (reliesOnManifestSnapshot)` block — `null == null` triggers reliance,
  // gap surfaces orchestrator-MUST-plumb. No other gaps because the rest of
  // the manifest is contract-shaped (DONE result, empty arrays, _script_stage
  // structurally well-formed).
  const subagentManifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    affected_files: [],
    schema_violations: [],
    verification_failures: [],
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest: subagentManifest });
  assert.equal(result.valid, false);
  assert.equal(
    result.gaps.length,
    1,
    `expected exactly the baseline-trust gap; got: ${JSON.stringify(result.gaps)}`,
  );
  assert.match(result.gaps[0], /manifest\._script_stage is subagent-emitted and may be tampered/);
  assert.match(result.gaps[0], /orchestrator MUST plumb/);
  assert.match(result.gaps[0], /stage-1 manifest snapshot stored in conversation memory/);
  assert.match(
    result.gaps[0],
    /falling back to manifest\._script_stage allows preservation bypass/,
  );
});

test("validateManifestSubagentStage: baseline-trust gap suppressed when all four scriptXXX plumbed (production-path)", () => {
  // Negative: orchestrator plumbs scriptXXX from its stage-1 conversation
  // memory (simulated via `stageOneFromManifest(manifest)` spread). All four
  // scriptXXX are non-null, so `reliesOnManifestSnapshot === false` and the
  // baseline-trust gap does NOT fire. Validates the production-path: with
  // proper plumbing, the snapshot-fallback path is skipped entirely and the
  // structural sub-checks #12 are also skipped (the snapshot is irrelevant
  // because the baseline came from orchestrator memory, not the subagent-
  // emitted `_script_stage`).
  const subagentManifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    affected_files: [],
    schema_violations: [],
    verification_failures: [],
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    result: "DONE",
  };
  assert.deepEqual(
    validateManifestSubagentStage({
      manifest: subagentManifest,
      ...stageOneFromManifest(subagentManifest),
    }),
    { valid: true },
  );
});

test("validateManifestSubagentStage: scriptXXX param takes precedence over manifest._script_stage", () => {
  // Precedence rule per check #12: explicit scriptXXX param > manifest._script_stage[field].
  // Test: pass scriptSchemaViolations with one value; embed a DIFFERENT value
  // in manifest._script_stage.schema_violations. The preservation check should
  // fire on the PARAM value (subagent must preserve PARAM_SV not SNAPSHOT_SV) —
  // proves the param wins and the snapshot is decorative for that field.
  const PARAM_SV = [{ kind: "schema_violation", field: "PRs", ns_id: "NS-99" }];
  const SNAPSHOT_SV = [{ kind: "schema_violation", field: "Type", ns_id: "NS-77" }];
  const subagentManifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: SNAPSHOT_SV,
      verification_failures: [],
      semantic_work_pending: [],
    },
    affected_files: [],
    schema_violations: [],
    verification_failures: [],
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    result: "BLOCKED",
  };
  const result = validateManifestSubagentStage({
    manifest: subagentManifest,
    ...stageOneFromManifest(subagentManifest),
    scriptSchemaViolations: PARAM_SV,
  });
  assert.equal(result.valid, false);
  // Param value (NS-99) MUST surface as gap — it's what the subagent failed to preserve.
  assert.ok(
    result.gaps.some((g) => g.includes("NS-99") && g.includes("script-stage schema_violation")),
    `expected preservation gap for PARAM_SV (NS-99); got: ${JSON.stringify(result.gaps)}`,
  );
  // Snapshot value (NS-77) MUST NOT surface — param won the precedence battle.
  assert.ok(
    !result.gaps.some((g) => g.includes("NS-77")),
    `snapshot NS-77 must NOT appear in gaps when param NS-99 took precedence; got: ${JSON.stringify(result.gaps)}`,
  );
});

test("detectAffectedFilesSprawl: edits outside manifest's affected_files trigger REDISPATCH routing — NOT DONE_WITH_CONCERNS at first detection (failure-modes.md rule 20)", () => {
  const result = detectAffectedFilesSprawl({
    manifestAffectedFiles: ["docs/architecture/cross-plan-dependencies.md"],
    gitDiffFiles: ["docs/architecture/cross-plan-dependencies.md", "docs/plans/099-mystery.md"],
  });
  assert.equal(result.sprawl, true);
  assert.deepEqual(result.outOfScope, ["docs/plans/099-mystery.md"]);
  assert.equal(
    result.suggestedRouting,
    "REDISPATCH",
    "first detection MUST route to REDISPATCH per rule 20; DONE_WITH_CONCERNS is only valid AFTER the re-dispatched subagent picks (b) with weak justification",
  );
  assert.match(result.suggestedConcernKind, /affected_files_extension/);
  assert.ok(
    result.redispatchPromptTemplate.includes("docs/plans/099-mystery.md"),
    "redispatchPromptTemplate must enumerate the specific out-of-scope files so the subagent knows what to revert/justify",
  );
  assert.ok(
    result.redispatchPromptTemplate.includes("(a) revert") &&
      result.redispatchPromptTemplate.includes("(b) extend"),
    "redispatchPromptTemplate must offer the rule-20 (a) revert / (b) extend choice verbatim",
  );
  assert.ok(
    result.redispatchPromptTemplate.includes("affected_files_extension"),
    "redispatchPromptTemplate must name the canonical concerns-entry kind for option (b)",
  );
});

test("detectAffectedFilesSprawl: no sprawl returns sprawl:false with no routing (negative case for Finding 15 fix)", () => {
  const result = detectAffectedFilesSprawl({
    manifestAffectedFiles: ["docs/architecture/cross-plan-dependencies.md"],
    gitDiffFiles: ["docs/architecture/cross-plan-dependencies.md"],
  });
  assert.deepEqual(result, { sprawl: false });
});

test("I-1 invariant: every cross-plan-dependencies.md NS heading remains extractable by the cite-target hook", () => {
  // The cite-target hook (tools/docs-corpus/bin/pre-commit-runner.ts) parses each ../../ path
  // form and verifies the target file + line range exists. After the housekeeper introduces
  // PRs:-block migrations + NS-23 + auto-create stubs, the hook MUST still pass against the
  // current cross-plan-dependencies.md without "broken cite" errors. This test is a regression
  // canary: if a housekeeper-mutating commit breaks a cite, this assertion catches it.
  // Assert on the exception itself, not on a
  // derived stderr string. The prior `e.stderr?.toString() ?? ...` chain stopped
  // on empty-string (??-falls-back-on-null/undefined-only), so a hook that exited
  // nonzero with empty stderr produced stderr = "" and the final equality check
  // passed — false-positive that hid cite-target regressions. Now any throw fails
  // the assertion with the captured exit code + stderr + stdout for diagnosis.
  let caughtError = null;
  let stderr = "";
  let stdout = "";
  let exitCode = 0;
  try {
    execSync(
      "node --experimental-strip-types tools/docs-corpus/bin/pre-commit-runner.ts docs/architecture/cross-plan-dependencies.md",
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (e) {
    caughtError = e;
    stderr = e.stderr?.toString() ?? "";
    stdout = e.stdout?.toString() ?? "";
    exitCode = e.status ?? e.code ?? -1;
  }
  assert.equal(
    caughtError,
    null,
    `cite-target hook failed (exit ${exitCode}) against current catalog — I-1 regression\nSTDERR: ${stderr}\nSTDOUT: ${stdout}`,
  );
});

test("I-2 invariant: plan-execution-housekeeper.md declares ONLY the four canonical exit-states (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED)", () => {
  const def = readFileSync(".claude/agents/plan-execution-housekeeper.md", "utf8");
  // Find every `RESULT: <STATE>` reference (the contract pattern from failure-modes.md "Reading subagent responses")
  const stateRefs = [...def.matchAll(/RESULT:\s*([A-Z_]+)/g)].map((m) => m[1]);
  const uniqueStates = new Set(stateRefs);
  const allowed = new Set(["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"]);
  // Every state mentioned must be in the allowlist (no rogue states)
  for (const state of uniqueStates) {
    assert.ok(
      allowed.has(state),
      `I-2 invariant violated: subagent definition declares non-canonical exit-state "${state}"`,
    );
  }
  // The full canonical set must appear at least once (defensive — if a state goes missing, the subagent
  // can't communicate it back to the orchestrator and the routing rules in failure-modes.md don't fire).
  for (const state of allowed) {
    assert.ok(
      uniqueStates.has(state),
      `I-2 invariant violated: subagent definition does not declare canonical exit-state "${state}"`,
    );
  }
});

// ───────────────────────────────────────────────────────────────────────────
// decideHousekeeperRouting — exit-code → dispatch/halt mapping
//
// SKILL.md Phase E step 4 dispatched the housekeeper subagent unconditionally
// after manifest validation, but the contract classifies several script exits
// as orchestrator-stage halts (operator action required, NOT subagent work).
// These tests pin the dispatch/halt mapping so a future drift in either the
// helper or the contract surfaces as a test failure rather than a runtime
// misroute. One test per documented exit class plus a defensive-fallback test.
// ───────────────────────────────────────────────────────────────────────────

test("decideHousekeeperRouting: exit 0 (success) → dispatch", () => {
  const r = decideHousekeeperRouting({ scriptExitCode: 0 });
  assert.equal(r.action, "dispatch");
  assert.equal(r.exitClass, "subagent-handled");
});

test("decideHousekeeperRouting: exit 1 (--candidate-ns NS-XX not found) → halt orchestrator-misdispatch", () => {
  const r = decideHousekeeperRouting({ scriptExitCode: 1 });
  assert.equal(r.action, "halt");
  assert.equal(r.exitClass, "orchestrator-misdispatch");
  assert.match(r.reason, /not found/);
  assert.match(r.surfacePromptTemplate, /Do NOT dispatch/);
});

test("decideHousekeeperRouting: exit 2 (verification failed) → dispatch (subagent surfaces BLOCKED)", () => {
  const r = decideHousekeeperRouting({ scriptExitCode: 2 });
  assert.equal(r.action, "dispatch");
  assert.equal(r.exitClass, "subagent-handled");
});

test("decideHousekeeperRouting: exit 3 (Done Checklist absent / fully ticked) → dispatch (semantic work still applies)", () => {
  const r = decideHousekeeperRouting({ scriptExitCode: 3 });
  assert.equal(r.action, "dispatch");
  assert.equal(r.exitClass, "subagent-handled");
});

test("decideHousekeeperRouting: exit 4 (multi-PR shape, --task arg missing) → halt orchestrator-misdispatch", () => {
  const r = decideHousekeeperRouting({ scriptExitCode: 4 });
  assert.equal(r.action, "halt");
  assert.equal(r.exitClass, "orchestrator-misdispatch");
  assert.match(r.reason, /multi-PR/);
  assert.match(r.surfacePromptTemplate, /Do NOT dispatch/);
});

test("decideHousekeeperRouting: exit 5 (schema_violations) → dispatch (subagent surfaces BLOCKED)", () => {
  const r = decideHousekeeperRouting({ scriptExitCode: 5 });
  assert.equal(r.action, "dispatch");
  assert.equal(r.exitClass, "subagent-handled");
});

test("decideHousekeeperRouting: exit 6 (script crash boundary) → halt script-crash", () => {
  const r = decideHousekeeperRouting({ scriptExitCode: 6 });
  assert.equal(r.action, "halt");
  assert.equal(r.exitClass, "script-crash");
  assert.match(r.reason, /crash/);
  assert.match(r.surfacePromptTemplate, /crashed script/);
});

test("decideHousekeeperRouting: exit 137 (killed by SIGKILL — common crash) → halt script-crash", () => {
  const r = decideHousekeeperRouting({ scriptExitCode: 137 });
  assert.equal(r.action, "halt");
  assert.equal(r.exitClass, "script-crash");
});

test("decideHousekeeperRouting: defensive fallback for unrecognized exit (negative integer) → halt unknown-exit-code", () => {
  const r = decideHousekeeperRouting({ scriptExitCode: -1 });
  assert.equal(r.action, "halt");
  assert.equal(r.exitClass, "unknown-exit-code");
  assert.match(r.reason, /unrecognized/);
  assert.match(r.surfacePromptTemplate, /Operator action required/);
});

test("decideHousekeeperRouting: defensive fallback for non-integer exit (e.g. NaN) → halt unknown-exit-code (not dispatch)", () => {
  const r = decideHousekeeperRouting({ scriptExitCode: NaN });
  assert.equal(r.action, "halt");
  assert.equal(r.exitClass, "unknown-exit-code");
});

// ──────────────────────────────────────────────────────────────────────────
// assertRepoRelative + validator path-containment integration tests
// assertRepoRelative + path-containment in affected_files
//
// Codex finding: validator's affected_files loop joined each declared path
// against `repoRoot` and read it without first checking the path was
// repo-relative. A malformed manifest emitting an absolute path or a
// parent-traversal silently bypassed validation; the script's later
// step-7 `git add <affected_files>` would fail with "outside repository
// pathspec", dead-ending housekeeping after a `valid: true` signal.
//
// The fix encodes containment in `assertRepoRelative` (lexical check,
// repo-relative shape + non-traversal); validator now consults it BEFORE
// existsSync. These 7 tests cover the helper's three branches directly
// (absolute reject / traversal reject / accept) and the validator's three
// integration paths (absolute → gap, traversal → gap, internal navigation
// that stays in repo → no path-containment gap).
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
  const result = assertRepoRelative("docs/architecture/cross-plan-dependencies.md", "/repo");
  assert.equal(result.ok, true);
  assert.equal(result.full, "/repo/docs/architecture/cross-plan-dependencies.md");
});

test("validateManifestSubagentStage: rejects absolute path in affected_files with path-containment gap", () => {
  // Integration: bypass class fixed in this PR. Without `assertRepoRelative`,
  // the validator joined "/etc/passwd" against repoRoot via path.join — which
  // returns "/repo/etc/passwd" (NOT "/etc/passwd", because join lacks
  // resolve's absolute-path short-circuit) — and the file would either be
  // missing (gap fires under the existsSync branch) or, in a hostile shape,
  // could resolve to something the subagent never had authority to declare.
  // The fix: surface absolute paths as their own gap class BEFORE existsSync,
  // keyed to the contract clause "repo-relative paths".
  const tmpRepo = mkdtempSync(join(tmpdir(), "validate-abspath-"));
  try {
    const manifest = {
      _script_stage: {
        affected_files: [],
        schema_violations: [],
        verification_failures: [],
        semantic_work_pending: [],
      },
      semantic_work_pending: [],
      semantic_edits: {},
      concerns: [],
      affected_files: ["/etc/passwd"],
      result: "DONE",
    };
    const result = validateManifestSubagentStage({
      manifest,
      repoRoot: tmpRepo,
      ...stageOneFromManifest(manifest),
    });
    assert.equal(result.valid, false);
    assert.equal(result.gaps.length, 1);
    assert.match(result.gaps[0], /^\/etc\/passwd is an absolute path/);
    assert.match(result.gaps[0], /\(declared in affected_files\)$/);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("validateManifestSubagentStage: rejects parent-traversal path in affected_files with path-containment gap", () => {
  // Integration: `../../etc/passwd` joined against tmpRepo resolves OUTSIDE
  // tmpRepo. Without `assertRepoRelative`, validator would have read the
  // outside-repo file (or hit ENOENT) and never surfaced the contract
  // violation as a containment gap. The fix surfaces it as a distinct gap
  // class BEFORE existsSync, so the orchestrator can route it as a subagent
  // contract violation rather than mis-classifying it as deletion-of-declared.
  const tmpRepo = mkdtempSync(join(tmpdir(), "validate-traversal-"));
  try {
    const manifest = {
      _script_stage: {
        affected_files: [],
        schema_violations: [],
        verification_failures: [],
        semantic_work_pending: [],
      },
      semantic_work_pending: [],
      semantic_edits: {},
      concerns: [],
      affected_files: ["../../etc/passwd"],
      result: "DONE",
    };
    const result = validateManifestSubagentStage({
      manifest,
      repoRoot: tmpRepo,
      ...stageOneFromManifest(manifest),
    });
    assert.equal(result.valid, false);
    assert.equal(result.gaps.length, 1);
    assert.match(result.gaps[0], /^\.\.\/\.\.\/etc\/passwd resolves outside the repository/);
    assert.match(result.gaps[0], /\(declared in affected_files\)$/);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("validateManifestSubagentStage: accepts internal repo-relative navigation in affected_files", () => {
  // Integration: `foo/../bar.md` resolves to `bar.md` within tmpRepo — that's
  // legitimate containment-passing input. Validator should NOT raise a
  // containment gap here. (We still expect downstream gaps if the resolved
  // file is missing — that's a different class — so this test seeds the
  // resolved file to isolate the containment-pass assertion.)
  const tmpRepo = mkdtempSync(join(tmpdir(), "validate-internal-"));
  try {
    writeFileSync(join(tmpRepo, "bar.md"), "no placeholder here\n");
    const manifest = {
      _script_stage: {
        affected_files: [],
        schema_violations: [],
        verification_failures: [],
        semantic_work_pending: [],
      },
      semantic_work_pending: [],
      semantic_edits: {},
      concerns: [],
      affected_files: ["foo/../bar.md"],
      result: "DONE",
    };
    const result = validateManifestSubagentStage({
      manifest,
      repoRoot: tmpRepo,
      ...stageOneFromManifest(manifest),
    });
    assert.equal(
      result.valid,
      true,
      `expected valid=true for internal-navigation path, got gaps: ${JSON.stringify(result.gaps)}`,
    );
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Validator defensive type-checking — element-shape sanitization
//
// Pattern: Array.isArray() gates ARRAY shape but not ELEMENT shape, so a
// tampered manifest with non-string entries in affected_files or
// null/non-object entries in schema_violations would crash the validator
// with TypeError before it could surface the contract violation as a gap.
// The fix routes per-element type mismatches to gap-collection — contract
// violations route through the gap-collection path rather than crashing the
// orchestrator.
// ──────────────────────────────────────────────────────────────────────────

test("validateManifestSubagentStage: returns gap (not crash) when affected_files contains null", () => {
  // Prior code passed `null` to assertRepoRelative → isAbsolute(null) throws
  // TypeError "path must be a string". Defensive guard surfaces the contract
  // violation as a structural-tampering gap and continues iteration.
  const tmpRepo = mkdtempSync(join(tmpdir(), "validate-null-path-"));
  try {
    const manifest = {
      _script_stage: {
        affected_files: [],
        schema_violations: [],
        verification_failures: [],
        semantic_work_pending: [],
      },
      semantic_work_pending: [],
      semantic_edits: {},
      concerns: [],
      affected_files: [null],
      result: "DONE",
    };
    // Pre-fix this threw TypeError; post-fix it returns a gap.
    const result = validateManifestSubagentStage({
      manifest,
      repoRoot: tmpRepo,
      ...stageOneFromManifest(manifest),
    });
    assert.equal(result.valid, false);
    assert.equal(result.gaps.length, 1);
    assert.match(result.gaps[0], /^affected_files\[0\] is not a string \(got null\)/);
    assert.match(result.gaps[0], /subagent contract requires string path entries/);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("validateManifestSubagentStage: returns gap (not crash) when affected_files contains non-string entries", () => {
  // Cover the broader non-string class (number, object) — same TypeError
  // surface in isAbsolute, same gap routing in the validator. Loop continues
  // past each bad entry so multi-entry manifests surface multiple gaps in a
  // single pass (a single bad entry mid-array must not mask later violations).
  const tmpRepo = mkdtempSync(join(tmpdir(), "validate-mixed-path-"));
  try {
    writeFileSync(join(tmpRepo, "good.md"), "no placeholder\n");
    const manifest = {
      _script_stage: {
        affected_files: [],
        schema_violations: [],
        verification_failures: [],
        semantic_work_pending: [],
      },
      semantic_work_pending: [],
      semantic_edits: {},
      concerns: [],
      affected_files: [42, { not: "a string" }, "good.md"],
      result: "DONE",
    };
    const result = validateManifestSubagentStage({
      manifest,
      repoRoot: tmpRepo,
      ...stageOneFromManifest(manifest),
    });
    assert.equal(result.valid, false);
    // Two gaps for the non-string entries; "good.md" path passes containment
    // and no placeholder, so only the type-mismatch gaps surface.
    assert.equal(result.gaps.length, 2);
    assert.match(result.gaps[0], /^affected_files\[0\] is not a string \(got number\)/);
    assert.match(result.gaps[1], /^affected_files\[1\] is not a string \(got object\)/);
    assert.ok(
      result.gaps.every((g) => /subagent contract requires string path entries/.test(g)),
      `expected every gap to cite the contract requirement; got ${JSON.stringify(result.gaps)}`,
    );
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("validateManifestSubagentStage: returns gap (not crash) when manifest.schema_violations contains null", () => {
  // Prior code did `(manifest.schema_violations ?? []).map(violationKey)`,
  // and violationKey did `v.kind ?? ""` — so `null` in the array threw
  // "Cannot read properties of null (reading 'kind')" inside the .map call,
  // crashing the validator before its preservation check could fire. The
  // preservation loop runs only when `_script_stage.schema_violations` is
  // a non-empty array; this test seeds one entry there to exercise the
  // tampered-subagent-array path.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [{ kind: "schema_violation", field: "PRs", ns_id: "NS-02" }],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [
      {
        kind: "schema_violation",
        field: "PRs",
        ns_id: "NS-02",
        addressing: "schema_violation",
        detail: "PRs block missing on NS-02",
      },
    ],
    schema_violations: [null],
    affected_files: [],
    result: "BLOCKED",
  };
  // Pre-fix this threw TypeError; post-fix returns gaps.
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  // Two gaps expected:
  //   1. structural-tampering gap for the null entry
  //   2. preservation gap for the script-stage NS-02 entry that the null
  //      didn't preserve — since the Set is built only from valid entries
  //      and the script-stage NS-02 violation was not in it.
  assert.ok(
    result.gaps.some((g) => /^manifest\.schema_violations\[0\] is not an object/.test(g)),
    `expected element-shape structural-tampering gap; got ${JSON.stringify(result.gaps)}`,
  );
  // Preservation gap fires too — proves the Set still rebuilds from valid
  // entries after the bad-entry skip.
  assert.ok(
    result.gaps.some((g) => g.includes("script-stage schema_violation") && g.includes("NS-02")),
    `expected schema_violations preservation gap to still fire after bad-entry skip; got ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: returns gap (not crash) when manifest.schema_violations contains non-object entries", () => {
  // Cover the broader non-object class (string, number, array). All dereference
  // `v.kind` to throw TypeError (or silently produce undefined for
  // strings/numbers, which would corrupt the preservation Set without
  // crashing). Defensive guard treats every non-plain-object as tampering.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [{ kind: "schema_violation", field: "PRs", ns_id: "NS-02" }],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [
      {
        kind: "schema_violation",
        field: "PRs",
        ns_id: "NS-02",
        addressing: "schema_violation",
        detail: "...",
      },
    ],
    schema_violations: ["not an object", 7, ["nested", "array"]],
    affected_files: [],
    result: "BLOCKED",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  // Three structural-tampering gaps for the three bad entries; one
  // preservation gap for the unpreserved script-stage NS-02 entry.
  const tamperingGaps = result.gaps.filter((g) =>
    /^manifest\.schema_violations\[\d\] is not an object/.test(g),
  );
  assert.equal(
    tamperingGaps.length,
    3,
    `expected 3 tampering gaps; got ${JSON.stringify(result.gaps)}`,
  );
  assert.match(tamperingGaps[0], /\(got string\)/);
  assert.match(tamperingGaps[1], /\(got number\)/);
  assert.match(tamperingGaps[2], /\(got array\)/);
});

// ──────────────────────────────────────────────────────────────────────────
// Class-level container-type + element-shape sanitization
//
// Bug class: `(manifest.X ?? []).method()` patterns at 6 callsites assumed
// every array field was either an array or absent. Two sub-classes:
//   - container-type: subagent emits an OBJECT/scalar where an array is
//     expected; .entries()/.some()/.map() throws "is not a function".
//   - element-shape (non-string-element fields): subagent emits an array
//     but elements are null/scalars; downstream loops dereference fields
//     (.kind/.field/.addressing) and throw TypeError.
//
// Class-level fix consolidates ALL element-shape + container-type gating
// in one block at the top of validateManifestSubagentStage via
// sanitizeObjectArrayField + sanitizeStringArrayField helpers. Every
// downstream consumer iterates the cleaned array; tampering surfaces as
// gaps with idx-keyed locality and a contract-anchored shape hint.
// ──────────────────────────────────────────────────────────────────────────

test("validateManifestSubagentStage: returns gap (not crash) when schema_violations is an object (container-type)", () => {
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    schema_violations: {},
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some((g) => /^manifest\.schema_violations is not an array \(got object\)/.test(g)),
    `expected container-type gap; got ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: returns gap (not crash) when affected_files is an object (container-type)", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "validate-affected-obj-"));
  try {
    const manifest = {
      _script_stage: {
        affected_files: [],
        schema_violations: [],
        verification_failures: [],
        semantic_work_pending: [],
      },
      semantic_work_pending: [],
      semantic_edits: {},
      concerns: [],
      schema_violations: [],
      affected_files: { not: "an array" },
      result: "DONE",
    };
    const result = validateManifestSubagentStage({
      manifest,
      repoRoot: tmpRepo,
      ...stageOneFromManifest(manifest),
    });
    assert.equal(result.valid, false);
    assert.ok(
      result.gaps.some((g) => /^manifest\.affected_files is not an array \(got object\)/.test(g)),
      `expected container-type gap; got ${JSON.stringify(result.gaps)}`,
    );
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("validateManifestSubagentStage: returns gap (not crash) when concerns contains null entry (element-shape)", () => {
  // Pre-fix: `(manifest.concerns ?? []).some(c => c.addressing === item)`
  // dereferenced `null.addressing` and threw TypeError. Post-fix:
  // sanitizeObjectArrayField surfaces a structural-tampering gap per bad
  // entry; the inConcerns lookup runs against the cleaned array. The
  // tampered concerns array must NOT mask the canonical
  // semantic_work_pending reconciliation gap.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: ["compose_status_completion_prose"],
    semantic_edits: {},
    concerns: [null],
    schema_violations: [],
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some((g) => /^manifest\.concerns\[0\] is not an object \(got null\)/.test(g)),
    `expected element-shape gap; got ${JSON.stringify(result.gaps)}`,
  );
  assert.ok(
    result.gaps.some((g) =>
      /^compose_status_completion_prose listed in semantic_work_pending but absent/.test(g),
    ),
    `expected completion-pairing gap to still fire after element-shape skip; got ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: returns gap (not crash) when concerns is a scalar (container-type)", () => {
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: "not an array",
    schema_violations: [],
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some((g) => /^manifest\.concerns is not an array \(got string\)/.test(g)),
    `expected container-type gap; got ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: returns gap (not crash) when verification_failures contains null (element-shape)", () => {
  // Pre-fix: `(manifest.verification_failures ?? []).map(failureKey)` and
  // `JSON.stringify(f, Object.keys(f).sort())` both crash on null.
  // Post-fix: cleaned array filters tampering; verification_failures
  // preservation check still fires on the unpreserved script-stage entry
  // (proves the bad-element skip doesn't mask script-stage preservation
  // enforcement).
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [{ kind: "type_signature_mismatch", colliding_with: "Plan-007" }],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    schema_violations: [],
    affected_files: [],
    verification_failures: [null],
    result: "BLOCKED",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some((g) =>
      /^manifest\.verification_failures\[0\] is not an object \(got null\)/.test(g),
    ),
    `expected element-shape gap; got ${JSON.stringify(result.gaps)}`,
  );
  assert.ok(
    result.gaps.some(
      (g) =>
        g.includes("script-stage verification_failure") && g.includes("type_signature_mismatch"),
    ),
    `expected verification_failures preservation gap to still fire after element-shape skip; got ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: returns gap (not crash) when semantic_work_pending is an object (container-type, missed call-site of object-array bug class on the spread)", () => {
  // Pre-fix: `[...effScriptSemanticWorkPending, ...(manifest.semantic_work_pending ?? [])]`
  // crashes "object is not iterable" when subagent tampers the field with a
  // non-array (`??` only coalesces null/undefined). This is a missed call-site
  // of the same bug class the sanitize helpers already cover for the object-
  // array fields, applied at the spread surface instead of a method call.
  // Post-fix: cleanedSemanticWorkPending sanitizes upstream; the union spread
  // proceeds against the cleaned array; the script-stage snapshot still
  // surfaces unaddressed pending work via the canonical pairing iteration.
  // The second assertion is load-bearing — it proves a tampered live field
  // doesn't mask the preservation contract the validator exists to enforce.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [],
      semantic_work_pending: ["compose_status_completion_prose"],
    },
    semantic_work_pending: { not: "an array" },
    semantic_edits: {},
    concerns: [],
    schema_violations: [],
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some((g) =>
      /^manifest\.semantic_work_pending is not an array \(got object\)/.test(g),
    ),
    `expected container-type gap; got ${JSON.stringify(result.gaps)}`,
  );
  assert.ok(
    result.gaps.some((g) =>
      /^compose_status_completion_prose listed in semantic_work_pending but absent/.test(g),
    ),
    `expected script-stage pending item to still surface as unaddressed after manifest-side sanitize; got ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: returns gap (not crash) when _script_stage.verification_failures contains a null entry (script-side element-shape, missed call-site of object-array bug class)", () => {
  // Pre-fix: the preservation loop iterates `effScriptVerificationFailures`
  // raw and calls `failureKey(vf) = JSON.stringify(vf, Object.keys(vf).sort())`
  // — `Object.keys(null)` throws "Cannot convert undefined or null to object",
  // crashing the validator on a tampered `_script_stage.verification_failures`
  // that contains `[null]` (or scalars/arrays). Container-type guard #12 only
  // verifies the field is an array — element-shape was unguarded.
  // Post-fix: cleanedScriptVerificationFailures sanitizes elements upstream of
  // the preservation loop; null/scalar/array entries surface a structural-
  // tampering gap and are skipped, so the loop body safely dereferences only
  // object entries. Same fix shape as the manifest-side sanitize already in
  // place for the schema_violations / verification_failures / concerns fields.
  const manifest = {
    _script_stage: {
      affected_files: [],
      schema_violations: [],
      verification_failures: [null, { kind: "type_signature_mismatch" }],
      semantic_work_pending: [],
    },
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    schema_violations: [],
    verification_failures: [{ kind: "type_signature_mismatch" }],
    affected_files: [],
    result: "BLOCKED",
  };
  // Pre-fix this would throw; post-fix it returns a gap result.
  const result = validateManifestSubagentStage({ manifest, ...stageOneFromManifest(manifest) });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some((g) =>
      /^manifest\._script_stage\.verification_failures\[0\] is not an object \(got null\)/.test(g),
    ),
    `expected element-shape gap on script-side null entry; got ${JSON.stringify(result.gaps)}`,
  );
  // The well-formed entry MUST still match the subagent-side preservation set
  // (proves the cleaned-array iteration didn't drop legitimate entries).
  assert.ok(
    !result.gaps.some((g) => /script-stage verification_failure/.test(g)),
    `expected well-formed script-stage entry to be preserved by subagent emit; got ${JSON.stringify(result.gaps)}`,
  );
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
