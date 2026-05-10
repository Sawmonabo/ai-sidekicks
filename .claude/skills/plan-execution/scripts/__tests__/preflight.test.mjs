// node:test suite for preflight.mjs.
// Run via: node --test .claude/skills/plan-execution/scripts/__tests__/preflight.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFrontmatter,
  walkPhases,
  extractPhaseSection,
  countCites,
  extractAuditCheckbox,
  parseFlowMapping,
  parsePreconditionsBlock,
  regexParsePreconditionsLine,
  extractPlanNumber,
  extractAdrStatus,
  extractDeclaredTaskIds,
  shippedTaskIdsForPhase,
  gateProjectLocality,
  gateAuditCheckbox,
  gateTasksBlockCites,
  gatePhaseUnshipped,
  resolvePrecondition,
  setGhImpl,
  resetGhImpl,
  runPreflight,
} from "../preflight.mjs";
import { parseManifestBlock } from "../lib/manifest.mjs";

// ---------- pure parsers ----------

test("parseFrontmatter extracts requires_files list", () => {
  const src = `---
name: foo
requires_files:
  - docs/a.md
  - docs/b.md
---

body`;
  const fm = parseFrontmatter(src);
  assert.deepEqual(fm.requires_files, ["docs/a.md", "docs/b.md"]);
});

test("parseFrontmatter returns empty for missing frontmatter", () => {
  assert.deepEqual(parseFrontmatter("no frontmatter here"), {});
});

test("walkPhases finds all phase headers", () => {
  const plan = `# Plan-001
### Phase 1 — Workspace Bootstrap
content
### Phase 2 — Contracts
more content
### Phase 5 — Client SDK
final`;
  const phases = walkPhases(plan);
  assert.equal(phases.length, 3);
  assert.equal(phases[0].number, 1);
  assert.equal(phases[0].title, "Workspace Bootstrap");
  assert.equal(phases[2].number, 5);
});

test("extractPhaseSection returns the targeted phase only", () => {
  const plan = `### Phase 1 — A
phase 1 body
### Phase 2 — B
phase 2 body`;
  const sec = extractPhaseSection(plan, 1);
  assert.match(sec, /phase 1 body/);
  assert.doesNotMatch(sec, /phase 2 body/);
});

test("extractPhaseSection returns null for missing phase", () => {
  assert.equal(extractPhaseSection("### Phase 1 — A\n", 99), null);
});

test("countCites counts substring occurrences", () => {
  const sec = `Spec coverage: row 1
Spec coverage: row 2
Verifies invariant: I-001-1`;
  const c = countCites(sec);
  assert.equal(c.spec_coverage, 2);
  assert.equal(c.verifies_invariant, 1);
});

test("extractAuditCheckbox detects [x] form", () => {
  assert.equal(extractAuditCheckbox(`- [x] **Plan-readiness audit complete per runbook`), true);
  assert.equal(extractAuditCheckbox(`- [ ] **Plan-readiness audit complete per runbook`), false);
});

test("parseFlowMapping handles {key: value} pairs", () => {
  const m = parseFlowMapping(`- {type: pr_merged, ref: 19}`);
  assert.deepEqual(m, { type: "pr_merged", ref: 19 });
});

test("parseFlowMapping handles quoted strings and floats", () => {
  const m = parseFlowMapping(`- {type: "adr_accepted", ref: 23, weight: 1.5}`);
  assert.deepEqual(m, { type: "adr_accepted", ref: 23, weight: 1.5 });
});

test("parseFlowMapping returns null for non-mapping lines", () => {
  assert.equal(parseFlowMapping("- nothing here"), null);
});

test("parsePreconditionsBlock extracts entries from yaml block", () => {
  const sec = `### Phase 5

\`\`\`yaml
preconditions:
  - {type: pr_merged, ref: 19}
  - {type: adr_accepted, ref: 23}
\`\`\`
`;
  const entries = parsePreconditionsBlock(sec);
  assert.deepEqual(entries, [
    { type: "pr_merged", ref: 19 },
    { type: "adr_accepted", ref: 23 },
  ]);
});

test("parsePreconditionsBlock accepts compact YAML block-sequence form (items at same indent as key)", () => {
  const sec = `### Phase 5

\`\`\`yaml
preconditions:
- {type: pr_merged, ref: 19}
- {type: adr_accepted, ref: 23}
\`\`\`
`;
  const entries = parsePreconditionsBlock(sec);
  assert.deepEqual(entries, [
    { type: "pr_merged", ref: 19 },
    { type: "adr_accepted", ref: 23 },
  ]);
});

test("parsePreconditionsBlock ignores in-list YAML comments at any indent", () => {
  const sec = `### Phase 5

\`\`\`yaml
preconditions:
  # comment between key and first item
  - {type: pr_merged, ref: 19}
  # comment between items at item indent
    # comment indented further
  - {type: adr_accepted, ref: 23}
\`\`\`
`;
  const entries = parsePreconditionsBlock(sec);
  assert.deepEqual(entries, [
    { type: "pr_merged", ref: 19 },
    { type: "adr_accepted", ref: 23 },
  ]);
});

