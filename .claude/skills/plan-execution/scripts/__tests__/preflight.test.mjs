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
  findProgressLogPhaseEntry,
  gateProjectLocality,
  gateAuditCheckbox,
  gateTasksBlockCites,
  gatePhaseUnshipped,
  resolvePrecondition,
  setGhImpl,
  resetGhImpl,
  runPreflight,
} from "../preflight.mjs";

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
  const sec = `Spec coverage: row 4
Spec coverage: row 5
Verifies invariant: I-001-1`;
  const c = countCites(sec);
  assert.equal(c.spec_coverage, 2);
  assert.equal(c.verifies_invariant, 1);
});

test("extractAuditCheckbox detects [x] form", () => {
  assert.equal(extractAuditCheckbox(`- [x] **Plan-readiness audit complete per ...`), true);
  assert.equal(extractAuditCheckbox(`- [ ] **Plan-readiness audit complete per ...`), false);
});

test("parseFlowMapping handles {key: value} pairs", () => {
  assert.deepEqual(parseFlowMapping("  - {type: pr_merged, ref: 19}"), {
    type: "pr_merged",
    ref: 19,
  });
  assert.deepEqual(parseFlowMapping("  - {type: plan_phase, plan: 1, phase: 5, status: merged}"), {
    type: "plan_phase",
    plan: 1,
    phase: 5,
    status: "merged",
  });
});

test("parseFlowMapping returns null for non-mapping lines", () => {
  assert.equal(parseFlowMapping("not a mapping"), null);
});

test("parsePreconditionsBlock extracts entries from yaml block", () => {
  const sec = `### Phase 1
**Precondition:** PR #19 merged.

\`\`\`yaml
preconditions:
  - {type: pr_merged, ref: 19}
  - {type: adr_accepted, ref: 23}
\`\`\`

**Goal:** ...`;
  const entries = parsePreconditionsBlock(sec);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].type, "pr_merged");
  assert.equal(entries[1].ref, 23);
});

test("parsePreconditionsBlock returns null when no yaml block", () => {
  assert.equal(parsePreconditionsBlock("### Phase 1\nno yaml here"), null);
});

test("parsePreconditionsBlock accepts ```yml as alias for ```yaml", () => {
  const sec = `### Phase 1

\`\`\`yml
preconditions:
  - {type: pr_merged, ref: 42}
\`\`\``;
  const entries = parsePreconditionsBlock(sec);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ref, 42);
});

test("parsePreconditionsBlock parses indented preconditions key under a parent map", () => {
  const sec = `### Phase 1

\`\`\`yaml
phase:
  preconditions:
    - {type: adr_accepted, ref: 23}
    - {type: plan_phase, plan: 1, phase: 5, status: merged}
\`\`\``;
  const entries = parsePreconditionsBlock(sec);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].type, "adr_accepted");
  assert.equal(entries[1].plan, 1);
});

test("parsePreconditionsBlock stops at sibling key on de-indent", () => {
  const sec = `### Phase 1

\`\`\`yaml
preconditions:
  - {type: pr_merged, ref: 19}
goal: ship the thing
not_a_precondition:
  - {type: pr_merged, ref: 999}
\`\`\``;
  const entries = parsePreconditionsBlock(sec);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ref, 19);
});

test("parsePreconditionsBlock returns [] for empty preconditions list", () => {
  const sec = `### Phase 1

\`\`\`yaml
preconditions:
goal: scaffolding
\`\`\``;
  const entries = parsePreconditionsBlock(sec);
  assert.deepEqual(entries, []);
});

test("parsePreconditionsBlock accepts trailing YAML comment after preconditions key", () => {
  const sec = `### Phase 1

\`\`\`yaml
preconditions: # gated by ADR-023
  - {type: pr_merged, ref: 19}
\`\`\``;
  const entries = parsePreconditionsBlock(sec);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ref, 19);
});

test("parsePreconditionsBlock does NOT enter block on inline scalar value", () => {
  // `preconditions: []` and `preconditions: foo` are inline values, not block
  // openers — entering block mode here would let the parser misinterpret
  // following lines as members of an empty list.
  const inlineEmpty = `### Phase 1
\`\`\`yaml
preconditions: []
phase: 1
\`\`\``;
  assert.deepEqual(parsePreconditionsBlock(inlineEmpty), []);
  const inlineScalar = `### Phase 1
\`\`\`yaml
preconditions: legacy
phase: 1
\`\`\``;
  assert.deepEqual(parsePreconditionsBlock(inlineScalar), []);
});

