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
} from "../../lib/housekeeper-orchestrator-helpers.mjs";
import { emitManifest } from "../post-merge-housekeeper.mjs";

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
    result: "DONE",
  };
  assert.deepEqual(validateManifestSubagentStage({ manifest }), { valid: true });
});

test("validateManifestSubagentStage: fail when pending item is unaddressed", () => {
  const manifest = {
    semantic_work_pending: ["compose_status_completion_prose", "ready_set_re_derivation"],
    semantic_edits: { compose_status_completion_prose: "..." },
    concerns: [],
    affected_files: [],
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest });
  assert.equal(result.valid, false);
  assert.equal(result.gaps.length, 1);
  assert.match(result.gaps[0], /^ready_set_re_derivation listed in semantic_work_pending/);
  // Gap message now hints at the contract requirement (addressing: <item-key>) — Codex P1 fix on PR #33.
  assert.match(result.gaps[0], /addressing: "ready_set_re_derivation"/);
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
      semantic_work_pending: [],
      semantic_edits: {},
      concerns: [],
      affected_files: ["docs/architecture/cross-plan-dependencies.md"],
      result: "DONE",
    };
    const result = validateManifestSubagentStage({ manifest, repoRoot: tmpRepo });
    assert.equal(result.valid, false);
    assert.match(result.gaps[0], /<TODO subagent prose>/);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("validateManifestSubagentStage: fail when <TODO subagent prose> placeholder appears in semantic_edits values (P2 fix)", () => {
  const manifest = {
    semantic_work_pending: ["compose_status_completion_prose"],
    semantic_edits: {
      compose_status_completion_prose: "(resolved 2026-05-03 via PR #30 — <TODO subagent prose>)",
    },
    concerns: [],
    affected_files: [],
    result: "DONE",
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
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest });
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
  const result = validateManifestSubagentStage({ manifest });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some((g) => g.includes("NS-15.type") && !g.includes("NS-15.status")),
    `expected exactly the 'type' violation to gap (status is matched); got: ${JSON.stringify(result.gaps)}`,
  );
});