test("parsePreconditionsBlock still exits on real sibling key with trailing comment", () => {
  const sec = `### Phase 5

\`\`\`yaml
preconditions:
  - {type: pr_merged, ref: 19}
sibling: # this is the de-indent
  - other
\`\`\`
`;
  const entries = parsePreconditionsBlock(sec);
  assert.deepEqual(entries, [{ type: "pr_merged", ref: 19 }]);
});

test("parsePreconditionsBlock locks first item's indent — sibling list at parent indent stays excluded", () => {
  const sec = `### Phase 5

\`\`\`yaml
preconditions:
  - {type: pr_merged, ref: 19}
- {type: adr_accepted, ref: 99}
\`\`\`
`;
  const entries = parsePreconditionsBlock(sec);
  assert.deepEqual(entries, [{ type: "pr_merged", ref: 19 }]);
});

test("parsePreconditionsBlock returns null when no yaml block", () => {
  const sec = `### Phase 5\n\nno yaml here`;
  assert.equal(parsePreconditionsBlock(sec), null);
});

test("parsePreconditionsBlock accepts ```yml as alias for ```yaml", () => {
  const sec = `### Phase 5

\`\`\`yml
preconditions:
  - {type: pr_merged, ref: 19}
\`\`\`
`;
  const entries = parsePreconditionsBlock(sec);
  assert.deepEqual(entries, [{ type: "pr_merged", ref: 19 }]);
});

test("parsePreconditionsBlock parses indented preconditions key under a parent map", () => {
  const sec = `### Phase 5

\`\`\`yaml
phase:
  preconditions:
    - {type: pr_merged, ref: 19}
\`\`\`
`;
  const entries = parsePreconditionsBlock(sec);
  assert.deepEqual(entries, [{ type: "pr_merged", ref: 19 }]);
});

test("parsePreconditionsBlock stops at sibling key on de-indent", () => {
  const sec = `### Phase 5

\`\`\`yaml
preconditions:
  - {type: pr_merged, ref: 19}
sibling:
  - {type: adr_accepted, ref: 99}
\`\`\`
`;
  const entries = parsePreconditionsBlock(sec);
  assert.deepEqual(entries, [{ type: "pr_merged", ref: 19 }]);
});

test("parsePreconditionsBlock returns [] for empty preconditions list", () => {
  const sec = `### Phase 5

\`\`\`yaml
preconditions: []
\`\`\`
`;
  // Inline empty list is rejected by design — not a block-mode entry.
  assert.deepEqual(parsePreconditionsBlock(sec), []);
});

test("parsePreconditionsBlock accepts trailing YAML comment after preconditions key", () => {
  const sec = `### Phase 5

\`\`\`yaml
preconditions: # gated by ADR-023
  - {type: pr_merged, ref: 19}
\`\`\`
`;
  const entries = parsePreconditionsBlock(sec);
  assert.deepEqual(entries, [{ type: "pr_merged", ref: 19 }]);
});

test("parsePreconditionsBlock does NOT enter block on inline scalar value", () => {
  const sec = `### Phase 5

\`\`\`yaml
preconditions: foo
- {type: pr_merged, ref: 19}
\`\`\`
`;
  // Inline scalar is rejected — block mode never enters; subsequent items not absorbed.
  assert.deepEqual(parsePreconditionsBlock(sec), []);
});

test("regexParsePreconditionsLine extracts patterns", () => {
  const line = `PR #19 merged; ADR-023 accepted; Plan-007 Phase 3 merged.`;
  assert.deepEqual(regexParsePreconditionsLine(line), [
    { type: "pr_merged", ref: 19 },
    { type: "adr_accepted", ref: 23 },
    { type: "plan_phase", plan: 7, phase: 3, status: "merged" },
  ]);
});

test("extractPlanNumber pulls leading number from filename", () => {
  assert.equal(extractPlanNumber("/abs/docs/plans/001-shared-session-core.md"), 1);
  assert.equal(extractPlanNumber("007-foo.md"), 7);
});

test("extractAdrStatus parses table form", () => {
  assert.equal(extractAdrStatus("| **Status** | accepted |"), "accepted");
  assert.equal(extractAdrStatus("| **Status** | `accepted` |"), "accepted");
});

test("extractAdrStatus parses bold-field form", () => {
  assert.equal(extractAdrStatus("**Status:** proposed"), "proposed");
});

// ---------- declared-task / manifest-task helpers ----------

test("extractDeclaredTaskIds picks up sub-header form (T1.1, T5.6)", () => {
  const sec = `### Phase 1
#### Tasks

##### T1.1 — Workspace root
some content
##### T1.2 — Per-package skeletons
more
##### T1.6 — Sanity test
end
`;
  assert.deepEqual(extractDeclaredTaskIds(sec), ["T1.1", "T1.2", "T1.6"]);
});

