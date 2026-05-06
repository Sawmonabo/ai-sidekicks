import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHousekeeperPrompt,
  validateManifestSubagentStage,
} from "../../lib/housekeeper-orchestrator-helpers.mjs";

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

test("validateManifestSubagentStage: pass when every pending item has semantic_edits or concerns entry", () => {
  const manifest = {
    semantic_work_pending: ["compose_status_completion_prose", "ready_set_re_derivation"],
    semantic_edits: { compose_status_completion_prose: "...", ready_set_re_derivation: "..." },
    concerns: [],
    affected_files: ["docs/architecture/cross-plan-dependencies.md"],
  };
  assert.deepEqual(validateManifestSubagentStage({ manifest }), { valid: true });
});

test("validateManifestSubagentStage: fail when pending item is unaddressed", () => {
  const manifest = {
    semantic_work_pending: ["compose_status_completion_prose", "ready_set_re_derivation"],
    semantic_edits: { compose_status_completion_prose: "..." },
    concerns: [],
    affected_files: [],
  };
  const result = validateManifestSubagentStage({ manifest });
  assert.equal(result.valid, false);
  assert.deepEqual(result.gaps, [
    "ready_set_re_derivation listed in semantic_work_pending but absent from semantic_edits and concerns",
  ]);
});

test("validateManifestSubagentStage: fail when <TODO subagent prose> placeholder still present in any affected file", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "validate-todo-"));
  mkdirSync(join(tmpRepo, "docs/architecture"), { recursive: true });
  writeFileSync(
    join(tmpRepo, "docs/architecture/cross-plan-dependencies.md"),
    "### NS-01: foo\n- Status: `completed` (resolved 2026-05-03 via PR #30 — <TODO subagent prose>)\n",
  );
  const manifest = {
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    affected_files: ["docs/architecture/cross-plan-dependencies.md"],
  };
  const result = validateManifestSubagentStage({ manifest, repoRoot: tmpRepo });
  assert.equal(result.valid, false);
  assert.match(result.gaps[0], /<TODO subagent prose>/);
});

test("validateManifestSubagentStage: fail when <TODO subagent prose> placeholder appears in semantic_edits values (P2 fix)", () => {
  const manifest = {
    semantic_work_pending: ["compose_status_completion_prose"],
    semantic_edits: {
      compose_status_completion_prose: "(resolved 2026-05-03 via PR #30 — <TODO subagent prose>)",
    },
    concerns: [],
    affected_files: [],
  };
  const result = validateManifestSubagentStage({ manifest });
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
    semantic_work_pending: ["line_cite_sweep"],
    semantic_edits: {
      line_cite_sweep: [
        "Updated cite at line 42",
        "Updated cite at line 57 — <TODO subagent prose>",
      ],
    },
    concerns: [],
    affected_files: [],
  };
  const result = validateManifestSubagentStage({ manifest });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some((g) => g.includes("semantic_edits.line_cite_sweep")),
    `expected gap to mention semantic_edits.line_cite_sweep; got: ${JSON.stringify(result.gaps)}`,
  );
});
