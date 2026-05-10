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
  MERGED_PRS_FETCH_LIMIT,
  fetchLimitSentinelHalt,
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

test("parsePreconditionsBlock accepts compact YAML block-sequence form (items at same indent as key)", () => {
  // YAML allows block-sequence items at the SAME column as the parent key
  // (compact form), not only at a strictly greater column (expanded form).
  // The strict-greater guard misclassified compact-form preconditions as
  // empty, letting gatePreconditions dispatch work with required gates
  // ungated. Both forms must parse identically.
  const compactTopLevel = `### Phase 1

\`\`\`yaml
preconditions:
- {type: pr_merged, ref: 19}
- {type: adr_accepted, ref: 23}
\`\`\``;
  const compactEntries = parsePreconditionsBlock(compactTopLevel);
  assert.equal(compactEntries.length, 2);
  assert.equal(compactEntries[0].type, "pr_merged");
  assert.equal(compactEntries[1].ref, 23);

  const compactNested = `### Phase 1

\`\`\`yaml
phase:
  preconditions:
  - {type: plan_phase, plan: 1, phase: 5, status: merged}
\`\`\``;
  const nestedEntries = parsePreconditionsBlock(compactNested);
  assert.equal(nestedEntries.length, 1);
  assert.equal(nestedEntries[0].plan, 1);
});

test("parsePreconditionsBlock ignores in-list YAML comments at any indent", () => {
  // Comments are metadata — they must not change parser state. In compact
  // form (or compact-nested), a comment at the parent key's indent column
  // satisfies `lineIndent <= preIndent` and would otherwise trigger
  // block-exit, dropping every later item silently. That's a gate-skip:
  // gatePreconditions sees only the first item and dispatches work even
  // though later required gates aren't met.
  const compactWithComment = `### Phase 1

\`\`\`yaml
preconditions:
- {type: pr_merged, ref: 19}
# leading-column comment between items
- {type: adr_accepted, ref: 23}
\`\`\``;
  const compactEntries = parsePreconditionsBlock(compactWithComment);
  assert.equal(
    compactEntries.length,
    2,
    "compact form must include both items past a same-indent comment",
  );
  assert.equal(compactEntries[0].ref, 19);
  assert.equal(compactEntries[1].ref, 23);

  const compactNestedWithComment = `### Phase 1

\`\`\`yaml
phase:
  preconditions:
  - {type: pr_merged, ref: 19}
  # parent-indent comment between items (Codex P1 case)
  - {type: adr_accepted, ref: 23}
\`\`\``;
  const nestedEntries = parsePreconditionsBlock(compactNestedWithComment);
  assert.equal(
    nestedEntries.length,
    2,
    "compact-nested form must include both items past a parent-indent comment",
  );
  assert.equal(nestedEntries[0].type, "pr_merged");
  assert.equal(nestedEntries[1].type, "adr_accepted");

  const expandedWithComment = `### Phase 1

\`\`\`yaml
preconditions:
  - {type: pr_merged, ref: 19}
  # in-list comment at item indent
  - {type: adr_accepted, ref: 23}
\`\`\``;
  const expandedEntries = parsePreconditionsBlock(expandedWithComment);
  assert.equal(
    expandedEntries.length,
    2,
    "expanded form must include both items past an in-list comment",
  );

  const commentBeforeFirstItem = `### Phase 1

\`\`\`yaml
preconditions:
# comment immediately after key, before first item
- {type: pr_merged, ref: 19}
\`\`\``;
  const headerCommentEntries = parsePreconditionsBlock(commentBeforeFirstItem);
  assert.equal(
    headerCommentEntries.length,
    1,
    "comment between key and first item must not exit the block",
  );
  assert.equal(headerCommentEntries[0].ref, 19);
});

test("parsePreconditionsBlock still exits on real sibling key with trailing comment", () => {
  // Regression guard for the comment-fix: a key-with-trailing-comment line
  // (`goal: ship  # blah`) is NOT a comment-only line — its first non-space
  // character is `g`, not `#` — so the de-indent exit must still fire.
  const sec = `### Phase 1

\`\`\`yaml
preconditions:
- {type: pr_merged, ref: 19}
goal: ship  # trailing comment on a real key line
- {type: not_under_pre, ref: 999}
\`\`\``;
  const entries = parsePreconditionsBlock(sec);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ref, 19);
});