test("extractDeclaredTaskIds picks up bullet+bold form (T-007p-1-1)", () => {
  const sec = `### Phase 1
#### Tasks

- **T-007p-1-1** (Files: foo.ts) — Implement X
- **T-007p-1-2** (Files: bar.ts) — Implement Y
- **T-007p-1-4** (Files: baz.ts) — Tests
`;
  assert.deepEqual(extractDeclaredTaskIds(sec), ["T-007p-1-1", "T-007p-1-2", "T-007p-1-4"]);
});

test("extractDeclaredTaskIds returns [] when no tasks block", () => {
  const sec = `### Phase 1\n\nno tasks here\n`;
  assert.deepEqual(extractDeclaredTaskIds(sec), []);
});

test("extractDeclaredTaskIds dedupes and sorts", () => {
  const sec = `### Phase 1
#### Tasks

##### T1.2 — second
##### T1.1 — first
- **T1.2** (duplicate from bullet form)
`;
  assert.deepEqual(extractDeclaredTaskIds(sec), ["T1.1", "T1.2"]);
});

test("shippedTaskIdsForPhase extracts string + array task forms for given phase", () => {
  const planSrc = `# Plan-001
## Progress Log
### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 1
    task: [T1.1, T1.2, T1.3]
    pr: 6
    sha: ca22530
    merged_at: 2026-04-27
    files: []
    verifies_invariant: []
    spec_coverage: []
  - phase: 5
    task: T5.1
    pr: 30
    sha: 7e4ae47
    merged_at: 2026-05-06
    files: []
    verifies_invariant: []
    spec_coverage: []
\`\`\`

### Notes
`;
  const manifest = parseManifestBlock(planSrc);
  assert.equal(manifest.ok, true);
  assert.deepEqual([...shippedTaskIdsForPhase(manifest, 1)].sort(), ["T1.1", "T1.2", "T1.3"]);
  assert.deepEqual([...shippedTaskIdsForPhase(manifest, 5)], ["T5.1"]);
  assert.deepEqual([...shippedTaskIdsForPhase(manifest, 99)], []);
});

test("shippedTaskIdsForPhase returns empty Set for unparseable manifest", () => {
  assert.deepEqual([...shippedTaskIdsForPhase({ ok: false }, 1)], []);
  assert.deepEqual([...shippedTaskIdsForPhase(null, 1)], []);
});

// ---------- gates with temp filesystem ----------

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "preflight-test-"));
  mkdirSync(join(dir, "docs", "plans"), { recursive: true });
  mkdirSync(join(dir, "docs", "decisions"), { recursive: true });
  mkdirSync(join(dir, "docs", "architecture"), { recursive: true });
  mkdirSync(join(dir, "docs", "operations"), { recursive: true });
  mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
  mkdirSync(join(dir, ".claude", "skills", "plan-execution", "scripts"), { recursive: true });
  return dir;
}

test("gateProjectLocality passes when all required files exist", () => {
  const repo = makeTempRepo();
  const skillMd = join(repo, "SKILL.md");
  writeFileSync(
    skillMd,
    `---
name: test
requires_files:
  - .claude/rules/coding-standards.md
---

body`,
  );
  writeFileSync(join(repo, ".claude", "rules", "coding-standards.md"), "# rules");
  const r = gateProjectLocality({ repoRoot: repo, skillMd });
  assert.equal(r.ok, true);
});

test("gateProjectLocality fails when required file missing", () => {
  const repo = makeTempRepo();
  const skillMd = join(repo, "SKILL.md");
  writeFileSync(
    skillMd,
    `---
name: test
requires_files:
  - docs/missing.md
---

body`,
  );
  const r = gateProjectLocality({ repoRoot: repo, skillMd });
  assert.equal(r.ok, false);
  assert.match(r.halt, /docs\/missing\.md/);
});

test("gateAuditCheckbox passes on [x]", () => {
  const r = gateAuditCheckbox(`- [x] **Plan-readiness audit complete`, "/p.md");
  assert.equal(r.ok, true);
});

test("gateAuditCheckbox fails on [ ]", () => {
  const r = gateAuditCheckbox(`- [ ] **Plan-readiness audit complete`, "/p.md");
  assert.equal(r.ok, false);
});

test("gateTasksBlockCites passes when both ≥1", () => {
  const sec = `Spec coverage: row 4
Verifies invariant: I-001-1`;
  const r = gateTasksBlockCites(sec, 1, 5);
  assert.equal(r.ok, true);
});

test("gateTasksBlockCites fails when either zero", () => {
  const sec = `Spec coverage: row 4`;
  const r = gateTasksBlockCites(sec, 1, 5);
  assert.equal(r.ok, false);
  assert.match(r.halt, /missing G4 cites/);
});

// ---------- Gate 3 (manifest-based phase un-shipped) ----------

const manifestPlan = ({ tasksBlock, manifestEntries }) => `# Plan-001

## Preconditions

- [x] **Plan-readiness audit complete per runbook.

### Phase 1 — Workspace Bootstrap

\`\`\`yaml
preconditions: []
\`\`\`

#### Tasks

${tasksBlock}

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
${manifestEntries}
\`\`\`

### Notes
`;