test("regexParsePreconditionsLine extracts patterns", () => {
  const e1 = regexParsePreconditionsLine("PR #19 merged");
  assert.equal(e1.length, 1);
  assert.equal(e1[0].type, "pr_merged");
  assert.equal(e1[0].ref, 19);

  const e2 = regexParsePreconditionsLine("Plan-001 Phase 5 merged and ADR-023 accepted");
  assert.equal(e2.length, 2);
});

test("extractPlanNumber pulls leading number from filename", () => {
  assert.equal(extractPlanNumber("docs/plans/001-foo.md"), 1);
  assert.equal(extractPlanNumber("docs/plans/027-bar-baz.md"), 27);
  assert.equal(extractPlanNumber("not-a-plan.md"), null);
});

test("extractAdrStatus parses table form", () => {
  assert.equal(extractAdrStatus("| **Status** | accepted |"), "accepted");
  assert.equal(extractAdrStatus("| **Status** | `accepted` |"), "accepted");
});

test("extractAdrStatus parses bold-field form", () => {
  assert.equal(extractAdrStatus("**Status:** proposed"), "proposed");
});

test("findProgressLogPhaseEntry finds Phase N or PR #N", () => {
  const src = `## Progress Log

- **PR #5** (squash-commit ...): Phase 3 stuff.
`;
  assert.equal(findProgressLogPhaseEntry(src, 5), true);
  assert.equal(findProgressLogPhaseEntry(src, 3), true);
  assert.equal(findProgressLogPhaseEntry(src, 99), false);
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

// ---------- gates with stubbed gh ----------

test("gatePhaseUnshipped passes when title not in merged list", () => {
  const merged = [{ number: 5, title: "feat: scaffold something else" }];
  const r = gatePhaseUnshipped(1, { number: 99, title: "Future Phase" }, merged);
  assert.equal(r.ok, true);
});

test("gatePhaseUnshipped fails when phase already shipped (PR # form)", () => {
  const merged = [{ number: 5, title: "feat(repo): Plan-001 PR #5 — workspace bootstrap" }];
  const r = gatePhaseUnshipped(1, { number: 5, title: "Workspace Bootstrap" }, merged);
  assert.equal(r.ok, false);
  assert.match(r.halt, /already shipped/);
});

test("gatePhaseUnshipped fails when phase title substring matches", () => {
  const merged = [{ number: 9, title: "feat: Workspace Bootstrap landing" }];
  const r = gatePhaseUnshipped(1, { number: 1, title: "Workspace Bootstrap" }, merged);
  assert.equal(r.ok, false);
});

test("gatePhaseUnshipped uses gh --paginate (no hard cap on merged-PR lookup)", () => {
  let observed = "";
  setGhImpl((cmd) => {
    observed = cmd;
    return "[]";
  });
  try {
    gatePhaseUnshipped(1, { number: 99, title: "Future Phase" });
  } finally {
    resetGhImpl();
  }
  assert.match(observed, /--paginate\b/);
  assert.doesNotMatch(observed, /--limit\s+\d+/);
});

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

test("resolvePrecondition handles plan_phase via Progress Log", () => {
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "plans", "001-test.md"),
    `# Plan-001

## Progress Log

- **PR #5** (squash-commit ...): tasks delivered.
`,
  );
  const r = resolvePrecondition(
    { type: "plan_phase", plan: 1, phase: 5, status: "merged" },
    { repoRoot: repo },
  );
  assert.equal(r.ok, true);
});

// ---------- runPreflight integration ----------

test("runPreflight selects first eligible un-shipped phase", () => {
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(
    skillMd,
    `---
name: test
requires_files: []
---

body`,
  );
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

- T1: Spec coverage: foo / Verifies invariant: bar
`,
  );
  setGhImpl(() => "[]");
  try {
    const r = runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
    assert.equal(r.exit, 0, `exit was ${r.exit}; stdout=${r.stdout}; stderr=${r.stderr}`);
    assert.equal(r.stdout, "1");
  } finally {
    resetGhImpl();
  }
});

test("runPreflight halts on unchecked audit checkbox", () => {
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(
    skillMd,
    `---
name: test
requires_files: []
---`,
  );
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
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(
    skillMd,
    `---
name: test
requires_files: []
---`,
  );
  const planFile = join(repo, "docs", "plans", "001-test.md");
  writeFileSync(
    planFile,
    `# Plan-001

- [x] **Plan-readiness audit complete

### Phase 1 — Bootstrap

(no cites here)
`,
  );
  setGhImpl(() => "[]");
  try {
    const r = runPreflight(planFile, 1, { repoRoot: repo, skillMd });
    assert.equal(r.exit, 1);
    assert.match(r.stdout, /missing G4 cites/);
  } finally {
    resetGhImpl();
  }
});