test("parsePreconditionsBlock locks first item's indent — sibling list at parent indent stays excluded", () => {
  // Regression guard for the compact-form fix: when the first item lands at
  // a STRICTLY-greater indent (expanded form), the locked itemIndent must
  // exclude later list items that drop back to the parent key's indent
  // (which would belong to a sibling list, not the preconditions block).
  const sec = `### Phase 1

\`\`\`yaml
preconditions:
  - {type: pr_merged, ref: 19}
- {type: should_not_be_pre, ref: 999}
\`\`\``;
  const entries = parsePreconditionsBlock(sec);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ref, 19);
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

test("gatePhaseUnshipped passes when only docs PR mentions Plan-NNN Phase N", () => {
  // Doc-only governance PR that amends the phase's Precondition section must
  // not false-match as a shipped phase. Real-world case: PR #29
  // "docs(repo): resolve NS-12 — split Plan-001 Phase 5 + audit checkbox".
  const merged = [
    { number: 29, title: "docs(repo): resolve NS-12 — split Plan-001 Phase 5 + audit checkbox" },
  ];
  const r = gatePhaseUnshipped(1, { number: 5, title: "Client SDK And Desktop Bootstrap" }, merged);
  assert.equal(r.ok, true);
});

test("gatePhaseUnshipped passes when only chore PR mentions phase title substring", () => {
  // Chore PRs (e.g., dependency bumps, scaffolding tweaks) that mention the
  // phase title in their subject must not false-match.
  const merged = [{ number: 30, title: "chore(client-sdk): scaffold Workspace Bootstrap dirs" }];
  const r = gatePhaseUnshipped(1, { number: 1, title: "Workspace Bootstrap" }, merged);
  assert.equal(r.ok, true);
});

test("gatePhaseUnshipped accepts feat-with-scope-and-bang prefix as code shipment", () => {
  // Conventional Commits allows `feat(scope)!:` for breaking changes. The
  // prefix matcher must not exclude breaking-change shipments.
  const merged = [
    { number: 31, title: "feat(daemon)!: ship Plan-001 Phase 3 with breaking projector schema" },
  ];
  const r = gatePhaseUnshipped(1, { number: 3, title: "Daemon Migration" }, merged);
  assert.equal(r.ok, false);
});

test("gatePhaseUnshipped uses --limit MERGED_PRS_FETCH_LIMIT (gh pr list lacks --paginate)", () => {
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
  assert.match(observed, new RegExp(`--limit\\s+${MERGED_PRS_FETCH_LIMIT}\\b`));
  assert.doesNotMatch(observed, /--paginate\b/);
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

// ---------- regression: Plan-001 phase-walk via title+body matching ----------
//
// Plan-001 PRs #6, #8, #9, #10 carry package-scoped Conventional Commit titles
// (`feat(contracts):`, `feat(daemon):`, `feat(control-plane):`) that omit the
// `Plan-001` substring. The shipment claim lives in the PR body's
// `Plan-001 PR #N — <phase title>` line. Title-only matching dropped these
// PRs from the gh search result and the pattern-match step, so preflight
// auto-detect mis-resolved Phase 2 as the next un-shipped phase even though
// PRs #8/#9/#10 had landed Phases 2/3/4 weeks earlier.
//
// PR #30 is the partial-ship counter-example: it ships only T5.1 of Phase 5's
// Lane A (T5.5 + T5.6 still pending). Its body says `Plan-001 Phase 5 Lane A
// T5.1` — narrative chatter, not a `Plan-NNN PR #N` shipment claim. The fix
// must NOT mark Phase 5 as shipped from that body, or preflight halts on a
// non-existent shipped phase and blocks dispatch on T5.5.

test("gatePhaseUnshipped detects Phase shipment via 'Plan-NNN PR #N' in PR body", () => {
  const merged = [
    {
      number: 6,
      title: "feat(repo): scaffold V1 monorepo + engineering CI surface",
      body: "## Summary\n\nPlan-001 PR #1 — Workspace Bootstrap. Lands the V1 monorepo skeleton.",
    },
    {
      number: 8,
      title: "feat(contracts): add session, event, and error payload schemas",
      body: "## Summary\n\nImplements **Plan-001 PR #2 — Contracts Package**.",
    },
    {
      number: 9,
      title: "feat(daemon): add session migration, projector, and append/replay service",
      body: "## Summary\n\nImplements **Plan-001 PR #3 — Daemon Migration And Projection**.",
    },
    {
      number: 10,
      title: "feat(control-plane): add session directory service (create/read/join)",
      body: "## Summary\nPlan-001 PR #4 — Control Plane Directory.",
    },
  ];
  for (const ph of [1, 2, 3, 4]) {
    const r = gatePhaseUnshipped(1, { number: ph, title: `Phase ${ph} title` }, merged);
    assert.equal(
      r.ok,
      false,
      `Phase ${ph} should be marked shipped from body 'Plan-001 PR #${ph}'`,
    );
    assert.match(r.halt, /already shipped/);
  }
});

test("gatePhaseUnshipped does NOT mark Phase 5 shipped when PR body says 'Phase 5 Lane A T5.1' (partial ship)", () => {
  // Regression-protection: 'Plan-NNN Phase N' body language is partial-ship
  // chatter (subsection-numbered tasks, lane references). The fix MUST NOT
  // re-broaden phaseFormPattern or title-substring matching to body, or
  // Plan-001 Phase 5 silently false-matches and dispatch halts on a
  // non-existent shipped phase.
  const merged = [
    {
      number: 30,
      title: "feat(client-sdk): add sessionClient transports (Plan-001 T5.1)",
      body: "## Summary\n\nPlan-001 Phase 5 Lane A T5.1 — author packages/client-sdk/src/sessionClient.ts. First of three PRs in Plan-001 Phase 5 Lane A; T5.5 and T5.6 follow as separate PRs.",
    },
  ];
  const r = gatePhaseUnshipped(1, { number: 5, title: "Client SDK And Desktop Bootstrap" }, merged);
  assert.equal(r.ok, true, "Phase 5 must remain un-shipped — PR #30 ships only T5.1");
});

test("gatePhaseUnshipped uses 'in:title,body' search and includes body in --json fields", () => {
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
  assert.match(observed, /in:title,body/, "must search title and body, not just title");
  assert.match(observed, /--json\s+\S*\bbody\b/, "must request body in --json fields");
});

test("runPreflight returns next un-shipped phase for Plan-001-realistic corpus", () => {
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
  const phaseSection = (n, title) => `### Phase ${n} — ${title}

**Precondition:** None.

\`\`\`yaml
preconditions: []
\`\`\`

#### Tasks

- T${n}.1: Spec coverage: row ${n} / Verifies invariant: I-001-${n}
`;
  writeFileSync(
    planFile,
    `# Plan-001

## Preconditions

- [x] **Plan-readiness audit complete per runbook.

${phaseSection(1, "Workspace Bootstrap")}
${phaseSection(2, "Contracts Package")}
${phaseSection(3, "Daemon Migration")}
${phaseSection(4, "Control Plane Directory")}
${phaseSection(5, "Client SDK And Desktop Bootstrap")}
`,
  );
  const mergedPRs = [
    {
      number: 6,
      title: "feat(repo): scaffold V1 monorepo + engineering CI surface",
      body: "Plan-001 PR #1 — Workspace Bootstrap.",
    },
    {
      number: 8,
      title: "feat(contracts): add session, event, and error payload schemas",
      body: "Plan-001 PR #2 — Contracts Package.",
    },
    {
      number: 9,
      title: "feat(daemon): add session migration, projector, and append/replay service",
      body: "Plan-001 PR #3 — Daemon Migration.",
    },
    {
      number: 10,
      title: "feat(control-plane): add session directory service (create/read/join)",
      body: "Plan-001 PR #4 — Control Plane Directory.",
    },
    {
      number: 30,
      title: "feat(client-sdk): add sessionClient transports (Plan-001 T5.1)",
      body: "Plan-001 Phase 5 Lane A T5.1 — partial ship; T5.5 + T5.6 pending.",
    },
  ];
  setGhImpl(() => JSON.stringify(mergedPRs));
  try {
    const r = runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
    assert.equal(r.exit, 0, `exit was ${r.exit}; stdout=${r.stdout}; stderr=${r.stderr}`);
    assert.equal(r.stdout, "5", "Phases 1-4 shipped via body marker; Phase 5 still un-shipped");
  } finally {
    resetGhImpl();
  }
});

// ---------- merged-PR fetch limit + sentinel halt (Codex finding on PR #34) ----------
//
// With body-matching the result universe is "PRs that mention Plan-NNN
// anywhere (Refs footers included)" — much wider than phase shipments.
// A capped fetch can silently truncate older shipping PRs, mis-resolving
// preflight to an already-shipped phase. Both call sites must use the
// same constant and halt loudly when the cap is hit.

test("MERGED_PRS_FETCH_LIMIT is the GitHub search REST API ceiling (1000)", () => {
  // If this constant ever drifts, both --limit assertions and the sentinel
  // halt drift with it — and the API will silently top out at 1000 anyway.
  // Keep the constant pinned so review notices any unilateral change.
  assert.equal(MERGED_PRS_FETCH_LIMIT, 1000);
});

test("gatePhaseUnshipped passes --limit MERGED_PRS_FETCH_LIMIT to gh", () => {
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
  assert.match(
    observed,
    new RegExp(`--limit\\s+${MERGED_PRS_FETCH_LIMIT}\\b`),
    "standalone path must use the module constant, not a literal",
  );
});

test("runPreflight prefetch passes --limit MERGED_PRS_FETCH_LIMIT to gh", () => {
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(skillMd, `---\nname: test\nrequires_files: []\n---\n\nbody`);
  const planFile = join(repo, "docs", "plans", "001-test.md");
  writeFileSync(
    planFile,
    `# Plan-001\n\n## Preconditions\n\n- [x] **Plan-readiness audit complete per runbook.\n\n### Phase 1 — Foo\n\n**Precondition:** None.\n\n\`\`\`yaml\npreconditions: []\n\`\`\`\n\n#### Tasks\n\n- T1.1: Spec coverage: row 1 / Verifies invariant: I-001-1\n`,
  );
  let observed = "";
  setGhImpl((cmd) => {
    observed = cmd;
    return "[]";
  });
  try {
    runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
  } finally {
    resetGhImpl();
  }
  assert.match(
    observed,
    new RegExp(`--limit\\s+${MERGED_PRS_FETCH_LIMIT}\\b`),
    "prefetch path must use the module constant, not a literal",
  );
});

test("gatePhaseUnshipped halts with sentinel when mergedList length >= MERGED_PRS_FETCH_LIMIT", () => {
  // Build a synthetic list at the cap with one PR that would normally match
  // the precise shipment marker. The sentinel must halt BEFORE pattern
  // matching: we cannot guarantee completeness past the API ceiling, so
  // returning a "shipped" or "un-shipped" verdict either way is unsafe.
  const merged = new Array(MERGED_PRS_FETCH_LIMIT).fill(null).map((_, i) => ({
    number: i + 1,
    title: `feat(repo): noise PR ${i + 1}`,
    body: `Refs: Plan-001`,
  }));
  // Inject one PR that, in a smaller corpus, would mark Phase 1 as shipped.
  merged[0] = {
    number: 6,
    title: "feat(repo): scaffold V1 monorepo + engineering CI surface",
    body: "Plan-001 PR #1 — Workspace Bootstrap.",
  };
  const r = gatePhaseUnshipped(1, { number: 1, title: "Workspace Bootstrap" }, merged);
  assert.equal(r.ok, false, "sentinel must halt — cannot guarantee completeness past API ceiling");
  assert.match(r.halt, /merged-PR fetch hit ceiling/);
  assert.match(r.halt, /1000/, "halt must name the ceiling explicitly");
});

test("runPreflight halts with sentinel when prefetch returns >= MERGED_PRS_FETCH_LIMIT PRs", () => {
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(skillMd, `---\nname: test\nrequires_files: []\n---\n\nbody`);
  const planFile = join(repo, "docs", "plans", "001-test.md");
  writeFileSync(
    planFile,
    `# Plan-001\n\n## Preconditions\n\n- [x] **Plan-readiness audit complete per runbook.\n\n### Phase 1 — Foo\n\n**Precondition:** None.\n\n\`\`\`yaml\npreconditions: []\n\`\`\`\n\n#### Tasks\n\n- T1.1: Spec coverage: row 1 / Verifies invariant: I-001-1\n`,
  );
  const merged = new Array(MERGED_PRS_FETCH_LIMIT).fill(null).map((_, i) => ({
    number: i + 1,
    title: `feat(repo): noise PR ${i + 1}`,
    body: `Refs: Plan-001`,
  }));
  setGhImpl(() => JSON.stringify(merged));
  try {
    const r = runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
    assert.equal(r.exit, 1, `expected exit 1 from sentinel halt; got ${r.exit}`);
    assert.match(r.stdout, /merged-PR fetch hit ceiling/);
  } finally {
    resetGhImpl();
  }
});

test("fetchLimitSentinelHalt names ceiling, plan, and remediation paths", () => {
  const halt = fetchLimitSentinelHalt(1);
  assert.match(halt, /merged-PR fetch hit ceiling/, "must lead with the failure type");
  assert.match(
    halt,
    /Plan-001/,
    "must name the plan in the search expression for empirical verify",
  );
  assert.match(halt, new RegExp(String(MERGED_PRS_FETCH_LIMIT)), "must name the cap");
  assert.match(halt, /Remediations:/, "must list remediations, not just describe the failure");
  assert.match(halt, /paginated/i, "must surface the structural fix (paginated search)");
});