test("gatePhaseUnshipped passes when no tasks declared (defer to other gates)", () => {
  const planSrc = manifestPlan({ tasksBlock: "(no tasks here)", manifestEntries: "" });
  const r = gatePhaseUnshipped(planSrc, 1, { number: 1, title: "Workspace Bootstrap" });
  assert.equal(r.ok, true);
});

test("gatePhaseUnshipped passes when manifest has no entry for phase", () => {
  const planSrc = manifestPlan({
    tasksBlock: `##### T1.1 — A\n##### T1.2 — B`,
    manifestEntries: "",
  });
  const r = gatePhaseUnshipped(planSrc, 1, { number: 1, title: "Workspace Bootstrap" });
  assert.equal(r.ok, true);
});

test("gatePhaseUnshipped fails when all declared tasks appear in manifest (string + array forms)", () => {
  const planSrc = manifestPlan({
    tasksBlock: `##### T1.1 — A\n##### T1.2 — B`,
    manifestEntries: `  - phase: 1
    task: [T1.1, T1.2]
    pr: 6
    sha: abc1234
    merged_at: 2026-04-27
    files: []
    verifies_invariant: []
    spec_coverage: []`,
  });
  const r = gatePhaseUnshipped(planSrc, 1, { number: 1, title: "Workspace Bootstrap" });
  assert.equal(r.ok, false, "all declared tasks shipped — gate must halt");
  assert.match(r.halt, /already shipped/);
  assert.match(r.halt, /T1\.1, T1\.2/);
});

test("gatePhaseUnshipped passes on partial-ship (NS-02 lane carve-out)", () => {
  // Plan-001 Phase 5 declares T5.1 + T5.5 + T5.6 but PR #30 only shipped T5.1.
  // Gate 3 must NOT halt — T5.5/T5.6 are still pending.
  const planSrc = `# Plan-001

## Preconditions

- [x] **Plan-readiness audit complete per runbook.

### Phase 5 — Client SDK And Desktop Bootstrap

#### Tasks

##### T5.1 — sessionClient
##### T5.5 — pg.Pool Querier
##### T5.6 — Lock-ordering test

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 5
    task: T5.1
    pr: 30
    sha: 7e4ae47
    merged_at: 2026-05-06
    files: []
    verifies_invariant: []
    spec_coverage: []
\`\`\`

### Notes
`;
  const r = gatePhaseUnshipped(planSrc, 1, {
    number: 5,
    title: "Client SDK And Desktop Bootstrap",
  });
  assert.equal(r.ok, true, "partial-ship leaves T5.5/T5.6 declared but un-shipped");
});

test("gatePhaseUnshipped halts when manifest section absent (no_section)", () => {
  // Codex P1 finding on PR #35 round 7: pre-fix this returned ok:true,
  // silently re-opening Gate 3 and re-dispatching already-shipped phases on
  // any manifest formatting error. Strict halt is the only safe behavior;
  // schema-version-future is the only intentional fail-open.
  const planSrc = `# Plan-001

### Phase 1 — Bootstrap

#### Tasks

##### T1.1 — A
`;
  const r = gatePhaseUnshipped(planSrc, 1, { number: 1, title: "Bootstrap" });
  assert.equal(r.ok, false);
  assert.match(r.halt, /shipment manifest unparseable/);
  assert.match(r.halt, /no_section/);
});

test("gatePhaseUnshipped halts when manifest section exists but YAML fence missing (no_yaml_fence)", () => {
  // Distinct parse-failure path from no_section: section heading present but
  // the ```yaml fenced block is missing or truncated. Same halt contract.
  const planSrc = `# Plan-001

### Phase 1 — Bootstrap

#### Tasks

##### T1.1 — A

## Progress Log

### Shipment Manifest

(prose-only — no fence)

### Notes
`;
  const r = gatePhaseUnshipped(planSrc, 1, { number: 1, title: "Bootstrap" });
  assert.equal(r.ok, false);
  assert.match(r.halt, /shipment manifest unparseable/);
  assert.match(r.halt, /no_yaml_fence/);
});

test("gatePhaseUnshipped halts when shipped[] entry has phase as string (manifest_invalid_entries)", () => {
  // Codex P2 finding on PR #35 round 8: pre-fix the classifier read entry
  // fields directly without schema-validating, so `phase: "5"` (string) would
  // silently miss `e.phase === phaseNumber` (number) and re-open Gate 3 even
  // though the entry was structurally present.
  const planSrc = `# Plan-001

### Phase 1 — Bootstrap

#### Tasks

##### T1.1 — A

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: "1"
    task: T1.1
    pr: 6
    sha: abc1234
    merged_at: 2026-04-27
    files: []
    verifies_invariant: []
    spec_coverage: []
\`\`\`

### Notes
`;
  const r = gatePhaseUnshipped(planSrc, 1, { number: 1, title: "Bootstrap" });
  assert.equal(r.ok, false);
  assert.match(r.halt, /entries fail schema validation/);
  assert.match(r.halt, /shipped\[0\]/);
  assert.match(r.halt, /phase must be a positive integer/);
});