test("validateManifestSubagentStage: schema_violations pass when each entry has a matching concerns entry by field+ns_id", () => {
  const manifest = {
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
  const result = validateManifestSubagentStage({ manifest });
  assert.equal(result.valid, true);
});

test("validateManifestSubagentStage: schema_violations match by field alone when ns_id is absent (--candidate-ns shape)", () => {
  // Per script line 1394: --candidate-ns mode emits violations without ns_id.
  // Matching falls back to `field` alone in that case.
  const manifest = {
    semantic_work_pending: [],
    semantic_edits: {},
    schema_violations: [{ kind: "schema_violation", field: "summary" }],
    concerns: [{ kind: "schema_violation", field: "summary", detail: "..." }],
    affected_files: [],
    result: "BLOCKED",
  };
  const result = validateManifestSubagentStage({ manifest });
  assert.equal(result.valid, true);
});

test("validateManifestSubagentStage: distinct-kind violations require kind-discriminated concerns (Codex P2 fix on PR #33)", () => {
  // Codex P2 (PR #33 R3): when both sv and a generic concern lack `field`,
  // `c.field !== sv.field` was trivially false (undefined !== undefined),
  // letting one concern absorb every violation. Adding `kind` to the match
  // key prevents distinct-kind violations from sharing a concern.
  const manifest = {
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
  const result = validateManifestSubagentStage({ manifest });
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
    semantic_work_pending: [],
    semantic_edits: {},
    schema_violations: [{ kind: "auto_create_title_seed_underivable" }],
    concerns: [{ kind: "auto_create_title_seed_underivable", detail: "..." }],
    affected_files: [],
    result: "BLOCKED",
  };
  const result = validateManifestSubagentStage({ manifest });
  assert.equal(result.valid, true);
});

test("validateManifestSubagentStage: fieldless-violation gap message uses (kind: ...) label and matchReqs", () => {
  // When sv lacks both ns_id and field, idLabel falls back to `(kind: <kind>)` so the
  // failure message remains identifiable instead of printing `undefined`.
  const manifest = {
    semantic_work_pending: [],
    semantic_edits: {},
    schema_violations: [{ kind: "auto_create_title_seed_underivable" }],
    concerns: [],
    affected_files: [],
    result: "BLOCKED",
  };
  const result = validateManifestSubagentStage({ manifest });
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
  assert.deepEqual(validateManifestSubagentStage({ manifest }), { valid: true });
});

test("validateManifestSubagentStage: NEEDS_CONTEXT result waives per-item pairing for semantic_work_pending", () => {
  // Same waiver as BLOCKED — subagent halted before completing semantic work.
  const manifest = {
    semantic_work_pending: ["compose_status_completion_prose"],
    semantic_edits: {},
    concerns: [{ kind: "needs_input", detail: "ambiguous spec" }],
    affected_files: [],
    result: "NEEDS_CONTEXT",
  };
  assert.deepEqual(validateManifestSubagentStage({ manifest }), { valid: true });
});

test("validateManifestSubagentStage: DONE_WITH_CONCERNS still requires per-item pairing (waiver narrowly scoped to halt-states)", () => {
  // DONE_WITH_CONCERNS means the subagent completed its work (with caveats) — the
  // per-item check still applies. Only BLOCKED/NEEDS_CONTEXT (true halts) waive it.
  const manifest = {
    semantic_work_pending: ["compose_status_completion_prose"],
    semantic_edits: {},
    concerns: [{ kind: "general_observation", detail: "unrelated note" }],
    affected_files: [],
    result: "DONE_WITH_CONCERNS",
  };
  const result = validateManifestSubagentStage({ manifest });
  assert.equal(result.valid, false);
  assert.equal(result.gaps.length, 1);
  assert.match(result.gaps[0], /^compose_status_completion_prose listed in semantic_work_pending/);
});

test("validateManifestSubagentStage: per-item pairing matches by `addressing: <item-key>` exactly (concern.kind is irrelevant)", () => {
  // Per the canonical template (responsibility #5): concerns deferring a pending item set
  // `addressing: <exact-pending-item-key>`. The kind field is the subagent's choice;
  // only `addressing` is the validator's match key.
  const manifest = {
    semantic_work_pending: ["set_quantifier_reverification", "line_cite_sweep"],
    semantic_edits: { line_cite_sweep: "..." },
    concerns: [{ kind: "deferred_for_followup", addressing: "set_quantifier_reverification" }],
    affected_files: [],
    result: "DONE_WITH_CONCERNS",
  };
  assert.deepEqual(validateManifestSubagentStage({ manifest }), { valid: true });
});

// ---------- Codex Finding 7 (PR #33 R4): canonical exit-state enforcement ----------
// The validator MUST reject manifests whose `result` is not one of the four canonical
// exit-states (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED) per Plan Invariant
// I-2. Prior validator behavior: `result === undefined` slipped through silently and
// only `BLOCKED`/`NEEDS_CONTEXT` were ever consulted (for the halt-state waiver),
// breaking deterministic Phase-E routing.

test("validateManifestSubagentStage: fails when result is null (Codex Finding 7)", () => {
  // `result: null` is the script-stage stub shape (per contract §Manifest schema line 62).
  // If the subagent returns this unchanged, the orchestrator can't route Phase E — gap MUST fire.
  const manifest = {
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    affected_files: [],
    result: null,
  };
  const result = validateManifestSubagentStage({ manifest });
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

test("validateManifestSubagentStage: fails when result is an unknown string (Codex Finding 7)", () => {
  // Off-canon literals (typos, hallucinated states, legacy values) MUST gap.
  const manifest = {
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    affected_files: [],
    result: "MAYBE",
  };
  const result = validateManifestSubagentStage({ manifest });
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

test("validateManifestSubagentStage: passes when result is 'DONE' (Codex Finding 7 negative case)", () => {
  // Round-trip a clean DONE manifest — proves the canonical-state check accepts the
  // happy path and doesn't false-fire when the contract is satisfied.
  const manifest = {
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    affected_files: [],
    result: "DONE",
  };
  assert.deepEqual(validateManifestSubagentStage({ manifest }), { valid: true });
});

// ---------- Codex Finding 6 (PR #33 R4): BLOCKED-when-schema-violations enforcement ----------
// Contract clause (`references/post-merge-housekeeper-contract.md` §Validation invariants
// line 93): "Every entry in schema_violations appears in concerns ... AND result === BLOCKED".
// The matcher loop already enforces the SURFACE half; this check enforces the EXIT-STATE half.
// Without it, a subagent could ship `DONE`/`DONE_WITH_CONCERNS` while schema_violations
// is non-empty, bypassing the orchestrator's halt/routing-path determinism in Phase E.

test("validateManifestSubagentStage: fails when schema_violations present but result is 'DONE_WITH_CONCERNS' (Codex Finding 6)", () => {
  // Subagent surfaced the violation in concerns (so the per-entry matcher passes) BUT
  // returned a non-BLOCKED state. The contract requires BOTH conditions; this case MUST gap.
  const manifest = {
    semantic_work_pending: [],
    semantic_edits: {},
    schema_violations: [{ kind: "schema_violation", field: "summary", ns_id: "NS-15" }],
    concerns: [{ kind: "schema_violation", field: "summary", ns_id: "NS-15", detail: "..." }],
    affected_files: [],
    result: "DONE_WITH_CONCERNS",
  };
  const result = validateManifestSubagentStage({ manifest });
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

test("validateManifestSubagentStage: passes when schema_violations present AND result is 'BLOCKED' (Codex Finding 6 negative case)", () => {
  // Both halves of the contract clause satisfied: violations surface in concerns AND
  // result is BLOCKED. The validator returns valid:true (no schema-violation gaps).
  const manifest = {
    semantic_work_pending: [],
    semantic_edits: {},
    schema_violations: [{ kind: "schema_violation", field: "summary", ns_id: "NS-15" }],
    concerns: [{ kind: "schema_violation", field: "summary", ns_id: "NS-15", detail: "..." }],
    affected_files: [],
    result: "BLOCKED",
  };
  assert.deepEqual(validateManifestSubagentStage({ manifest }), { valid: true });
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
    semantic_work_pending: [],
    semantic_edits: {},
    concerns: [],
    affected_files: ["docs/architecture/cross-plan-dependencies.md"], // missing the second file → must FAIL
    result: "DONE",
  };
  const result = validateManifestSubagentStage({ manifest: subagentManifest, scriptAffectedFiles });
  assert.equal(result.valid, false);
  assert.ok(
    result.gaps.some(
      (g) => g.includes("docs/plans/024-rust-pty-sidecar.md") && g.includes("affected_files"),
    ),
    `expected gap to mention the dropped file; got ${JSON.stringify(result.gaps)}`,
  );
});

test("detectAffectedFilesSprawl: edits outside manifest's affected_files trigger DONE_WITH_CONCERNS routing (D-7 row 15)", () => {
  const result = detectAffectedFilesSprawl({
    manifestAffectedFiles: ["docs/architecture/cross-plan-dependencies.md"],
    gitDiffFiles: ["docs/architecture/cross-plan-dependencies.md", "docs/plans/099-mystery.md"],
  });
  assert.equal(result.sprawl, true);
  assert.deepEqual(result.outOfScope, ["docs/plans/099-mystery.md"]);
  assert.equal(result.suggestedRouting, "DONE_WITH_CONCERNS");
  assert.match(result.suggestedConcernKind, /affected_files_extension/);
});

test("I-1 invariant: every cross-plan-dependencies.md NS heading remains extractable by the cite-target hook", () => {
  // The cite-target hook (tools/docs-corpus/bin/pre-commit-runner.ts) parses each ../../ path
  // form and verifies the target file + line range exists. After the housekeeper introduces
  // PRs:-block migrations + NS-23 + auto-create stubs, the hook MUST still pass against the
  // current cross-plan-dependencies.md without "broken cite" errors. This test is a regression
  // canary: if a housekeeper-mutating commit breaks a cite, this assertion catches it.
  let stderr = "";
  try {
    execSync(
      "node --experimental-strip-types tools/docs-corpus/bin/pre-commit-runner.ts docs/architecture/cross-plan-dependencies.md",
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (e) {
    stderr = e.stderr?.toString() ?? e.stdout?.toString() ?? String(e);
  }
  assert.equal(
    stderr,
    "",
    `cite-target hook failed against current catalog — I-1 regression: ${stderr}`,
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