test("gatePhaseUnshipped halts when shipped[] entry missing required task field", () => {
  // Second flavor of round-8 P2: missing required field instead of type mismatch.
  // Same halt path, different validateEntry error.
  const planSrc = `# Plan-001

### Phase 1 — Bootstrap

#### Tasks

##### T1.1 — A

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 1
    pr: 6
    sha: abc1234
    merged_at: 2026-04-27
    files: []
\`\`\`

### Notes
`;
  const r = gatePhaseUnshipped(planSrc, 1, { number: 1, title: "Bootstrap" });
  assert.equal(r.ok, false);
  assert.match(r.halt, /entries fail schema validation/);
  assert.match(r.halt, /missing required field: task/);
});

test("gatePhaseUnshipped halts when manifest YAML missing schema_version (missing_schema_version)", () => {
  // Distinct parse-failure path from no_yaml_fence: fence parsed, but the
  // top-level manifest_schema_version key is absent. Same halt contract.
  const planSrc = `# Plan-001

### Phase 1 — Bootstrap

#### Tasks

##### T1.1 — A

## Progress Log

### Shipment Manifest

\`\`\`yaml
shipped: []
\`\`\`

### Notes
`;
  const r = gatePhaseUnshipped(planSrc, 1, { number: 1, title: "Bootstrap" });
  assert.equal(r.ok, false);
  assert.match(r.halt, /shipment manifest unparseable/);
  assert.match(r.halt, /missing_schema_version/);
});

test("gatePhaseUnshipped halts when manifest YAML missing shipped key (missing_shipped)", () => {
  // Codex P1 finding on PR #35 round 10: parser used to fail-open when
  // only the schema-version line was present. The missing-shipped reason
  // now routes through the same manifest_unparseable halt kind so the
  // halt-text reasons-list documentation matches reality.
  const planSrc = `# Plan-001

### Phase 1 — Bootstrap

#### Tasks

##### T1.1 — A

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
\`\`\`

### Notes
`;
  const r = gatePhaseUnshipped(planSrc, 1, { number: 1, title: "Bootstrap" });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "manifest_unparseable");
  assert.match(r.halt, /shipment manifest unparseable/);
  assert.match(r.halt, /missing_shipped/);
});

test("gatePhaseUnshipped fails-open on unknown future schema versions", () => {
  // Per lib/manifest.mjs schema-version policy: unknown future versions are
  // returned ok with the parsed entries; preflight Gate 3 treats them as
  // opaque so a partial migration to schema v2 doesn't block dispatch.
  const planSrc = `# Plan-001

### Phase 1 — Bootstrap

#### Tasks

##### T1.1 — A

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 999
shipped:
  - phase: 1
    task: T1.1
    pr: 6
    sha: abc1234
    merged_at: 2026-04-27
    files: []
    verifies_invariant: []
    spec_coverage: []
\`\`\`

### Notes
`;
  const r = gatePhaseUnshipped(planSrc, 1, { number: 1, title: "Bootstrap" });
  assert.equal(r.ok, true, "unknown future schema versions must fail open");
});

// ---------- Gate 5 (preconditions) ----------

test("resolvePrecondition handles pr_merged via stub", () => {
  setGhImpl(() => '{"state":"MERGED"}');
  try {
    const r = resolvePrecondition({ type: "pr_merged", ref: 19 });
    assert.equal(r.ok, true);
  } finally {
    resetGhImpl();
  }
});

test("resolvePrecondition fails pr_merged when state is OPEN", () => {
  setGhImpl(() => '{"state":"OPEN"}');
  try {
    const r = resolvePrecondition({ type: "pr_merged", ref: 19 });
    assert.equal(r.ok, false);
    assert.match(r.halt, /state=OPEN/);
  } finally {
    resetGhImpl();
  }
});

test("resolvePrecondition handles adr_accepted", () => {
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "decisions", "023-foo.md"),
    `| Field | Value |
| **Status** | accepted |`,
  );
  const r = resolvePrecondition({ type: "adr_accepted", ref: 23 }, { repoRoot: repo });
  assert.equal(r.ok, true);
});

test("resolvePrecondition fails adr_accepted when status is proposed", () => {
  const repo = makeTempRepo();
  writeFileSync(join(repo, "docs", "decisions", "023-foo.md"), `| **Status** | proposed |`);
  const r = resolvePrecondition({ type: "adr_accepted", ref: 23 }, { repoRoot: repo });
  assert.equal(r.ok, false);
  assert.match(r.halt, /Status=proposed/);
});

test("resolvePrecondition plan_phase satisfies when every declared upstream task is shipped (full-ship)", () => {
  // Post-round-7 the resolver does Gate-3-style set-comparison (declared ⊆
  // shipped). Plan-007 PR #19's array-form manifest entry covers all three
  // declared tasks for Phase 3 → precondition satisfied.
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "plans", "007-test.md"),
    `# Plan-007

### Phase 3 — Daemon driver registry

#### Tasks

##### T-007p-3-1 — Driver registry skeleton
##### T-007p-3-2 — Driver lifecycle hooks
##### T-007p-3-4 — Driver crash isolation

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 3
    task: [T-007p-3-1, T-007p-3-2, T-007p-3-4]
    pr: 19
    sha: 0e5599d
    merged_at: 2026-04-30
    files: []
    verifies_invariant: []
    spec_coverage: []
\`\`\`

### Notes
`,
  );
  const r = resolvePrecondition(
    { type: "plan_phase", plan: 7, phase: 3, status: "merged" },
    { repoRoot: repo },
  );
  assert.equal(r.ok, true);
});

test("resolvePrecondition plan_phase halts on partial-ship false-positive (NS-02 task-set comparison)", () => {
  // Codex P2 finding on PR #35 round 7: pre-fix, any phase entry satisfied
  // the precondition (`some(e.phase === entry.phase)`), so Plan-001's T5.1
  // Lane A entry would unblock a downstream Plan-001 Phase 5 dependency
  // even though T5.5/T5.6 were unshipped. This is the exact NS-02 partial-
  // ship trap the manifest refactor exists to close at the upstream tier.
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "plans", "001-test.md"),
    `# Plan-001

### Phase 5 — Client SDK + Desktop Bootstrap

#### Tasks

##### T5.1 — sessionClient transports (Lane A)
##### T5.5 — Desktop shell IPC
##### T5.6 — Renderer wiring

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 5
    task: T5.1
    pr: 30
    sha: 7e4ae47
    merged_at: 2026-05-05
    files: []
    verifies_invariant: []
    spec_coverage: []
\`\`\`

### Notes
`,
  );
  const r = resolvePrecondition(
    { type: "plan_phase", plan: 1, phase: 5, status: "merged" },
    { repoRoot: repo },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /partially shipped/);
  assert.match(r.halt, /T5\.5/);
  assert.match(r.halt, /T5\.6/);
});

test("resolvePrecondition plan_phase falls back to phase-presence when upstream Tasks block has no declared task ids", () => {
  // Legacy fallback: plans that shipped before the audit runbook formalized
  // task ids in `#### Tasks` blocks have no declared set to compare. The
  // resolver mirrors the pre-refactor `some(e.phase === entry.phase)`
  // behavior so those plans don't fail-loud after the strict refactor.
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "plans", "007-test.md"),
    `# Plan-007

### Phase 3 — Legacy phase without declared task ids

prose-only Tasks block.

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 3
    task: T-007-3-1
    pr: 19
    sha: 0e5599d
    merged_at: 2026-04-30
    files: []
    verifies_invariant: []
    spec_coverage: []
\`\`\`

### Notes
`,
  );
  const r = resolvePrecondition(
    { type: "plan_phase", plan: 7, phase: 3, status: "merged" },
    { repoRoot: repo },
  );
  assert.equal(r.ok, true);
});

test("resolvePrecondition plan_phase halts when target plan has no manifest entry for phase", () => {
  // Same fallback path as the prior test (no declared task ids), but with
  // the manifest's `shipped:` empty so phase-presence also fails.
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "plans", "007-test.md"),
    `# Plan-007

### Phase 3 — Legacy phase without declared task ids

prose-only Tasks block.

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped: []
\`\`\`

### Notes
`,
  );
  const r = resolvePrecondition(
    { type: "plan_phase", plan: 7, phase: 3, status: "merged" },
    { repoRoot: repo },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /no entry in shipment manifest/);
});

test("resolvePrecondition plan_phase halts when upstream manifest has invalid entries", () => {
  // Mirror of Gate 3's manifest_invalid_entries halt at the upstream tier
  // (Codex P2 finding on PR #35 round 8). An upstream plan with type-mismatched
  // shipped[] entries cannot be set-compared; resolver halts loudly rather
  // than silently misclassifying ship status.
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "plans", "007-test.md"),
    `# Plan-007

### Phase 3 — Daemon driver registry

#### Tasks

##### T-007p-3-1 — Driver registry skeleton

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: "3"
    task: T-007p-3-1
    pr: 19
    sha: 0e5599d
    merged_at: 2026-04-30
    files: []
\`\`\`

### Notes
`,
  );
  const r = resolvePrecondition(
    { type: "plan_phase", plan: 7, phase: 3, status: "merged" },
    { repoRoot: repo },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /entries that fail validateEntry/);
  assert.match(r.halt, /phase must be a positive integer/);
});

test("resolvePrecondition plan_phase halts when upstream manifest unparseable", () => {
  // Mirror of Gate 3's strict halt on parse failure (Codex P1 finding on PR
  // #35 round 7). An upstream plan with a malformed manifest cannot be
  // determined as shipped or unshipped — the resolver halts rather than
  // silently satisfying or rejecting the precondition.
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "plans", "007-test.md"),
    `# Plan-007

### Phase 3 — Daemon driver registry

#### Tasks

##### T-007p-3-1 — Driver registry skeleton
`,
  );
  const r = resolvePrecondition(
    { type: "plan_phase", plan: 7, phase: 3, status: "merged" },
    { repoRoot: repo },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /shipment manifest unparseable/);
  assert.match(r.halt, /no_section/);
});

test("resolvePrecondition plan_phase fails when target plan absent", () => {
  const repo = makeTempRepo();
  const r = resolvePrecondition(
    { type: "plan_phase", plan: 99, phase: 1, status: "merged" },
    { repoRoot: repo },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /Plan-99 not found/);
});

test("resolvePrecondition plan_phase fails open on unknown future manifest schema version", () => {
  // Codex P2 finding on PR #35 round 2: Gate 5 plan_phase resolver MUST mirror
  // Gate 3's schema-version fail-open. Otherwise an upstream plan migrated to
  // a future schema (manifest_schema_version: 2+) would block downstream
  // dispatch with a false negative even when the upstream phase is shipped.
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "plans", "007-test.md"),
    `# Plan-007

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 99
shipped: []
\`\`\`

### Notes
`,
  );
  const r = resolvePrecondition(
    { type: "plan_phase", plan: 7, phase: 3, status: "merged" },
    { repoRoot: repo },
  );
  assert.equal(r.ok, true);
});

// ---------- runPreflight integration ----------

function buildTestRepo({ phases, manifestEntries = "shipped: []" }) {
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(skillMd, `---\nname: test\nrequires_files: []\n---\n\nbody`);
  const planFile = join(repo, "docs", "plans", "001-test.md");
  const phaseSections = phases
    .map(
      ({ n, title, tasks }) => `### Phase ${n} — ${title}

**Precondition:** None.

\`\`\`yaml
preconditions: []
\`\`\`

#### Tasks

${tasks
  .map(
    (t) => `##### ${t} — desc
**Spec coverage:** Spec-001 row ${n} **Verifies invariant:** I-001-${n}`,
  )
  .join("\n")}
`,
    )
    .join("\n");
  writeFileSync(
    planFile,
    `# Plan-001

## Preconditions

- [x] **Plan-readiness audit complete per runbook.

${phaseSections}

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
${manifestEntries}
\`\`\`

### Notes
`,
  );
  return { repo, skillMd, planFile };
}

test("runPreflight selects first eligible un-shipped phase (no manifest entries)", () => {
  const { repo, skillMd, planFile } = buildTestRepo({
    phases: [{ n: 1, title: "Bootstrap", tasks: ["T1.1"] }],
  });
  const r = runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
  assert.equal(r.exit, 0, `exit was ${r.exit}; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.equal(r.stdout, "1");
});

test("runPreflight halts on unchecked audit checkbox", () => {
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(skillMd, `---\nname: test\nrequires_files: []\n---`);
  const planFile = join(repo, "docs", "plans", "001-test.md");
  writeFileSync(
    planFile,
    `# Plan-001

- [ ] **Plan-readiness audit complete

### Phase 1 — Bootstrap
`,
  );
  const r = runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
  assert.equal(r.exit, 1);
  assert.match(r.stdout, /audit-complete checkbox unchecked/);
});

test("runPreflight halts when phase given but missing G4 cites", () => {
  // Manifest section is required even when the test only exercises the
  // cite gate — Gate 3's strict halt on parse failure (Codex P1 round-7)
  // fires before Gate 4 if the section is absent.
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(skillMd, `---\nname: test\nrequires_files: []\n---`);
  const planFile = join(repo, "docs", "plans", "001-test.md");
  writeFileSync(
    planFile,
    `# Plan-001

- [x] **Plan-readiness audit complete

### Phase 1 — Bootstrap

(no cites here)

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped: []
\`\`\`

### Notes
`,
  );
  const r = runPreflight(planFile, 1, { repoRoot: repo, skillMd });
  assert.equal(r.exit, 1);
  assert.match(r.stdout, /missing G4 cites/);
});

test("runPreflight skips fully-shipped phases and resolves to next un-shipped", () => {
  // Phases 1-4 fully shipped via manifest; Phase 5 partial-shipped (T5.1 only,
  // T5.5/T5.6 declared but un-shipped). Auto-resolver picks Phase 5.
  const { repo, skillMd, planFile } = buildTestRepo({
    phases: [
      { n: 1, title: "Workspace Bootstrap", tasks: ["T1.1"] },
      { n: 2, title: "Contracts", tasks: ["T2.1"] },
      { n: 3, title: "Daemon Migration", tasks: ["T3.1"] },
      { n: 4, title: "Control Plane", tasks: ["T4.1"] },
      { n: 5, title: "Client SDK", tasks: ["T5.1", "T5.5", "T5.6"] },
    ],
    manifestEntries: `shipped:
  - phase: 1
    task: T1.1
    pr: 6
    sha: ca22530
    merged_at: 2026-04-27
    files: []
    verifies_invariant: []
    spec_coverage: []
  - phase: 2
    task: T2.1
    pr: 8
    sha: 6166fa9
    merged_at: 2026-04-27
    files: []
    verifies_invariant: []
    spec_coverage: []
  - phase: 3
    task: T3.1
    pr: 9
    sha: 93f1e35
    merged_at: 2026-04-27
    files: []
    verifies_invariant: []
    spec_coverage: []
  - phase: 4
    task: T4.1
    pr: 10
    sha: c723b18
    merged_at: 2026-04-27
    files: []
    verifies_invariant: []
    spec_coverage: []
  - phase: 5
    task: T5.1
    pr: 30
    sha: 7e4ae47
    merged_at: 2026-05-06
    files: []
    verifies_invariant: []
    spec_coverage: []`,
  });
  const r = runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
  assert.equal(r.exit, 0, `exit was ${r.exit}; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.equal(r.stdout, "5", "Phases 1-4 fully shipped; Phase 5 partial — resolver picks 5");
});

test("runPreflight halts when explicit-phase override targets a fully-shipped phase", () => {
  const { repo, skillMd, planFile } = buildTestRepo({
    phases: [{ n: 1, title: "Bootstrap", tasks: ["T1.1"] }],
    manifestEntries: `shipped:
  - phase: 1
    task: T1.1
    pr: 6
    sha: ca22530
    merged_at: 2026-04-27
    files: []
    verifies_invariant: []
    spec_coverage: []`,
  });
  const r = runPreflight(planFile, 1, { repoRoot: repo, skillMd });
  assert.equal(r.exit, 1);
  assert.match(r.stdout, /already shipped/);
});

test("runPreflight returns no-eligible-phase halt when every phase is shipped", () => {
  const { repo, skillMd, planFile } = buildTestRepo({
    phases: [{ n: 1, title: "Bootstrap", tasks: ["T1.1"] }],
    manifestEntries: `shipped:
  - phase: 1
    task: T1.1
    pr: 6
    sha: ca22530
    merged_at: 2026-04-27
    files: []
    verifies_invariant: []
    spec_coverage: []`,
  });
  const r = runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
  assert.equal(r.exit, 1);
  assert.match(r.stdout, /no eligible un-shipped phase/);
});

test("runPreflight halts loudly in auto-walk mode when manifest is unparseable", () => {
  // Codex P1 finding on PR #35 round 9 — pre-fix `_checkPhase` collapsed
  // every Gate 3 failure (including round-7 strict halts) to `reason:
  // "shipped"`, so auto-walk silenced manifest-unparseable phases and fell
  // through to "no eligible un-shipped phase" instead of surfacing the halt.
  // This test plan has TWO phases with no `### Shipment Manifest` section;
  // under the old behavior every phase would silent-skip and the loop would
  // emit the terminal "no eligible" message. The strict-halt text below only
  // appears on the per-phase fail-loud path.
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(skillMd, `---\nname: test\nrequires_files: []\n---\n\nbody`);
  const planFile = join(repo, "docs", "plans", "001-test.md");
  writeFileSync(
    planFile,
    `# Plan-001

## Preconditions

- [x] **Plan-readiness audit complete per runbook.

### Phase 1 — Bootstrap

**Precondition:** None.

\`\`\`yaml
preconditions: []
\`\`\`

#### Tasks

##### T1.1 — desc
**Spec coverage:** Spec-001 row 1 **Verifies invariant:** I-001-1

### Phase 2 — Next

**Precondition:** None.

\`\`\`yaml
preconditions: []
\`\`\`

#### Tasks

##### T2.1 — desc
**Spec coverage:** Spec-001 row 2 **Verifies invariant:** I-001-2
`,
  );
  const r = runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
  assert.equal(r.exit, 1);
  assert.match(r.stdout, /shipment manifest unparseable/);
  assert.doesNotMatch(r.stdout, /no eligible un-shipped phase/);
});

test("runPreflight halts loudly in auto-walk mode when shipped[] entries fail validation", () => {
  // Same Codex P1 round-9 surface, manifest_invalid_entries side. Manifest
  // YAML parses but the single entry has phase as string ("1") — round-8's
  // validateEntry classifier kind. Pre-fix this would silent-skip both
  // phases and emit "no eligible un-shipped phase"; new behavior halts
  // immediately on the first phase with the schema-validation halt text.
  const { repo, skillMd, planFile } = buildTestRepo({
    phases: [
      { n: 1, title: "Bootstrap", tasks: ["T1.1"] },
      { n: 2, title: "Next", tasks: ["T2.1"] },
    ],
    manifestEntries: `shipped:
  - phase: "1"
    task: T1.1
    pr: 6
    sha: ca22530
    merged_at: 2026-04-27
    files: []
    verifies_invariant: []
    spec_coverage: []`,
  });
  const r = runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
  assert.equal(r.exit, 1);
  assert.match(r.stdout, /entries fail schema validation/);
  assert.doesNotMatch(r.stdout, /no eligible un-shipped phase/);
});
