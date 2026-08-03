// node:test suite for preflight.mjs.
// Run via: node --test .claude/skills/plan-execution/scripts/__tests__/preflight.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  parseFrontmatter,
  walkPhases,
  walkSupplementPhases,
  parsePhaseArgument,
  extractPhaseSection,
  findSectionBoundary,
  countCites,
  extractAuditCheckbox,
  parseFlowMapping,
  parsePreconditionsBlock,
  regexParsePreconditionsLine,
  extractPlanNumber,
  planLabel,
  extractAdrStatus,
  extractDeclaredTaskIds,
  extractTasksBlock,
  classifyPhaseSize,
  extractSection5,
  shippedTaskIdsForPhase,
  shippedTaskIdsAcrossManifest,
  gateProjectLocality,
  gateAuditCheckbox,
  gateStatusPromotion,
  gatePlanPreconditionBoxes,
  gatePhaseAuditCheckbox,
  gateTasksBlockCites,
  gatePhaseUnshipped,
  gatePreconditions,
  extractPreconditionsSection,
  resolvePrecondition,
  extractBacklogItemSection,
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

test("walkPhases accepts colon-form separators (Plan-007/008/023 shape)", () => {
  const plan = `### Phase 1: SecureDefaults Bootstrap (loopback-bind validation only)
content
### Phase 2: Wire Substrate
more content
### Phase 3: \`session.*\` Handlers + SDK Zod Layer
final`;
  const phases = walkPhases(plan);
  assert.equal(phases.length, 3);
  assert.equal(phases[0].number, 1);
  assert.equal(phases[0].title, "SecureDefaults Bootstrap (loopback-bind validation only)");
  assert.equal(phases[1].title, "Wire Substrate");
  assert.equal(phases[2].number, 3);
});

test("walkPhases accepts mixed separators in one corpus", () => {
  const plan = `### Phase 1 — Em-dash phase
em content
### Phase 2: Colon phase
colon content
### Phase 3 - Hyphen phase
hyphen content`;
  const phases = walkPhases(plan);
  assert.equal(phases.length, 3);
  assert.equal(phases[0].title, "Em-dash phase");
  assert.equal(phases[1].title, "Colon phase");
  assert.equal(phases[2].title, "Hyphen phase");
});

test("extractPhaseSection accepts colon-form heading", () => {
  const plan = `### Phase 1: Bootstrap
phase 1 body
### Phase 2: Wire Substrate
phase 2 body`;
  const sec = extractPhaseSection(plan, 1);
  assert.match(sec, /phase 1 body/);
  assert.doesNotMatch(sec, /phase 2 body/);
});

test("extractPhaseSection bounds the last phase at the next level-2 ## sibling, not EOF", () => {
  // Regression: the last phase must stop at its first `## ` sibling (Progress
  // Log) rather than running to EOF and swallowing the Shipment Manifest yaml.
  // The swallow silently disabled the last-phase precondition gate — the
  // manifest block was mistaken for a (vacuous) preconditions block.
  const plan = `### Phase 1 — A
phase 1 body
### Phase 2 — B (last phase)
phase 2 body
## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped: []
\`\`\`
`;
  const sec = extractPhaseSection(plan, 2);
  assert.match(sec, /phase 2 body/);
  assert.doesNotMatch(sec, /Progress Log/);
  assert.doesNotMatch(sec, /manifest_schema_version/);
});

test("extractPhaseSection (last phase) stops at the next ## sibling so trailing task-shaped headings don't bleed into Gate 3", () => {
  // Without the `## ` boundary, the last phase ran to EOF and swallowed the
  // ## Progress Log / ## Notes siblings, so a trailing `##### Tx.y`-shaped
  // heading in Notes was wrongly attributed to the phase by
  // extractDeclaredTaskIds (the set Gate 3 compares against the manifest).
  const plan = `### Phase 1 — Only phase

#### Tasks

##### T1.1 — real task
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-1

## Progress Log

### Notes

##### T9.9 — trailing prose that merely looks like a task heading
`;
  const sec = extractPhaseSection(plan, 1);
  assert.match(sec, /T1\.1/);
  assert.doesNotMatch(sec, /T9\.9/);
  assert.deepEqual(extractDeclaredTaskIds(sec), ["T1.1"]);
});

test("findSectionBoundary skips headings inside fenced code blocks", () => {
  // A `## ` or `### Phase` line inside a ``` / ~~~ fence is body content, not a
  // section boundary — the scan must walk past it to the real sibling heading.
  const fenced = [
    "intro line",
    "```md",
    "## fenced heading (not a boundary)",
    "### Phase 9 — also fenced",
    "```",
    "more body",
    "## Real Sibling",
    "tail",
  ].join("\n");
  const at = findSectionBoundary(fenced);
  assert.ok(at >= 0 && fenced.slice(at).startsWith("## Real Sibling"));

  // A longer outer ```` run contains shorter inner ``` runs (CommonMark): the
  // scan stays inside the fence until the matching 4-backtick close, not the
  // first 3-backtick line.
  const nested = ["a", "````md", "## inner", "```", "## still inner", "````", "## Out"].join("\n");
  const atN = findSectionBoundary(nested);
  assert.ok(atN >= 0 && nested.slice(atN).startsWith("## Out"));

  // No heading outside a fence → -1.
  assert.equal(findSectionBoundary("just\nbody\n```\n## fenced\n```\n"), -1);
});

test("findSectionBoundary skips headings inside multi-line HTML comments", () => {
  // A commented-out `## ` / `### Phase` line renders as nothing and must not
  // terminate a section (Codex round-4, PR #224 — shared structural scan).
  const commented = [
    "intro",
    "<!--",
    "## Not A Boundary",
    "### Phase 9 — also commented",
    "-->",
    "body",
    "## Real Boundary",
  ].join("\n");
  const at = findSectionBoundary(commented);
  assert.ok(at >= 0 && commented.slice(at).startsWith("## Real Boundary"));

  // A single-line comment is inline content: the next real heading still bounds.
  const inline = ["intro <!-- note -->", "## Real Boundary"].join("\n");
  const atInline = findSectionBoundary(inline);
  assert.ok(atInline >= 0 && inline.slice(atInline).startsWith("## Real Boundary"));
});

test("findSectionBoundary ignores comment markers inside inline code spans", () => {
  // Codex round-5, PR #224: prose DISCUSSING comments — "Use `<!--` to
  // begin a comment" — must not open comment state; under the raw marker
  // check it consumed every later heading and silently merged phases.
  const prose = ["intro", "Use `<!--` to begin a comment.", "body", "## Real Boundary"].join("\n");
  const at = findSectionBoundary(prose);
  assert.ok(at >= 0 && prose.slice(at).startsWith("## Real Boundary"));

  // A bare inline-code close marker (the mermaid-arrow prose shape,
  // "reflected in mermaid `-->` edges") is inert either way.
  const arrow = ["intro", "reflected in mermaid `-->` edges", "## Real Boundary"].join("\n");
  const atA = findSectionBoundary(arrow);
  assert.ok(atA >= 0 && arrow.slice(atA).startsWith("## Real Boundary"));
});

test("findSectionBoundary treats a 4-space-indented ``` as literal, not a fence opener", () => {
  // CommonMark caps fence-opener indentation at 3 spaces; a ``` inside an
  // indented code block is literal text. Under an unrestricted \s* opener it
  // opened phantom fence state and swallowed the real boundary (Codex
  // round-4, PR #224).
  const indented = ["intro", "    ```", "    literal", "## Real Boundary"].join("\n");
  const at = findSectionBoundary(indented);
  assert.ok(at >= 0 && indented.slice(at).startsWith("## Real Boundary"));

  // 1-3-space indentation still opens a fence (the list-indented shape).
  const listFence = ["intro", "   ```", "## fenced", "   ```", "## Real Boundary"].join("\n");
  const atL = findSectionBoundary(listFence);
  assert.ok(atL >= 0 && listFence.slice(atL).startsWith("## Real Boundary"));
});

test("findSectionBoundary rejects backtick-fence info strings containing backticks", () => {
  // Codex round-6, PR #224 (advanceScanState parity): a ```md`inline line
  // is inline code, not a fence opener — under the unguarded regex it
  // opened phantom fence state and swallowed the real boundary.
  const inlineCode = ["intro", "```md`inline", "prose", "## Real Boundary"].join("\n");
  const at = findSectionBoundary(inlineCode);
  assert.ok(at >= 0 && inlineCode.slice(at).startsWith("## Real Boundary"));
});

test("findSectionBoundary skips raw HTML blocks and multi-line code spans", () => {
  // Codex round-6, PR #224: a heading-looking line inside a `<script>`
  // block (CommonMark 4.6 type 1) or a multi-line code span is raw
  // content, not a section boundary.
  const html = ["<script>", "## Not A Boundary", "</script>", "## Real Boundary"].join("\n");
  const atH = findSectionBoundary(html);
  assert.ok(atH >= 0 && html.slice(atH).startsWith("## Real Boundary"));

  const span = ["a `open", "<!-- masked by the span", "close` b", "## Real Boundary"].join("\n");
  const atS = findSectionBoundary(span);
  assert.ok(atS >= 0 && span.slice(atS).startsWith("## Real Boundary"));
});

test("extractPhaseSection keeps a fenced ## / ### Phase example in the body and bounds only at the real sibling", () => {
  // Fence-awareness regression: a phase whose body shows a fenced markdown
  // example (with `## ` and `### Phase` lines) must not be truncated at that
  // example — its `#### Tasks` block follows the fence and would otherwise be
  // severed from Gate 3/4, and the example heading would be mistaken for the
  // section boundary. Pre-fence-aware, extractDeclaredTaskIds(sec) was [].
  const plan = `### Phase 1 — Only phase

Example of a plan heading, shown inside a fence:

\`\`\`md
## Not a real sibling
### Phase 99 — not a real phase
\`\`\`

#### Tasks

##### T1.1 — real task
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-1

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped: []
\`\`\`
`;
  const sec = extractPhaseSection(plan, 1);
  assert.match(sec, /Not a real sibling/); // fenced example stays in the section
  assert.match(sec, /T1\.1/); //              #### Tasks survived the fenced `## `
  assert.doesNotMatch(sec, /Progress Log/); // real `## ` sibling still bounds it
  assert.doesNotMatch(sec, /manifest_schema_version/);
  assert.deepEqual(extractDeclaredTaskIds(sec), ["T1.1"]);
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

test("parsePreconditionsBlock returns null for a non-preconditions yaml block (Shipment Manifest)", () => {
  // The Progress-Log manifest block has no `preconditions:` key — it is not a
  // preconditions block, so parse must return null and let gatePreconditions
  // fall back to the prose **Precondition:** line, NOT consume the manifest as
  // a vacuous []. Returning [] here is the exact bug that no-op'd the
  // last-phase gate.
  const sec = `### Phase 5

**Precondition:** Phase 4 merged.

\`\`\`yaml
manifest_schema_version: 1
shipped: []
\`\`\`
`;
  assert.equal(parsePreconditionsBlock(sec), null);
});

test("parsePreconditionsBlock selects the preconditions block when a non-preconditions yaml block precedes it", () => {
  // A schema/data example earlier in the section must not shadow a real
  // preconditions block that follows — the parser scans all yaml blocks and
  // picks the first one carrying a `preconditions:` key.
  const sec = `### Phase 2

\`\`\`yaml
capabilities:
  - key: gpu
\`\`\`

\`\`\`yaml
preconditions:
  - {type: pr_merged, ref: 19}
\`\`\`
`;
  assert.deepEqual(parsePreconditionsBlock(sec), [{ type: "pr_merged", ref: 19 }]);
});

test("regexParsePreconditionsLine extracts patterns", () => {
  const line = `PR #19 merged; ADR-023 accepted; Plan-007 Phase 3 merged.`;
  assert.deepEqual(regexParsePreconditionsLine(line), [
    { type: "pr_merged", ref: 19 },
    { type: "adr_accepted", ref: 23 },
    { type: "plan_phase", plan: 7, phase: 3, status: "merged" },
  ]);
});

test("regexParsePreconditionsLine resolves bare 'Phase N merged' against localPlanNumber", () => {
  // Corpus convention for same-plan precondition prose is the bare form
  // (Plan-001/003/007/024 all use it). Without the bare-form branch the
  // regex emits [] and gatePreconditions silently treats the line as legacy
  // free-form. With `localPlanNumber=3` the bare form resolves to a
  // machine-enforceable plan_phase entry against Plan-3.
  const line = `Phase 1 merged (workspace + CI surface in place).`;
  assert.deepEqual(regexParsePreconditionsLine(line, 3), [
    { type: "plan_phase", plan: 3, phase: 1, status: "merged" },
  ]);
});

test("regexParsePreconditionsLine does not double-count Plan-NNN Phase N when localPlanNumber set", () => {
  // The Plan-NNN form is already matched by the explicit-prefix regex. The
  // bare-form regex's negative lookbehind `(?<!Plan-\\d{3}\\s+)` excludes the
  // `Phase N merged` segment inside `Plan-NNN Phase N merged`, so passing a
  // different localPlanNumber must not duplicate the entry against the local
  // plan. This is the load-bearing invariant for the extension.
  const line = `Plan-001 Phase 5 merged AND something irrelevant.`;
  assert.deepEqual(regexParsePreconditionsLine(line, 24), [
    { type: "plan_phase", plan: 1, phase: 5, status: "merged" },
  ]);
});

test("regexParsePreconditionsLine omits bare-form when localPlanNumber is undefined", () => {
  // Backward-compat: legacy callers that omit localPlanNumber (and tests that
  // assert pre-extension behavior) must not see bare-form entries materialize.
  const line = `Phase 1 merged.`;
  assert.deepEqual(regexParsePreconditionsLine(line), []);
});

test("regexParsePreconditionsLine extracts plan_unshipped from link-TARGET Tier form", () => {
  // Corpus convention for a cross-tier dep on an un-decomposed upstream: the
  // plan number sits in the markdown link target. Plan-002 Phase 4 shape.
  const line = `[Plan-021](./021-rate-limiting-policy.md) Tier 6 ships the rateLimitProcedure middleware factory.`;
  assert.deepEqual(regexParsePreconditionsLine(line, 2), [{ type: "plan_unshipped", plan: 21 }]);
});

test("regexParsePreconditionsLine extracts plan_unshipped from link-TEXT Tier-Partial form", () => {
  // Plan-002 Phase 2 shape: the `Plan-NNN Tier M Partial` sits inside the link
  // text, with the deferral verb after the link. The optional `](url)` groups
  // absorb the link on either side of the Tier token.
  const line = `[Plan-025 Tier 1 Partial](./025-self-hostable-node-relay.md) merged.`;
  assert.deepEqual(regexParsePreconditionsLine(line, 2), [{ type: "plan_unshipped", plan: 25 }]);
});

test("regexParsePreconditionsLine does NOT emit plan_unshipped for a Plan-NNN Phase N form", () => {
  // The plan_unshipped regex requires a `Tier M` token; the `Plan-NNN Phase N
  // merged` form belongs to the plan_phase resolver (per-phase manifest check)
  // and must not be double-claimed as a coarse plan_unshipped entry.
  const line = `Plan-001 Phase 4 merged.`;
  assert.deepEqual(regexParsePreconditionsLine(line, 8), [
    { type: "plan_phase", plan: 1, phase: 4, status: "merged" },
  ]);
});

test("regexParsePreconditionsLine emits plan_unshipped alongside a satisfied local phase (Plan-002 Phase 4)", () => {
  // The exact false-eligible shape: a satisfied local `Phase 2 merged` token
  // plus the un-decomposed cross-tier `[Plan-021](…) Tier 6 ships` token. Both
  // entries surface; Gate 5 then halts on the unmet plan_unshipped one.
  const line = `Phase 2 merged AND [Plan-021](./021-rate-limiting-policy.md) Tier 6 ships the rateLimitProcedure middleware factory.`;
  assert.deepEqual(regexParsePreconditionsLine(line, 2), [
    { type: "plan_unshipped", plan: 21 },
    { type: "plan_phase", plan: 2, phase: 2, status: "merged" },
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

// Gate 4's invariant-reference resolution runs on the DISPATCH path, not only in
// the corpus survey: every `Verifies invariant:` id that names an owning plan
// (`I-001-1` names Plan-001) is resolved against that plan's declared
// `## Invariants` set. The synthetic plans below cite their own `I-001-N` ids, so
// they have to declare them — a plan citing an invariant nothing declares is the
// unresolved reference the screen exists to catch, not a fixture detail.
//
// Appended at END OF FILE, after `### Notes`, so no phase-section boundary moves:
// `extractPhaseSection` stops at the next `##` heading, and the last-phase
// precondition regressions below depend on the last phase still running through
// `## Progress Log`.
//
// Covers 1-9 because `buildTestRepo` mints one id per PHASE NUMBER
// (`**Verifies invariant:** I-001-${n}`), and its callers number phases up to 5.
// Declaring a superset is the right side to err on for a fixture: a declared id
// nothing cites is inert, while an undeclared cited id halts every test that
// dispatches the phase holding it.
const SYNTHETIC_PLAN_INVARIANTS = `
## Invariants

- **I-001-1 — fixture invariant**
- **I-001-2 — fixture invariant**
- **I-001-3 — fixture invariant**
- **I-001-4 — fixture invariant**
- **I-001-5 — fixture invariant**
- **I-001-6 — fixture invariant**
- **I-001-7 — fixture invariant**
- **I-001-8 — fixture invariant**
- **I-001-9 — fixture invariant**
`;

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
  // Padded display label, same convention as planLabel: raw interpolation
  // rendered "ADR-23" against a corpus that writes ADR-023.
  assert.match(r.halt, /ADR-023 Status=proposed/);
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
${SYNTHETIC_PLAN_INVARIANTS}`,
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
${SYNTHETIC_PLAN_INVARIANTS}`,
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

test("resolvePrecondition plan_phase says not-yet-shipped, not partially-shipped, when zero tasks have landed", () => {
  // Sibling of the partial-ship test above, pinning the other branch. The
  // classifier returns `partially_shipped` for "≥1 declared task missing",
  // which includes "none of them shipped" — Plan-010's manifest is literally
  // `shipped: []`, yet the halt claimed partial shipment. Also pins the
  // zero-padded label: the entry carries `plan: 10`, the corpus writes
  // `Plan-010`.
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "plans", "010-test.md"),
    `# Plan-010

### Phase 1 — Contracts + persistence

#### Tasks

##### T1.1 — Contract core
##### T1.2 — Wire pairs

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped: []
\`\`\`

### Notes
${SYNTHETIC_PLAN_INVARIANTS}`,
  );
  const r = resolvePrecondition(
    { type: "plan_phase", plan: 10, phase: 1, status: "merged" },
    { repoRoot: repo },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /^Plan-010 Phase 1 not yet shipped — missing tasks: T1\.1, T1\.2$/);
  assert.doesNotMatch(r.halt, /partially/);
});

test("planLabel zero-pads to the corpus Plan-NNN width without altering wider numbers", () => {
  assert.equal(planLabel(6), "Plan-006");
  assert.equal(planLabel(10), "Plan-010");
  assert.equal(planLabel(123), "Plan-123");
  // Entries that already arrive as padded strings must not double-pad.
  assert.equal(planLabel("010"), "Plan-010");
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
${SYNTHETIC_PLAN_INVARIANTS}`,
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
${SYNTHETIC_PLAN_INVARIANTS}`,
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
${SYNTHETIC_PLAN_INVARIANTS}`,
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
  // Zero-padded: the entry carries `plan: 99` but the halt is user-facing and
  // the corpus writes `Plan-NNN` everywhere.
  assert.match(r.halt, /Plan-099 not found/);
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
${SYNTHETIC_PLAN_INVARIANTS}`,
  );
  const r = resolvePrecondition(
    { type: "plan_phase", plan: 7, phase: 3, status: "merged" },
    { repoRoot: repo },
  );
  assert.equal(r.ok, true);
});

test("resolvePrecondition plan_unshipped is UNMET when the upstream is un-decomposed (no manifest)", () => {
  // The Plan-021 case: a Tier-6 plan with no shipment manifest yet. The
  // cross-tier substrate is unavailable, so a dependent phase must not be
  // auto-walk-eligible.
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "plans", "021-test.md"),
    `# Plan-021\n\nUn-decomposed Tier-6 plan — no \`### Phase\` sections, no shipment manifest.\n`,
  );
  const r = resolvePrecondition({ type: "plan_unshipped", plan: 21 }, { repoRoot: repo });
  assert.equal(r.ok, false);
  assert.match(r.halt, /has not shipped yet/);
});

test("resolvePrecondition plan_unshipped is MET once the upstream manifest has ≥1 shipped entry", () => {
  // Coarse-by-design: any shipped entry flips the dependency to met. When the
  // upstream is decomposed and its substrate ships, the dependent precondition
  // should be tightened to a per-phase `Plan-NNN Phase N merged` form.
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "plans", "021-test.md"),
    `# Plan-021

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 1
    task: T1.1
    pr: 5
    sha: abc1234
    merged_at: 2026-01-01
    files: []
    verifies_invariant: []
    spec_coverage: []
\`\`\`

### Notes
${SYNTHETIC_PLAN_INVARIANTS}`,
  );
  const r = resolvePrecondition({ type: "plan_unshipped", plan: 21 }, { repoRoot: repo });
  assert.equal(r.ok, true);
});

test("resolvePrecondition plan_unshipped halts when the target plan file is absent", () => {
  const repo = makeTempRepo();
  const r = resolvePrecondition({ type: "plan_unshipped", plan: 88 }, { repoRoot: repo });
  assert.equal(r.ok, false);
  assert.match(r.halt, /Plan-088 not found/);
});

// ---------- runPreflight integration ----------

function buildTestRepo({ phases, manifestEntries = "shipped: []" }) {
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(skillMd, `---\nname: test\nrequires_files: []\n---\n\nbody`);
  const planFile = join(repo, "docs", "plans", "001-test.md");
  const phaseSections = phases
    .map(
      ({
        n,
        title,
        tasks,
        // Both optional fields default to the pre-supplement spelling, so every
        // existing caller renders byte-identically.
        //
        // `invariant` exists because a supplement phase carries a LABEL in `n`
        // (`1B`), and `I-001-1B` is not a resolvable invariant id — neither a
        // declared id nor a facet of one — so Gate 4's invariant screen would
        // halt supplement fixtures for a reason the test is not about.
        invariant = n,
        preconditionsYaml = "preconditions: []",
      }) => `### Phase ${n} — ${title}

**Precondition:** None.

\`\`\`yaml
${preconditionsYaml}
\`\`\`

#### Tasks

${tasks
  .map(
    (t) => `##### ${t} — desc
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-${invariant}`,
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
${SYNTHETIC_PLAN_INVARIANTS}`,
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

test("runPreflight skips a phase deferred via a plan_unshipped cross-tier precondition", () => {
  // Regression guard for the Plan-002 Phase 4 false-eligible: a phase deferred
  // to a later tier via the prose `[Plan-NNN](…) Tier M ships …` form, whose
  // ONLY satisfied token is a local `Phase 1 merged`, must NOT auto-walk-
  // resolve while its upstream is un-decomposed. Phase 1 is shipped, Phase 2
  // is deferred on un-decomposed Plan-099, Phase 3 is eligible. The walk must
  // skip 1 (shipped) + 2 (precondition unmet) and land on 3 — proving the
  // cross-plan resolve surfaces as a soft `preconditions` skip, not a halt.
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(skillMd, `---\nname: test\nrequires_files: []\n---\n\nbody`);
  // Un-decomposed upstream: no manifest → plan_unshipped(99) resolves unmet.
  writeFileSync(
    join(repo, "docs", "plans", "099-upstream.md"),
    `# Plan-099\n\nUn-decomposed; no shipment manifest.\n`,
  );
  const planFile = join(repo, "docs", "plans", "001-test.md");
  writeFileSync(
    planFile,
    `# Plan-001

## Preconditions

- [x] **Plan-readiness audit complete per runbook.

### Phase 1 — Shipped bootstrap

**Precondition:** None.

#### Tasks

##### T1.1 — desc
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-1

### Phase 2 — Deferred surface (Tier 6)

**Precondition:** Phase 1 merged AND [Plan-099](./099-upstream.md) Tier 6 ships the widget factory.

#### Tasks

##### T2.1 — desc
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-2

### Phase 3 — Eligible next

**Precondition:** None.

#### Tasks

##### T3.1 — desc
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-3

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 1
    task: T1.1
    pr: 1
    sha: abc1234
    merged_at: 2026-01-01
    files: []
    verifies_invariant: []
    spec_coverage: []
\`\`\`

### Notes
${SYNTHETIC_PLAN_INVARIANTS}`,
  );
  const r = runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
  assert.equal(r.exit, 0, `exit was ${r.exit}; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.equal(r.stdout, "3");
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
  // Top-level Gate 2 is now lenient (passes on EITHER checkbox OR any
  // audit_status YAML). When both are missing the halt message names the
  // per-phase fallback path; assert on the new wording.
  assert.match(r.stdout, /audit-complete gate failed/);
});

test("runPreflight enforces a last-phase prose precondition despite the Progress-Log manifest (regression: last-phase gate no-op)", () => {
  // Before the fix: extractPhaseSection bounded the last phase at EOF and
  // swallowed the ## Progress Log Shipment Manifest; parsePreconditionsBlock
  // returned [] for that non-preconditions block, so gatePreconditions skipped
  // the prose **Precondition:** and vacuously passed (exit 0). Phase 1 is
  // unshipped here, so the last phase's `Phase 1 merged` precondition is unmet
  // and explicit-phase mode must HALT instead of falsely reporting eligible.
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

#### Tasks

##### T1.1 — desc
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-1

### Phase 2 — Renderer (last phase)

**Precondition:** Phase 1 merged.

#### Tasks

##### T2.1 — desc
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-2

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped: []
\`\`\`

### Notes
${SYNTHETIC_PLAN_INVARIANTS}`,
  );
  const r = runPreflight(planFile, 2, { repoRoot: repo, skillMd });
  assert.equal(r.exit, 1, `exit was ${r.exit}; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stdout, /precondition unmet/i);
  assert.match(r.stdout, /Phase 1/);
});

test("runPreflight enforces a prose precondition when a non-preconditions yaml block sits in the (non-last) phase body", () => {
  // Plan-002 Phase 2 shape: a yaml schema example inside a phase body must not
  // suppress that phase's prose **Precondition:** by being mistaken for a
  // (vacuous) preconditions block. Phase 1 is unshipped, so Phase 2's
  // `Phase 1 merged` precondition is unmet and explicit-phase mode must HALT.
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

#### Tasks

##### T1.1 — desc
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-1

### Phase 2 — Middle phase with a schema example

**Precondition:** Phase 1 merged.

The capability payload shape:

\`\`\`yaml
capabilities:
  - key: gpu
\`\`\`

#### Tasks

##### T2.1 — desc
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-2

### Phase 3 — Tail

**Precondition:** None.

#### Tasks

##### T3.1 — desc
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-3

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped: []
\`\`\`

### Notes
${SYNTHETIC_PLAN_INVARIANTS}`,
  );
  const r = runPreflight(planFile, 2, { repoRoot: repo, skillMd });
  assert.equal(r.exit, 1, `exit was ${r.exit}; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stdout, /precondition unmet/i);
  assert.match(r.stdout, /Phase 1/);
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
${SYNTHETIC_PLAN_INVARIANTS}`,
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

test("runPreflight no-eligible aggregate carries each phase's full halt detail", () => {
  // The aggregate is the ONLY halt an auto-mode run prints when no phase is
  // eligible. Pre-fix it kept just `r.halt.split("\n")[0]` per phase — the
  // generic `## Preflight halt: phase precondition unmet` header — so every
  // Gate 5 detail (failing yaml entry, unchecked/orphaned box lines, the
  // remediation prose) was unreachable in exactly the mode the skill runs
  // first. Phase 1 is fully shipped (legitimate silent skip); Phase 2 fails
  // the checkbox leg, and its box text + remediation must survive into the
  // aggregate, with the redundant per-phase header stripped.
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
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-1

### Phase 2 — Next

**Preconditions.**

- [ ] Plan-042 Phase 9 merged — upstream contract landing

\`\`\`yaml
preconditions: []
\`\`\`

#### Tasks

##### T2.1 — desc
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-2

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 1
    task: T1.1
    pr: 6
    sha: ca22530
    merged_at: 2026-04-27
    files: []
    verifies_invariant: []
    spec_coverage: []
\`\`\`

### Notes
${SYNTHETIC_PLAN_INVARIANTS}`,
  );
  const r = runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
  assert.equal(r.exit, 1);
  assert.match(r.stdout, /no eligible un-shipped phase/);
  assert.match(r.stdout, /Phase 2 \(preconditions\):/);
  assert.match(r.stdout, /unchecked precondition box/);
  assert.match(r.stdout, /Plan-042 Phase 9 merged — upstream contract landing/);
  assert.match(r.stdout, /Tick a box only when the work it names has landed/);
  // The per-phase `## Preflight halt:` header is stripped — the old truncated
  // shape put it (and nothing else) on the bullet line.
  assert.doesNotMatch(r.stdout, /\(preconditions\): ##/);
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
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-1

### Phase 2 — Next

**Precondition:** None.

\`\`\`yaml
preconditions: []
\`\`\`

#### Tasks

##### T2.1 — desc
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-2
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

test("runPreflight halts loudly in auto-walk mode when an earlier phase fails G4 cites", () => {
  // Audit-class failures (Gate 2 per-phase checkbox, Gate 4 cite-format)
  // reflect upstream author defects. Pre-fix, `reason: "audit"` was in the
  // silent-skip set: the loop pushed the phase onto `skipped[]` and tried
  // the next phase, which could land on a later phase that passed its own
  // gates — masking the earlier defect (this is exactly how Plan-002 Phase
  // 2 became eligible on develop while Phase 1's T1.1 cite was malformed).
  // Post-fix, `audit` is in the strict-halt set alongside manifest-class
  // failures; auto-walk surfaces the first audit-failed phase verbatim.
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(skillMd, `---\nname: test\nrequires_files: []\n---\n\nbody`);
  const planFile = join(repo, "docs", "plans", "001-test.md");
  writeFileSync(
    planFile,
    `# Plan-001

## Preconditions

- [x] **Plan-readiness audit complete per runbook.

### Phase 1 — Missing Cites

(this phase has no Tasks block at all — Gate 4 halts on missing cites)

### Phase 2 — Would Otherwise Pass

**Precondition:** None.

\`\`\`yaml
preconditions: []
\`\`\`

#### Tasks

##### T2.1 — desc
**Spec coverage:** Spec-001 line 1 **Verifies invariant:** I-001-2

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped: []
\`\`\`

### Notes
${SYNTHETIC_PLAN_INVARIANTS}`,
  );
  const r = runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
  assert.equal(
    r.exit,
    1,
    `auto-walk must halt on Phase 1's G4 failure rather than skip to Phase 2 (got exit=${r.exit}, stdout=${r.stdout})`,
  );
  assert.match(r.stdout, /missing G4 cites/, "halt message must surface the G4 failure verbatim");
  assert.doesNotMatch(
    r.stdout,
    /no eligible un-shipped phase/,
    "auto-walk must not fall through to the terminal no-eligible message",
  );
});

// ---------- extractTasksBlock (factored from extractDeclaredTaskIds) ----------

test("extractTasksBlock returns block content without heading", () => {
  const sec = `### Phase 1 — Bootstrap

#### Tasks

- **T-001-1** (Files: a.ts) — first
- **T-001-2** (Files: b.ts) — second

### Phase 2`;
  const block = extractTasksBlock(sec);
  assert.match(block, /T-001-1/);
  assert.match(block, /T-001-2/);
  assert.doesNotMatch(block, /^#### Tasks/m);
});

test("extractTasksBlock returns null when no Tasks block", () => {
  assert.equal(extractTasksBlock("### Phase 1 — Bootstrap\n\nNo tasks here."), null);
});

test("extractTasksBlock drops fenced example rows, keeping real indented ones", () => {
  // A ```markdown block demonstrating the row shape is illustration, not
  // declared work. Read raw, the example ids reach Gate 3's shipped-task
  // comparison (a phantom id makes a shipped phase read unshipped) and
  // classifyPhaseSize (an S phase inflates to M, demoting G4 findings). The
  // indented example is the shape the whitespace-tolerant bullet anchor newly
  // admitted; the column-0 one was already reachable (Codex P2, PR #262 r4).
  const sec = `### Phase 1 — Bootstrap

#### Tasks

- **T1.1 — real row** (Files: packages/a/src/x.ts)
  - **T-001r-1-2 (slice a) — real indented sub-slice** (Files: packages/a/src/y.ts)

Authors write rows like this:

\`\`\`markdown
- **T9.9 — illustrative row**
    - **T9.8 — indented illustrative row**
\`\`\`

### Phase 2`;
  // The real indented row is NOT collateral damage: a list indent is not a
  // structural region, so only fenced/raw-HTML/multi-line-span text is masked.
  const declared = extractDeclaredTaskIds(sec);
  assert.deepEqual(declared, ["T-001r-1-2", "T1.1"]);
  // The gating consequence, both sides: two real tasks in one package root is
  // an M phase; the four-id set the raw scan produced classified L, which is a
  // different reviewer set and a different G4 strictness.
  const paths = ["packages/a/src/x.ts", "packages/a/src/y.ts"];
  assert.equal(classifyPhaseSize(declared, paths), "M");
  assert.equal(classifyPhaseSize([...declared, "T9.8", "T9.9"], paths), "L");
});

test("extractTasksBlock ignores a fenced `#### Tasks` heading", () => {
  // The block slicer is a plain regex, so a fenced example of the heading
  // itself opened a phantom block whose contents were read as declared work.
  const sec = `### Phase 1 — Bootstrap

#### Tasks

- **T1.1 — real row** (Files: a.ts)

The audit emits:

\`\`\`markdown
#### Tasks

- **T9.9 — illustrative row**
\`\`\`

### Phase 2`;
  assert.deepEqual(extractDeclaredTaskIds(sec), ["T1.1"]);
});

// ---------- extractSection5 (cross-plan-deps §5 scoping) ----------

test("extractSection5 slices §5 from `## 5. Canonical Build Order` heading", () => {
  const src = `# Cross-Plan Dependencies

## 4. Plans With No Inter-Plan Dependencies

prose 4

## 5. Canonical Build Order

prose 5
### Plan-023 Substrate-vs-Namespace Carve-Out (Tier 1 / Tier 8)

carve-out body

## 6. Active Next Steps DAG

prose 6`;
  const s5 = extractSection5(src);
  assert.match(s5, /Canonical Build Order/);
  assert.match(s5, /Plan-023 Substrate-vs-Namespace Carve-Out/);
  assert.doesNotMatch(s5, /prose 4/);
  assert.doesNotMatch(s5, /prose 6/);
});

test("extractSection5 handles `## Section 5 — ...` defensive alternative", () => {
  const src = `## 4. Foo

prose 4

## Section 5 — Canonical Build Order

prose 5

## 6. After`;
  const s5 = extractSection5(src);
  assert.match(s5, /Section 5/);
  assert.match(s5, /prose 5/);
});

test("extractSection5 returns null when §5 missing", () => {
  assert.equal(extractSection5("## 4. Foo\n\nprose\n\n## 6. After"), null);
});

// ---------- gateAuditCheckbox: lenient top-level (post per-phase migration) ----------

test("gateAuditCheckbox passes on `type: audit_status` anywhere in plan (no checkbox needed)", () => {
  const planSrc = `# Plan-023

## Preconditions

- [ ] **Plan-readiness audit complete

### Phase 1

\`\`\`yaml
preconditions:
  - { type: audit_status, status: substrate_exempt, carve_out_ref: "X" }
\`\`\`
`;
  const r = gateAuditCheckbox(planSrc, "/plan-023.md");
  assert.equal(r.ok, true);
});

test("gateAuditCheckbox fails when neither checkbox nor audit_status YAML present", () => {
  const planSrc = `# Plan-XX

## Preconditions

- [ ] **Plan-readiness audit complete

### Phase 1

(no preconditions block)
`;
  const r = gateAuditCheckbox(planSrc, "/plan-XX.md");
  assert.equal(r.ok, false);
  assert.match(r.halt, /audit-complete gate failed/);
});

// ---------- gatePhaseAuditCheckbox: strict per-phase (new) ----------

test("gatePhaseAuditCheckbox passes when target phase declares audit_status", () => {
  const planSrc = `### Phase 1 — A
\`\`\`yaml
preconditions:
  - { type: audit_status, status: substrate_exempt, carve_out_ref: "X" }
\`\`\`
### Phase 2 — B
(no audit_status)`;
  const phase1 = `### Phase 1 — A
\`\`\`yaml
preconditions:
  - { type: audit_status, status: substrate_exempt, carve_out_ref: "X" }
\`\`\``;
  const r = gatePhaseAuditCheckbox(planSrc, phase1, "/p.md", 1);
  assert.equal(r.ok, true);
});

test("gatePhaseAuditCheckbox passes via plan-level checkbox even when target phase has no audit_status", () => {
  const planSrc = `- [x] **Plan-readiness audit complete
### Phase 1 — A
(no audit_status)`;
  const phase1 = `### Phase 1 — A
(no audit_status)`;
  const r = gatePhaseAuditCheckbox(planSrc, phase1, "/p.md", 1);
  assert.equal(r.ok, true);
});

test("gatePhaseAuditCheckbox fails when target phase has no audit_status and plan has no checkbox", () => {
  const planSrc = `### Phase 1 — A
\`\`\`yaml
preconditions:
  - { type: audit_status, status: substrate_exempt, carve_out_ref: "X" }
\`\`\`
### Phase 2 — B
(no audit_status here either)`;
  const phase2 = `### Phase 2 — B
(no audit_status here either)`;
  const r = gatePhaseAuditCheckbox(planSrc, phase2, "/p.md", 2);
  assert.equal(r.ok, false);
  assert.match(r.halt, /per-phase audit declaration missing/);
  // Phase name may be wrapped across a line break in the prose; match
  // tolerantly across whitespace.
  assert.match(r.halt, /Phase\s+2/);
});

// ---------- cross_plan_carve_out with §5 scoping (closes the loose-match defect) ----------

test("cross_plan_carve_out passes when ref present in §5", () => {
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "architecture", "cross-plan-dependencies.md"),
    `## 4. Foo

prose

## 5. Canonical Build Order

### Plan-023 Substrate-vs-Namespace Carve-Out (Tier 1 / Tier 8)

body

## 6. After`,
  );
  const r = resolvePrecondition(
    { type: "cross_plan_carve_out", ref: "Plan-023 Substrate-vs-Namespace Carve-Out" },
    { repoRoot: repo },
  );
  assert.equal(r.ok, true);
});

test("cross_plan_carve_out fails when ref appears outside §5 but not inside", () => {
  // Regression test for the pre-fix loose-match defect: bare
  // `source.includes(ref)` passed when the ref appeared in §3 prose or
  // §6 NS-rows even if §5 had no entry.
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "architecture", "cross-plan-dependencies.md"),
    `## 5. Canonical Build Order

(no carve-out entries)

## 6. Active Next Steps DAG

### NS-03: Plan-023-partial Tier 1 — Plan-023 Substrate-vs-Namespace Carve-Out

(ref appears here outside §5)`,
  );
  const r = resolvePrecondition(
    { type: "cross_plan_carve_out", ref: "Plan-023 Substrate-vs-Namespace Carve-Out" },
    { repoRoot: repo },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /not present in cross-plan-dependencies\.md §5/);
});

test("cross_plan_carve_out fails when cross-plan-dependencies.md has no §5", () => {
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "architecture", "cross-plan-dependencies.md"),
    `## 4. Foo\n\n## 6. After`,
  );
  const r = resolvePrecondition({ type: "cross_plan_carve_out", ref: "X" }, { repoRoot: repo });
  assert.equal(r.ok, false);
  assert.match(r.halt, /no §5/);
});

// ---------- audit_status: complete ----------

test("audit_status: complete passes (declaration is the load-bearing assertion)", () => {
  const r = resolvePrecondition({
    type: "audit_status",
    status: "complete",
    evidence_pr: 15,
    baseline_tag: "plan-readiness-audit-tier-1",
  });
  assert.equal(r.ok, true);
});

// ---------- audit_status: substrate_exempt ----------

const SUBSTRATE_XPLAN_FIXTURE = `## 5. Canonical Build Order

### Plan-023 Substrate-vs-Namespace Carve-Out (Tier 1 / Tier 8)

substrate carve-out body

## 6. After`;

const SUBSTRATE_PHASE_FIXTURE = `### Phase 1 — Workspace Substrate

**Spec-023 AC coverage.** Phase 1 covers no Spec-023 acceptance criteria — the substrate is pre-behavior plumbing.

\`\`\`yaml
preconditions:
  - { type: audit_status, status: substrate_exempt, carve_out_ref: "Plan-023 Substrate-vs-Namespace Carve-Out" }
\`\`\`

#### Tasks

- **T-023p-1-1** (Files: a.ts; Verifies invariant: none — substrate scaffold) — desc
- **T-023p-1-2** (Files: b.ts; Verifies invariant: none — toolchain) — desc
`;

function repoWithXplan(xplanSource) {
  const repo = makeTempRepo();
  writeFileSync(join(repo, "docs", "architecture", "cross-plan-dependencies.md"), xplanSource);
  return repo;
}

test("audit_status: substrate_exempt passes when §5 ref + sentinel + no bracket-form Spec coverage", () => {
  const repo = repoWithXplan(SUBSTRATE_XPLAN_FIXTURE);
  const r = resolvePrecondition(
    {
      type: "audit_status",
      status: "substrate_exempt",
      carve_out_ref: "Plan-023 Substrate-vs-Namespace Carve-Out",
    },
    { repoRoot: repo, phaseSection: SUBSTRATE_PHASE_FIXTURE, phaseNumber: 1 },
  );
  assert.equal(r.ok, true, `halt: ${r.halt}`);
});

test("audit_status: substrate_exempt tolerates a FENCED bracket-form Spec coverage cite", () => {
  // The sibling-consistency check scans the Tasks block for bracket-form
  // `Spec coverage: [...]` and halts on a hit. Read raw, a fenced example row
  // carrying one halts a phase that declares no Spec AC anywhere in its real
  // rows — the fence-blindness class failing in the opposite direction from the
  // phantom task ids (Codex P2, PR #262 round 4).
  const repo = repoWithXplan(SUBSTRATE_XPLAN_FIXTURE);
  const phaseWithFencedCite = `${SUBSTRATE_PHASE_FIXTURE}
Row shape, for reference:

\`\`\`markdown
- **T-023p-1-9** (Files: z.ts; Spec coverage: [Spec-023 row 4]) — example only
\`\`\`
`;
  const r = resolvePrecondition(
    {
      type: "audit_status",
      status: "substrate_exempt",
      carve_out_ref: "Plan-023 Substrate-vs-Namespace Carve-Out",
    },
    { repoRoot: repo, phaseSection: phaseWithFencedCite, phaseNumber: 1 },
  );
  assert.equal(r.ok, true, `halt: ${r.halt}`);
});

test("audit_status: substrate_exempt still halts on a REAL bracket-form Spec coverage cite", () => {
  // Negative control for the test above: masking must not have blinded the
  // check to the unfenced cite it exists to catch.
  const repo = repoWithXplan(SUBSTRATE_XPLAN_FIXTURE);
  const phaseWithRealCite = `${SUBSTRATE_PHASE_FIXTURE}- **T-023p-1-9** (Files: z.ts; Spec coverage: [Spec-023 row 4]) — real row
`;
  const r = resolvePrecondition(
    {
      type: "audit_status",
      status: "substrate_exempt",
      carve_out_ref: "Plan-023 Substrate-vs-Namespace Carve-Out",
    },
    { repoRoot: repo, phaseSection: phaseWithRealCite, phaseNumber: 1 },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /conflicts with Tasks-block Spec coverage cites/);
});

test("audit_status: substrate_exempt fails when carve_out_ref missing", () => {
  const repo = repoWithXplan(SUBSTRATE_XPLAN_FIXTURE);
  const r = resolvePrecondition(
    { type: "audit_status", status: "substrate_exempt" },
    { repoRoot: repo, phaseSection: SUBSTRATE_PHASE_FIXTURE, phaseNumber: 1 },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /not found within §5 scope/);
});

test("audit_status: substrate_exempt fails when carve_out_ref not in §5", () => {
  const repo = repoWithXplan(SUBSTRATE_XPLAN_FIXTURE);
  const r = resolvePrecondition(
    {
      type: "audit_status",
      status: "substrate_exempt",
      carve_out_ref: "Plan-999 Phantom Carve-Out",
    },
    { repoRoot: repo, phaseSection: SUBSTRATE_PHASE_FIXTURE, phaseNumber: 1 },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /not found within §5 scope/);
});

test("audit_status: substrate_exempt fails when Spec-AC-empty sentinel missing from phase body", () => {
  const repo = repoWithXplan(SUBSTRATE_XPLAN_FIXTURE);
  const phaseNoSentinel = `### Phase 1 — Workspace Substrate

(no canonical sentinel here)

\`\`\`yaml
preconditions:
  - { type: audit_status, status: substrate_exempt, carve_out_ref: "Plan-023 Substrate-vs-Namespace Carve-Out" }
\`\`\`
`;
  const r = resolvePrecondition(
    {
      type: "audit_status",
      status: "substrate_exempt",
      carve_out_ref: "Plan-023 Substrate-vs-Namespace Carve-Out",
    },
    { repoRoot: repo, phaseSection: phaseNoSentinel, phaseNumber: 1 },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /'covers no Spec-NNN acceptance criteria'/);
});

test("audit_status: substrate_exempt fails when Tasks block has bracket-form Spec coverage", () => {
  const repo = repoWithXplan(SUBSTRATE_XPLAN_FIXTURE);
  const phaseWithConflict = `### Phase 1 — Workspace Substrate

**Spec-023 AC coverage.** Phase 1 covers no Spec-023 acceptance criteria — the substrate is pre-behavior plumbing.

\`\`\`yaml
preconditions:
  - { type: audit_status, status: substrate_exempt, carve_out_ref: "Plan-023 Substrate-vs-Namespace Carve-Out" }
\`\`\`

#### Tasks

- **T-1** (Spec coverage: [Spec-023 row 4]; Verifies invariant: I-023-1) — desc
`;
  const r = resolvePrecondition(
    {
      type: "audit_status",
      status: "substrate_exempt",
      carve_out_ref: "Plan-023 Substrate-vs-Namespace Carve-Out",
    },
    { repoRoot: repo, phaseSection: phaseWithConflict, phaseNumber: 1 },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /conflicts with Tasks-block Spec coverage cites/);
  assert.match(r.halt, /Spec-023 row 4/);
});

test("audit_status: substrate_exempt tolerates prose-form `Spec coverage:` (no brackets) in Tasks", () => {
  // Plan-008 Phase 1's Tasks use prose-form `Spec coverage: per F-008b-1-06,
  // NO Spec-008 AC at Tier 1` — that describes coverage *absence* and is not
  // a bracketed affirmative cite. The substrate_exempt check must not flag it.
  const repo = repoWithXplan(`## 5. Canonical Build Order

### Plan-008 Bootstrap-vs-Remainder Carve-Out (Tier 1 / Tier 5)

body

## 6. After`);
  const phase = `### Phase 1 — Bootstrap

**Spec-008 AC coverage.** Phase 1 covers NO Spec-008 AC at Tier 1.

\`\`\`yaml
preconditions:
  - { type: audit_status, status: substrate_exempt, carve_out_ref: "Plan-008 Bootstrap-vs-Remainder Carve-Out" }
\`\`\`

#### Tasks

- **T-008b-1-1** (Files: a.ts; Verifies invariant: I-008-1; Spec coverage: per F-008b-1-06, NO Spec-008 AC at Tier 1) — desc
`;
  const r = resolvePrecondition(
    {
      type: "audit_status",
      status: "substrate_exempt",
      carve_out_ref: "Plan-008 Bootstrap-vs-Remainder Carve-Out",
    },
    { repoRoot: repo, phaseSection: phase, phaseNumber: 1 },
  );
  assert.equal(r.ok, true, `halt: ${r.halt}`);
});

test("audit_status fails on unknown status value", () => {
  const r = resolvePrecondition({ type: "audit_status", status: "tier_pending" });
  assert.equal(r.ok, false);
  assert.match(r.halt, /must be 'complete' or 'substrate_exempt'/);
});

// ---------- bl_closed (backlog gate for amendment-blocked phases) ----------

test("bl_closed passes when the BL is `completed` in the active backlog", () => {
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "backlog.md"),
    `# Backlog

### BL-140: Some amendment

- Status: \`completed\`
- Priority: \`P2\`

---
`,
  );
  const r = resolvePrecondition({ type: "bl_closed", ref: 140 }, { repoRoot: repo });
  assert.equal(r.ok, true);
});

test("bl_closed fails (fail-closed) when the BL is `blocked` in the active backlog", () => {
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "backlog.md"),
    `### BL-140: Some amendment

- Status: \`blocked\` (until the Spec-003 amendment lands)
- Priority: \`P2\`
`,
  );
  const r = resolvePrecondition({ type: "bl_closed", ref: 140 }, { repoRoot: repo });
  assert.equal(r.ok, false);
  assert.match(r.halt, /BL-140 is 'blocked' .* not 'completed'/);
});

test("bl_closed fails when the BL is `todo` in the active backlog", () => {
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "backlog.md"),
    `### BL-140: Some amendment\n\n- Status: \`todo\`\n`,
  );
  const r = resolvePrecondition({ type: "bl_closed", ref: 140 }, { repoRoot: repo });
  assert.equal(r.ok, false);
  assert.match(r.halt, /BL-140 is 'todo'/);
});

test("bl_closed passes when the BL is absent from active but present in the archive (swept == closed)", () => {
  const repo = makeTempRepo();
  writeFileSync(join(repo, "docs", "backlog.md"), `# Backlog\n\n(no active items)\n`);
  mkdirSync(join(repo, "docs", "archive"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "archive", "backlog-archive.md"),
    `#### BL-140: Some amendment\n\n- Status: \`completed\`\n`,
  );
  const r = resolvePrecondition({ type: "bl_closed", ref: 140 }, { repoRoot: repo });
  assert.equal(r.ok, true);
});

test("bl_closed fails when the archived item is `withdrawn` (archive is not completed-only)", () => {
  // Regression for Codex P2 on PR #138: the archive is not a completed-only
  // location (e.g. BL-136 is `withdrawn` there), so heading presence in the
  // archive must not unblock — the Status is re-judged with active-path rigor.
  const repo = makeTempRepo();
  writeFileSync(join(repo, "docs", "backlog.md"), `# Backlog\n\n(no active items)\n`);
  mkdirSync(join(repo, "docs", "archive"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "archive", "backlog-archive.md"),
    `#### BL-140: Some amendment (Withdrawn)\n\n- Status: \`withdrawn\`\n`,
  );
  const r = resolvePrecondition({ type: "bl_closed", ref: 140 }, { repoRoot: repo });
  assert.equal(r.ok, false);
  assert.match(r.halt, /BL-140 is 'withdrawn' in the archive .*not 'completed'/);
});

test("bl_closed fails when an archived item has no parseable Status (fail-closed)", () => {
  const repo = makeTempRepo();
  writeFileSync(join(repo, "docs", "backlog.md"), `# Backlog\n\n(no active items)\n`);
  mkdirSync(join(repo, "docs", "archive"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "archive", "backlog-archive.md"),
    `#### BL-140: Some amendment\n\n- Owner: \`unassigned\`\n`,
  );
  const r = resolvePrecondition({ type: "bl_closed", ref: 140 }, { repoRoot: repo });
  assert.equal(r.ok, false);
  assert.match(
    r.halt,
    /BL-140 found in docs\/archive\/backlog-archive\.md but its Status line is unparseable/,
  );
});

test("bl_closed fails when the BL is missing from both backlog and archive (unknown == fail-closed)", () => {
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "backlog.md"),
    `# Backlog\n\n### BL-139: Other\n\n- Status: \`todo\`\n`,
  );
  const r = resolvePrecondition({ type: "bl_closed", ref: 140 }, { repoRoot: repo });
  assert.equal(r.ok, false);
  assert.match(r.halt, /BL-140 not found/);
});

test("bl_closed fails when docs/backlog.md is unreadable (fail-closed)", () => {
  // makeTempRepo does NOT write docs/backlog.md — the read throws ENOENT.
  const repo = makeTempRepo();
  const r = resolvePrecondition({ type: "bl_closed", ref: 140 }, { repoRoot: repo });
  assert.equal(r.ok, false);
  assert.match(r.halt, /backlog\.md unreadable/);
});

test("bl_closed fail-closes when BL-NNN appears only as a cross-reference (heading-scoped)", () => {
  // BL-140 appears ONLY as a link inside BL-131's prose; it has no heading of
  // its own. The resolver must treat it as not-found, never read a neighbor's
  // `completed` status as BL-140's.
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "backlog.md"),
    `### BL-131: Renderer coverage

- Status: \`completed\`
- Summary: sibling of [BL-140](#bl-140) — do not confuse.
`,
  );
  const r = resolvePrecondition({ type: "bl_closed", ref: 140 }, { repoRoot: repo });
  assert.equal(r.ok, false);
  assert.match(r.halt, /BL-140 not found/);
});

test("extractBacklogItemSection is heading-anchored, not substring (cross-ref → null)", () => {
  const src = `### BL-131: Renderer coverage

- Status: \`completed\`
- Summary: sibling of [BL-140](#bl-140) — do not confuse.
`;
  assert.equal(extractBacklogItemSection(src, "BL-140"), null);
});

test("extractBacklogItemSection rejects longer-number collisions (BL-140 ≠ BL-1400)", () => {
  const src = `### BL-1400: Decoy\n\n- Status: \`completed\`\n`;
  assert.equal(extractBacklogItemSection(src, "BL-140"), null);
});

test("bl_closed zero-pads the ref to match BL-0NN headings", () => {
  const repo = makeTempRepo();
  writeFileSync(
    join(repo, "docs", "backlog.md"),
    `### BL-099: Padded\n\n- Status: \`completed\`\n`,
  );
  const r = resolvePrecondition({ type: "bl_closed", ref: 99 }, { repoRoot: repo });
  assert.equal(r.ok, true);
});

// ---------- precondition_box_checked (named scoped §Preconditions boxes — Codex r4, PR #212) ----------

const BOX_PLAN_SOURCE = [
  "# Plan-012 — Approvals",
  "",
  "## Preconditions",
  "",
  "- [x] Paired spec is approved.",
  "- [ ] **Driver-ask expiry leg authored (Part-B fail-closed follow-up, 2026-07-17):** T2.8 is authored by the B13 bundle, which checks this box.",
  "- [x] **Ratified thing done:** dated note appended after the box text.",
  "",
  "## Decisions",
  "",
  "- [ ] **Driver-ask expiry leg authored decoy outside the Preconditions section**",
].join("\n");

test("precondition_box_checked halts on an unchecked box, verbatim line included", () => {
  const r = resolvePrecondition(
    { type: "precondition_box_checked", box: "Driver-ask expiry leg authored" },
    { planSource: BOX_PLAN_SOURCE },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /is unchecked/);
  assert.match(r.halt, /Driver-ask expiry leg authored \(Part-B/);
});

test("precondition_box_checked passes on a checked box (bold marker + note-suffix prefix match)", () => {
  const r = resolvePrecondition(
    { type: "precondition_box_checked", box: "Ratified thing done" },
    { planSource: BOX_PLAN_SOURCE },
  );
  assert.equal(r.ok, true);
});

test("precondition_box_checked scopes to ## Preconditions — a same-prefix box in a later section is invisible", () => {
  // The decoy under ## Decisions must neither rescue the lookup nor trip the
  // ambiguity halt; only the section's own box is seen.
  const r = resolvePrecondition(
    { type: "precondition_box_checked", box: "Driver-ask expiry leg authored" },
    { planSource: BOX_PLAN_SOURCE },
  );
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.halt, /matches 2 boxes/);
});

test("precondition_box_checked fails closed when no box matches the prefix", () => {
  const r = resolvePrecondition(
    { type: "precondition_box_checked", box: "Nonexistent gate" },
    { planSource: BOX_PLAN_SOURCE },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /no `## Preconditions` box starts with/);
});

test("precondition_box_checked fails closed on an ambiguous prefix", () => {
  const source = BOX_PLAN_SOURCE.replace(
    "- [x] **Ratified thing done:** dated note appended after the box text.",
    [
      "- [x] **Ratified thing done:** dated note appended after the box text.",
      "- [ ] **Ratified thing done twice over:** duplicate-prefix sibling.",
    ].join("\n"),
  );
  const r = resolvePrecondition(
    { type: "precondition_box_checked", box: "Ratified thing done" },
    { planSource: source },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /matches 2 boxes/);
});

test("precondition_box_checked fails closed when the plan has no ## Preconditions section", () => {
  const r = resolvePrecondition(
    { type: "precondition_box_checked", box: "Anything" },
    { planSource: "# Plan\n\n## Tasks\n\n- **T1.1** stub\n" },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /no `## Preconditions` section/);
});

test("precondition_box_checked fails closed on an empty box field and on missing planSource", () => {
  const empty = resolvePrecondition(
    { type: "precondition_box_checked", box: "" },
    { planSource: BOX_PLAN_SOURCE },
  );
  assert.equal(empty.ok, false);
  assert.match(empty.halt, /must be a non-empty string/);
  const missing = resolvePrecondition({ type: "precondition_box_checked", box: "X" }, {});
  assert.equal(missing.ok, false);
  assert.match(missing.halt, /plan source unavailable/);
});

test("gatePreconditions threads planSource so a YAML box entry gates the phase", () => {
  const phaseSection = [
    "### Phase 2 — Daemon services",
    "",
    "```yaml",
    "preconditions:",
    '  - { type: precondition_box_checked, box: "Driver-ask expiry leg authored" }',
    "```",
    "",
    "#### Tasks",
    "",
    "- **T2.1** stub",
  ].join("\n");
  const r = gatePreconditions(phaseSection, "docs/plans/012-x.md", 2, {
    planSource: BOX_PLAN_SOURCE,
  });
  assert.equal(r.ok, false);
  assert.match(r.halt, /phase precondition unmet/);
  assert.match(r.halt, /is unchecked/);
});

// ---------- Gate 5 plural-prose checkbox fallback (PR #251 round 2) ----------
//
// `**Preconditions.**` over a checkbox list is the corpus's dominant form and
// matched no recognized shape, so Gate 5 accepted the phase as a legacy plan.
// The scan below the header closes that; these pin both the new halt and the
// three paths that must NOT change behavior.

const PLURAL_HEADER_PHASE = [
  "### Phase 2 — Daemon services",
  "",
  "**Goal.** Ship the services.",
  "",
  "**Preconditions.**",
  "",
  "- [ ] Plan-006 Phase 3 merged (Tier 4 — `EventLogService.append` sole append path)",
  "- [x] Schema amendments ratified — local-sqlite-schema.md (D-009-7, this audit)",
  "",
  "#### Tasks",
  "",
  "- **T2.1** stub",
].join("\n");

test("gatePreconditions halts on an unchecked box under a plural **Preconditions.** header", () => {
  const r = gatePreconditions(PLURAL_HEADER_PHASE, "docs/plans/009-x.md", 2);
  assert.equal(r.ok, false);
  assert.match(r.halt, /phase precondition unmet/);
  assert.match(r.halt, /Plan docs\/plans\/009-x\.md Phase 2 has 1 unchecked precondition box:/);
  assert.match(r.halt, /- \[ \] Plan-006 Phase 3 merged/);
  // The ticked sibling is not reported as owed work.
  assert.doesNotMatch(r.halt, /Schema amendments ratified/);
});

test("gatePreconditions accepts a plural **Preconditions.** header whose boxes are all ticked", () => {
  const r = gatePreconditions(
    PLURAL_HEADER_PHASE.replace("- [ ] Plan-006 Phase 3 merged", "- [x] Plan-006 Phase 3 merged"),
    "docs/plans/009-x.md",
    2,
  );
  assert.equal(r.ok, true);
});

test("gatePreconditions accepts the plural header's spelling variants and capital [X]", () => {
  for (const header of ["**Preconditions.**", "**Preconditions:**", "**Preconditions**"]) {
    const section = PLURAL_HEADER_PHASE.replace("**Preconditions.**", header);
    assert.equal(gatePreconditions(section, "docs/plans/009-x.md", 2).ok, false, header);
    const ticked = section.replace("- [ ] Plan-006", "- [X] Plan-006");
    assert.equal(gatePreconditions(ticked, "docs/plans/009-x.md", 2).ok, true, `${header} [X]`);
  }
});

const withYamlBlock = (phaseSection, ...entries) =>
  phaseSection.replace(
    "#### Tasks",
    [
      "<!-- prettier-ignore -->",
      "```yaml",
      "preconditions:",
      ...entries,
      "```",
      "",
      "#### Tasks",
    ].join("\n"),
  );

test("gatePreconditions halts on an unchecked box even when a YAML block resolves ok", () => {
  // The additive pin. Precedence here would retire the checkbox rows — including
  // the ratification boxes no entry type can express — so a later un-tick would
  // gate nothing.
  const phaseSection = withYamlBlock(
    PLURAL_HEADER_PHASE,
    '  - { type: precondition_box_checked, box: "Ratified thing done" }',
  );
  const r = gatePreconditions(phaseSection, "docs/plans/010-x.md", 5, {
    planSource: BOX_PLAN_SOURCE,
  });
  assert.equal(r.ok, false);
  assert.match(r.halt, /has 1 unchecked precondition box:/);
  assert.match(r.halt, /- \[ \] Plan-006 Phase 3 merged/);
});

test("gatePreconditions passes when the YAML resolves AND every box is ticked", () => {
  const phaseSection = withYamlBlock(
    PLURAL_HEADER_PHASE.replace("- [ ] Plan-006 Phase 3 merged", "- [x] Plan-006 Phase 3 merged"),
    '  - { type: precondition_box_checked, box: "Ratified thing done" }',
  );
  const r = gatePreconditions(phaseSection, "docs/plans/010-x.md", 5, {
    planSource: BOX_PLAN_SOURCE,
  });
  assert.equal(r.ok, true);
});

test("gatePreconditions reports BOTH legs when the YAML entry and a box both fail", () => {
  const phaseSection = withYamlBlock(
    PLURAL_HEADER_PHASE,
    '  - { type: precondition_box_checked, box: "Driver-ask expiry leg authored" }',
  );
  const r = gatePreconditions(phaseSection, "docs/plans/009-x.md", 2, {
    planSource: BOX_PLAN_SOURCE,
  });
  assert.equal(r.ok, false);
  assert.match(r.halt, /declares precondition:/);
  assert.match(r.halt, /is unchecked/);
  assert.match(r.halt, /has 1 unchecked precondition box:/);
  // One halt header, not one per leg.
  assert.equal(r.halt.match(/## Preflight halt/g).length, 1);
});

test("gatePreconditions keeps the singular **Precondition:** leg's behavior unchanged", () => {
  // Unparseable prose still resolves legacy free-form when no boxes exist...
  const prose = "**Precondition:** the usual understanding between the parties.";
  const noBoxes = [
    "### Phase 2 — Daemon services",
    "",
    prose,
    "",
    "#### Tasks",
    "",
    "- **T2.1** stub",
  ].join("\n");
  assert.equal(gatePreconditions(noBoxes, "docs/plans/009-x.md", 2).ok, true);
  // ...but the box leg still runs alongside it, because neither leg disables
  // the other. This is the one singular-path behavior the additive design changes.
  const withBoxes = PLURAL_HEADER_PHASE.replace(
    "**Preconditions.**",
    `${prose}\n\n**Preconditions.**`,
  );
  const r = gatePreconditions(withBoxes, "docs/plans/009-x.md", 2);
  assert.equal(r.ok, false);
  assert.match(r.halt, /has 1 unchecked precondition box:/);
});

test("gatePreconditions still accepts a phase declaring no precondition in any form", () => {
  const phaseSection = [
    "### Phase 1 — Contracts",
    "",
    "**Goal.** Ship the contracts.",
    "",
    "#### Tasks",
    "",
    "- **T1.1** stub",
  ].join("\n");
  assert.equal(gatePreconditions(phaseSection, "docs/plans/001-x.md", 1).ok, true);
  // A header with no boxes under it is equally undeclared.
  const emptyHeader = phaseSection.replace("#### Tasks", "**Preconditions.**\n\n#### Tasks");
  assert.equal(gatePreconditions(emptyHeader, "docs/plans/001-x.md", 1).ok, true);
});

test("gatePreconditions halts on the real Plan-009 Phase 2 pre-fix shape", () => {
  // Verbatim from Plan-009 before PR #251 added its YAML block: two unchecked
  // build-order boxes under two ratified ones. This phase resolved eligible.
  const phaseSection = [
    "### Phase 2 — RepoMount & workspace persistence + projections",
    "",
    "**Goal.** Ship the `repo_mounts` + `workspaces` migration.",
    "",
    "**Preconditions.**",
    "",
    "- [ ] Plan-009 Phase 1 merged (contracts in `packages/contracts/src/repo.ts` — branded IDs, unions, request/response Zod schemas, `RepoWorkspaceLifecyclePayloadSchema` + its state-parameterized factory, canonical-root resolver + trust-envelope validator)",
    "- [ ] Plan-006 Phase 3 merged (Tier 4 — `EventLogService.append` sole append path; Plan-006 Phase 1 T1.2 registry already carries the 6 Plan-009 event names). Plan-006 manifest is `shipped: []` as of this audit — build-order precondition, not a satisfied dependency.",
    "- [x] Schema amendments ratified — local-sqlite-schema.md §Workspace and Git Tables (D-009-7, this audit)",
    "- [x] Detach cascade semantics ratified — `Spec-009 §Detach Semantics (V1 Definition)` (D-009-6) — gates T2.3's detach surface only",
    "",
    "#### Tasks",
    "",
    "- **T2.1** stub",
  ].join("\n");
  const r = gatePreconditions(phaseSection, "docs/plans/009-x.md", 2);
  assert.equal(r.ok, false);
  assert.match(r.halt, /has 2 unchecked precondition boxes:/);
  assert.match(r.halt, /- \[ \] Plan-009 Phase 1 merged/);
  assert.match(r.halt, /- \[ \] Plan-006 Phase 3 merged/);
  // Long box lines are elided, so the halt stays scannable.
  assert.match(r.halt, /\.\.\.$/m);
});

test("gatePreconditions halts on the real Plan-010 Phase 5 shape (bare fence, mixed ticks)", () => {
  // Phase 5's own bullets are single physical lines, long enough to read as
  // paragraphs, and its YAML fence follows with no `<!-- prettier-ignore -->`
  // pragma — the one corpus block where the fence alone ends the region.
  const phaseSection = [
    "### Phase 5 — Turn-snapshot service",
    "",
    "**Goal.** The daemon-side turn-snapshot service.",
    "",
    "**Preconditions.**",
    "",
    "- [x] `Spec-010 §Turn-Boundary Snapshots` ratified — the B21 amendment (2026-07-06), re-promoted `approved` 2026-07-18 via the W1.5 batch gate, so the snapshot barrier and its epoch-namespaced ref layout are settled contract rather than in-flight design.",
    "- [ ] Phases 1 and 2 merged — Phase 1 for the execution-root contract shapes (the `run_execution_contexts` table + `executionRoot` carriers), Phase 2 for the `git/` service substrate this service composes onto.",
    "- [x] `<E>` execution-epoch source ratified — `Spec-004 §Required Behavior` (0 before any rollback, advanced with each accepted rewind).",
    "",
    "```yaml",
    "preconditions:",
    "  - { type: plan_phase, plan: 010, phase: 1, status: merged }",
    "```",
    "",
    "#### Tasks",
    "",
    "- **T5.1** stub",
    "- [ ] decoy box past the fence — must not be collected",
  ].join("\n");
  const r = gatePreconditions(phaseSection, "docs/plans/010-x.md", 5);
  assert.equal(r.ok, false);
  assert.match(r.halt, /has 1 unchecked precondition box:/);
  assert.match(r.halt, /- \[ \] Phases 1 and 2 merged/);
  assert.doesNotMatch(r.halt, /decoy/);
});

test("gatePreconditions treats indented lines as bullet continuations, not terminators", () => {
  // No corpus block wraps a bullet today; this pins that one which did would
  // keep its later boxes rather than silently dropping them.
  const phaseSection = [
    "### Phase 2 — Daemon services",
    "",
    "**Preconditions.**",
    "",
    "- [x] Something ratified",
    "  continuation line that belongs to the bullet above",
    "  **even one opening with bold markers**",
    "- [ ] Plan-006 Phase 3 merged",
    "",
    "#### Tasks",
  ].join("\n");
  const r = gatePreconditions(phaseSection, "docs/plans/009-x.md", 2);
  assert.equal(r.ok, false);
  assert.match(r.halt, /- \[ \] Plan-006 Phase 3 merged/);
});

test("gatePreconditions ends box collection at each prose break", () => {
  // A heading or bold paragraph opens a new prose context — a box beyond it is
  // neither collected nor an orphan.
  for (const [terminator, label] of [
    ["#### Tasks", "heading"],
    ["**Goal.** restated", "bold paragraph"],
  ]) {
    const phaseSection = [
      "### Phase 2 — Daemon services",
      "",
      "**Preconditions.**",
      "",
      "- [x] Something ratified",
      "",
      terminator,
      "- [ ] decoy box past the prose break",
    ].join("\n");
    assert.equal(gatePreconditions(phaseSection, "docs/plans/009-x.md", 2).ok, true, label);
  }
});

test("gatePreconditions halts on a box stranded below the yaml apparatus — even a ticked one", () => {
  // The fence and the prettier pragma SUSPEND the region rather than end it: a
  // box after either one is an orphaned layout defect (PR #251 inserted
  // Plan-009 Phase 3's yaml block mid-list and stranded two ticked boxes).
  // Checked orphans halt too — a ticked box below the fence is one un-tick
  // away from gating nothing, silently.
  for (const [apparatus, label] of [
    ["```yaml", "fenced-code opener"],
    ["<!-- prettier-ignore -->", "HTML comment"],
  ]) {
    for (const marker of ["x", " "]) {
      const phaseSection = [
        "### Phase 3 — Wire surface",
        "",
        "**Preconditions.**",
        "",
        "- [x] Something ratified",
        "",
        apparatus,
        `- [${marker}] stranded box below the apparatus`,
      ].join("\n");
      const r = gatePreconditions(phaseSection, "docs/plans/009-x.md", 3);
      assert.equal(r.ok, false, `${label} [${marker}]`);
      assert.match(r.halt, /has 1 orphaned precondition box stranded below the yaml fence:/);
      assert.match(r.halt, /stranded box below the apparatus/);
      assert.match(r.halt, /Move the stranded boxes above the fence/);
    }
  }
});

test("gatePreconditions reports a clean ticked list and an orphan independently", () => {
  // The real pre-repair Plan-009 Phase 3 shape: every collected box ticked, two
  // ticked boxes stranded below the fence. The boxes leg passes; the orphan leg
  // halts alone.
  const phaseSection = [
    "### Phase 3 — Wire surface",
    "",
    "**Preconditions.**",
    "",
    "- [x] Phase 2 merged",
    "",
    "<!-- prettier-ignore -->",
    "```yaml",
    "preconditions:",
    '  - { type: precondition_box_checked, box: "Ratified thing done" }',
    "```",
    "",
    "- [x] `repo.*` error codes ratified — gates T3.6",
    "- [x] `RepoDetach` cascade ratified — gates T3.7",
    "",
    "#### Tasks",
  ].join("\n");
  const r = gatePreconditions(phaseSection, "docs/plans/009-x.md", 3, {
    planSource: BOX_PLAN_SOURCE,
  });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.halt, /unchecked precondition/);
  assert.doesNotMatch(r.halt, /declares precondition:/);
  assert.match(r.halt, /has 2 orphaned precondition boxes stranded below the yaml fence:/);
  assert.match(r.halt, /error codes ratified/);
  assert.match(r.halt, /RepoDetach/);
});

test("gatePreconditions arms on every **Preconditions** header in a phase", () => {
  const phaseSection = [
    "### Phase 2 — Daemon services",
    "",
    "**Preconditions.**",
    "",
    "- [x] First region, ticked",
    "",
    "#### Sub-heading",
    "",
    "**Preconditions.**",
    "",
    "- [ ] Second region, unchecked",
    "",
    "#### Tasks",
  ].join("\n");
  const r = gatePreconditions(phaseSection, "docs/plans/009-x.md", 2);
  assert.equal(r.ok, false);
  assert.match(r.halt, /- \[ \] Second region, unchecked/);
});

test("extractPreconditionsSection returns the section body and null when absent", () => {
  assert.match(extractPreconditionsSection(BOX_PLAN_SOURCE), /Driver-ask expiry leg authored/);
  assert.doesNotMatch(extractPreconditionsSection(BOX_PLAN_SOURCE), /decoy outside/);
  assert.equal(extractPreconditionsSection("# Plan\n\n## Tasks\n"), null);
});

// ---------- runPreflight integration with substrate_exempt phase ----------

test("runPreflight dispatches substrate_exempt phase (Gate 4 skipped, audit_status admits)", () => {
  // Models Plan-023 Phase 1: no plan-level audit checkbox, Phase 1 has
  // audit_status: substrate_exempt YAML, Tasks block has zero Spec coverage
  // cites (would fail standard Gate 4) but Gate 4 is skipped for
  // substrate_exempt phases. Result: phase is eligible.
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(skillMd, `---\nname: test\nrequires_files: []\n---\n\nbody`);
  writeFileSync(
    join(repo, "docs", "architecture", "cross-plan-dependencies.md"),
    SUBSTRATE_XPLAN_FIXTURE,
  );
  const planFile = join(repo, "docs", "plans", "023-test.md");
  writeFileSync(
    planFile,
    `# Plan-023

## Preconditions

- [ ] **Plan-readiness audit complete

### Phase 1 — Workspace Substrate

**Spec-023 AC coverage.** Phase 1 covers no Spec-023 acceptance criteria — the substrate is pre-behavior plumbing.

\`\`\`yaml
preconditions:
  - { type: audit_status, status: substrate_exempt, carve_out_ref: "Plan-023 Substrate-vs-Namespace Carve-Out" }
\`\`\`

#### Tasks

- **T-023p-1-1** (Files: a.ts; Verifies invariant: none — substrate scaffold) — desc
- **T-023p-1-2** (Files: b.ts; Verifies invariant: none — toolchain) — desc

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped: []
\`\`\`

### Notes
${SYNTHETIC_PLAN_INVARIANTS}`,
  );
  const r = runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
  assert.equal(r.exit, 0, `exit was ${r.exit}; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.equal(r.stdout, "1");
});

test("runPreflight halts on phase without audit_status when plan has no checkbox", () => {
  // Per-phase strict check: plan has no audit checkbox, the phase has a
  // preconditions block but no audit_status entry — halts at
  // gatePhaseAuditCheckbox, not the lenient top-level gate.
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(skillMd, `---\nname: test\nrequires_files: []\n---\n\nbody`);
  // Other phase declares audit_status so top-level lenient gate passes; the
  // target phase has no audit_status so per-phase strict gate halts.
  writeFileSync(
    join(repo, "docs", "architecture", "cross-plan-dependencies.md"),
    SUBSTRATE_XPLAN_FIXTURE,
  );
  const planFile = join(repo, "docs", "plans", "023-test.md");
  writeFileSync(
    planFile,
    `# Plan-023

## Preconditions

- [ ] **Plan-readiness audit complete

### Phase 1 — Substrate

**Spec-023 AC coverage.** Phase 1 covers no Spec-023 acceptance criteria — the substrate is pre-behavior plumbing.

\`\`\`yaml
preconditions:
  - { type: audit_status, status: substrate_exempt, carve_out_ref: "Plan-023 Substrate-vs-Namespace Carve-Out" }
\`\`\`

#### Tasks

- **T-023p-1-1** (Verifies invariant: none) — desc

### Phase 2 — Behavior

\`\`\`yaml
preconditions: []
\`\`\`

#### Tasks

- **T-023p-2-1** (Verifies invariant: I-023-1; Spec coverage: [Spec-023 row 4]) — desc

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 1
    task: T-023p-1-1
    pr: 99
    sha: abcdef1
    merged_at: 2026-05-20
    files: []
    verifies_invariant: []
    spec_coverage: []
\`\`\`

### Notes
${SYNTHETIC_PLAN_INVARIANTS}`,
  );
  // Explicit phase 2 — phase 1 is fully shipped per the manifest.
  const r = runPreflight(planFile, 2, { repoRoot: repo, skillMd });
  assert.equal(r.exit, 1);
  assert.match(r.stdout, /per-phase audit declaration missing/);
});

// ---------- CLI entry (spawnSync) — guards the production wrapper ----------
// The skill invokes `node preflight.mjs <plan> [phase]`; every other test here
// imports runPreflight() and bypasses main()'s argv-parse → process.exit(
// result.exit) → stdout/stderr plumbing. A regression that made main() swallow
// stdout or mis-map the exit code would leave the rest of this suite green and
// the tool inert in production. These two spawn the real entry point so that
// silent-disable class is caught (a durable spawn guard, not a one-time run).
// REPO_ROOT/SKILL_MD resolve from the script's own __dirname, so the real repo
// satisfies Gate 1 while the temp plan drives Gates 2–5 from planSource.
// --allow-stale-manifest is passed because the CLI defaults Gate 6 (manifest
// freshness) ON and Gate 6 shells the real gh — a fixture plan named 001-*
// would be cross-checked against the real repo's merged Plan-001 PRs (network
// in a unit test + a guaranteed stale halt). The flag is the documented
// offline escape; its stderr skip-line is asserted so the bypass stays loud.

const PREFLIGHT_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "preflight.mjs");

test("CLI entry: --help writes usage to stderr and exits 2", () => {
  const r = spawnSync(process.execPath, [PREFLIGHT_CLI, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 2, `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /Usage: node preflight\.mjs/);
});

test("CLI entry: an unmet last-phase precondition halts with exit 1 and the verbatim halt on stdout", () => {
  // The fix path driven through the real main() wrapper, not just runPreflight.
  // Pre-fix the last phase swallowed the Progress-Log manifest and treated it as
  // a vacuous preconditions block, so this returned exit 0; post-fix the prose
  // **Precondition** is read and resolved. The precondition gate resolves a
  // `Plan-NNN Phase N merged` token against repoRoot/docs/plans (by design), and
  // the spawned CLI derives the *real* repoRoot from its own __dirname — so the
  // token references Plan-099, which is absent from the corpus and therefore
  // deterministically unmet. This pins the fix across the argv → process.exit
  // boundary without coupling to any real plan's live ship state.
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

#### Tasks

##### T1.1 — desc
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-1

### Phase 2 — Renderer (last phase)

**Precondition:** Plan-099 Phase 1 merged.

#### Tasks

##### T2.1 — desc
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-2

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped: []
\`\`\`

### Notes
${SYNTHETIC_PLAN_INVARIANTS}`,
  );
  const r = spawnSync(
    process.execPath,
    [PREFLIGHT_CLI, planFile, "2", "--allow-stale-manifest", "--allow-unpromoted"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 1, `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /Gate 6 \(manifest freshness\) SKIPPED via --allow-stale-manifest/);
  assert.match(
    r.stderr,
    /Gate 7 \(status promotion \+ governance preconditions\) SKIPPED via --allow-unpromoted/,
  );
  assert.match(r.stdout, /precondition unmet/i);
  assert.match(r.stdout, /Plan-099 not found/);
});

test("runPreflight reports the last phase eligible when its precondition is met (over-fire guard)", () => {
  // Symmetric direction to the last-phase regression: with Phase 1 shipped in
  // the manifest, the last phase's `Phase 1 merged` precondition is MET, so the
  // gate must report eligible (exit 0 + phase number) rather than over-fire into
  // a halt. Every other precondition test asserts a halt, so a fix that wrongly
  // halted a satisfied last-phase precondition would pass the suite without this.
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

#### Tasks

##### T1.1 — desc
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-1

### Phase 2 — Renderer (last phase)

**Precondition:** Phase 1 merged.

#### Tasks

##### T2.1 — desc
**Spec coverage:** none (test placeholder) **Verifies invariant:** I-001-2

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
  - phase: 1
    task: T1.1
    pr: 1
    sha: abc1234
    merged_at: 2026-01-01
    files: []
    verifies_invariant: []
    spec_coverage: []
\`\`\`

### Notes
${SYNTHETIC_PLAN_INVARIANTS}`,
  );
  const r = runPreflight(planFile, 2, { repoRoot: repo, skillMd });
  assert.equal(r.exit, 0, `exit was ${r.exit}; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.equal(r.stdout, "2");
});

// ---------- Gate 7 — plan status promotion ----------
// The corpus promotion gate (review → approved before first code PR) had no
// mechanical enforcement: Gate 2 verifies the audit fact, nothing verified
// promotion, so an audit-complete review-status plan cleared preflight
// end-to-end (Codex P2, PR #193). These pin the gate + the CLI default-ON /
// --allow-unpromoted escape.

const statusPlan = (status) => `# Plan-001

| Field | Value |
| --- | --- |
| **Status** | \`${status}\` |
| **NNN** | \`001\` |
`;

test("gateStatusPromotion passes approved and completed", () => {
  assert.equal(gateStatusPromotion(statusPlan("approved"), "p.md").ok, true);
  assert.equal(gateStatusPromotion(statusPlan("completed"), "p.md").ok, true);
});

test("gateStatusPromotion halts review and draft with the promotion message", () => {
  for (const status of ["review", "draft"]) {
    const r = gateStatusPromotion(statusPlan(status), "docs/plans/001-test.md");
    assert.equal(r.ok, false);
    assert.match(r.halt, /plan not promoted \(Gate 7\)/);
    assert.match(r.halt, new RegExp(`Status is \\\`${status}\\\``));
    assert.match(r.halt, /--allow-unpromoted/);
  }
});

// Gate 7's governance-precondition scan: an `approved`-status plan whose
// paired-spec box was re-opened by a W1 spec flip cleared the status row and
// dispatched code against a `review` spec (Codex P2, PR #202). These pin the
// prefix-matched template trio, the note-suffix tolerance, and the deliberate
// non-match of scoped upstream-dependency boxes.

const preconditionsPlan = (boxes) => `# Plan-001

| Field | Value |
| --- | --- |
| **Status** | \`approved\` |

## Preconditions

${boxes}

## Objective

body
`;

test("gatePlanPreconditionBoxes passes when the governance trio is checked", () => {
  const r = gatePlanPreconditionBoxes(
    preconditionsPlan(
      "- [x] Paired spec is approved\n- [x] Required ADRs are accepted\n- [x] Blocking open questions are resolved or explicitly deferred",
    ),
    "p.md",
  );
  assert.equal(r.ok, true);
});

test("gatePlanPreconditionBoxes halts on an unchecked paired-spec box, note suffix included", () => {
  const r = gatePlanPreconditionBoxes(
    preconditionsPlan(
      "- [ ] Paired spec is approved — **re-opened 2026-07-13:** Spec-010 is temporarily `review`.\n- [x] Required ADRs are accepted",
    ),
    "docs/plans/010-test.md",
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /plan-governance precondition unchecked \(Gate 7\)/);
  assert.match(r.halt, /Paired spec is approved/);
  assert.match(r.halt, /--allow-unpromoted/);
});

test("gatePlanPreconditionBoxes matches the punctuation-suffixed and bold-wrapped template variants", () => {
  // Plan-027 spells the box `- [ ] Paired spec is approved. — …` (trailing
  // period); prefix matching must not depend on the author's punctuation.
  const punctuated = gatePlanPreconditionBoxes(
    preconditionsPlan("- [ ] Paired spec is approved. — re-opened 2026-07-13."),
    "p.md",
  );
  assert.equal(punctuated.ok, false);
  const bold = gatePlanPreconditionBoxes(
    preconditionsPlan("- [ ] **Required ADRs are accepted** — ADR-025 pending."),
    "p.md",
  );
  assert.equal(bold.ok, false);
});

test("gatePlanPreconditionBoxes ignores scoped upstream-dependency boxes and other sections", () => {
  // Plan-023/024-style boxes gate specific phases via their prose, not the
  // whole plan — the governance scan must not halt on them. Unchecked task
  // checkboxes outside §Preconditions are likewise out of scope.
  const r = gatePlanPreconditionBoxes(
    preconditionsPlan(
      "- [x] Paired spec is approved\n- [ ] **(Tier 8 remainder only.)** Plan-007 exposes the daemon lifecycle API.\n- [ ] Apple Developer Program enrollment procured.",
    ) + "\n## Tasks\n\n- [ ] **T1.1 — build the thing**\n",
    "p.md",
  );
  assert.equal(r.ok, true);
});

test("gatePlanPreconditionBoxes passes a plan with no Preconditions section", () => {
  assert.equal(gatePlanPreconditionBoxes(statusPlan("approved"), "p.md").ok, true);
});

test("runPreflight halts on an unchecked governance box under checkStatusPromotion, before the phase walk", () => {
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(skillMd, `---\nname: test\nrequires_files: []\n---\n\nbody`);
  const planFile = join(repo, "docs", "plans", "010-test.md");
  // Approved status + ticked audit box + unchecked paired-spec box and NO
  // phase sections: the box halt must precede the "no Phase headers" exit-2
  // path — the exact fail-open Codex reproduced on Plan-010 (status row
  // green, box unchecked, Phase 1 selected).
  writeFileSync(
    planFile,
    `# Plan-010\n\n| Field | Value |\n| --- | --- |\n| **Status** | \`approved\` |\n\n## Preconditions\n\n- [ ] Paired spec is approved — re-opened 2026-07-13.\n- [x] **Plan-readiness audit complete per runbook.\n`,
  );
  const gated = runPreflight(planFile, undefined, {
    repoRoot: repo,
    skillMd,
    checkStatusPromotion: true,
  });
  assert.equal(gated.exit, 1);
  assert.match(gated.stdout, /plan-governance precondition unchecked \(Gate 7\)/);
  // Programmatic default (checkStatusPromotion unset) skips the scan and
  // falls through to the phase walk's exit-2, keeping fixture suites green.
  const ungated = runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
  assert.equal(ungated.exit, 2);
});

// ---------- external_plan_phase_merged (R-phase gates — Codex r4, PR #193) ----------

function writeRPhaseUpstream(dir, { shipR2 = false } = {}) {
  const manifestTasks = shipR2
    ? "  - phase: 5\n    task: [T-007r-2-1, T-007r-2-2]\n    pr: 99\n    sha: abc1234\n    merged_at: 2026-08-01\n    files:\n      - packages/runtime-daemon/src/bootstrap/daemon-key-store.ts\n    verifies_invariant: []\n    spec_coverage: []\n    notes: |\n      R2 shipped under integer phase 5.\n"
    : "  - phase: 1\n    task: [T-007p-1-1]\n    pr: 16\n    sha: 49f1116\n    merged_at: 2026-04-29\n    files:\n      - packages/runtime-daemon/src/bootstrap/secure-defaults.ts\n    verifies_invariant: []\n    spec_coverage: []\n    notes: |\n      Phase 1 only.\n";
  const upstream = `# Plan-007 — Fixture

| Field | Value |
| --- | --- |
| **Status** | \`approved\` |

## Implementation Phase Sequence

### Phase 1 — Shipped Substrate

#### Tasks

- **T-007p-1-1 — substrate.**

### Phase R2 — Secure Defaults (Tier 4)

#### Tasks

- **T-007r-2-1** (Files: \`packages/runtime-daemon/src/bootstrap/secure-defaults.ts\` EXTEND) — config keys.
- **T-007r-2-2** (Files: \`packages/runtime-daemon/src/bootstrap/daemon-key-store.ts\`) — DaemonKeyStore interface.

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
${manifestTasks}\`\`\`
`;
  writeFileSync(join(dir, "007-fixture.md"), upstream);
}

test("findSectionBoundary: a remainder heading (### Phase R2) bounds the preceding numbered phase", () => {
  const body = "\nbody of phase 3\n\n### Phase R1 — Remainder\n\nmore";
  const idx = findSectionBoundary(body);
  assert.ok(idx > 0);
  assert.equal(body.slice(idx).startsWith("### Phase R1"), true);
});

test("external_plan_phase_merged: R-phase gate halts while the R-section tasks are unshipped", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pf-rphase-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    writeRPhaseUpstream(planDir, { shipR2: false });
    const r = resolvePrecondition(
      { type: "external_plan_phase_merged", plan: 7, phase: "R2" },
      { repoRoot: tmp },
    );
    assert.equal(r.ok, false);
    assert.match(r.halt, /Phase R2 not shipped — missing tasks: T-007r-2-1, T-007r-2-2/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("external_plan_phase_merged: R-phase gate passes once the tasks ship under ANY integer phase", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pf-rphase-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    writeRPhaseUpstream(planDir, { shipR2: true });
    const r = resolvePrecondition(
      { type: "external_plan_phase_merged", plan: 7, phase: "R2" },
      { repoRoot: tmp },
    );
    assert.equal(r.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("external_plan_phase_merged: missing R-section fails closed", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pf-rphase-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    writeRPhaseUpstream(planDir, { shipR2: false });
    const r = resolvePrecondition(
      { type: "external_plan_phase_merged", plan: 7, phase: "R9" },
      { repoRoot: tmp },
    );
    assert.equal(r.ok, false);
    assert.match(r.halt, /no "### Phase R9" section/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("external_plan_phase_merged: integer phase delegates to plan_phase semantics", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pf-rphase-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    writeRPhaseUpstream(planDir, { shipR2: false });
    const r = resolvePrecondition(
      { type: "external_plan_phase_merged", plan: 7, phase: 1 },
      { repoRoot: tmp },
    );
    assert.equal(r.ok, true); // Phase 1's declared T-007p-1-1 is in the manifest
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("external_plan_phase_merged: malformed phase value halts loudly", () => {
  const r = resolvePrecondition(
    { type: "external_plan_phase_merged", plan: 7, phase: "banana" },
    { repoRoot: "/nonexistent" },
  );
  assert.equal(r.ok, false);
  assert.match(r.halt, /unsupported phase value/);
});

// ---------- external_plan_phase_merged (supplement-phase gates — campaign B16) ----------

function writeSupplementUpstream(dir, { ship3B = false } = {}) {
  const manifestTasks = ship3B
    ? "  - phase: 3\n    task: [T-024-3-1]\n    pr: 56\n    sha: abc1234\n    merged_at: 2026-06-01\n    files:\n      - packages/runtime-daemon/src/pty/rust-sidecar-pty-host.ts\n    verifies_invariant: []\n    spec_coverage: []\n    notes: |\n      Phase 3 core.\n  - phase: 3\n    task: [T-024-3B-1, T-024-3B-2]\n    pr: 240\n    sha: def5678\n    merged_at: 2026-08-01\n    files:\n      - packages/runtime-daemon/src/pty/control-lease.ts\n    verifies_invariant: []\n    spec_coverage: []\n    notes: |\n      3B shipped under integer phase 3.\n"
    : "  - phase: 3\n    task: [T-024-3-1]\n    pr: 56\n    sha: abc1234\n    merged_at: 2026-06-01\n    files:\n      - packages/runtime-daemon/src/pty/rust-sidecar-pty-host.ts\n    verifies_invariant: []\n    spec_coverage: []\n    notes: |\n      Phase 3 only.\n";
  const upstream = `# Plan-024 — Fixture

| Field | Value |
| --- | --- |
| **Status** | \`approved\` |

## Implementation Phase Sequence

### Phase 3 — Core

#### Tasks

- **T-024-3-1 — core.**

### Phase 3B — Substrate Hardening (Campaign B16)

#### Tasks

- **T-024-3B-1** (Files: \`packages/runtime-daemon/src/pty/control-lease.ts\`) — lease authority.
- **T-024-3B-2** (Files: \`packages/runtime-daemon/src/pty/orphan-registry.ts\`) — orphan registry.

### Phase 4 — Distribution

#### Tasks

- **T-024-4-1 — dist.**

## Progress Log

### Shipment Manifest

\`\`\`yaml
manifest_schema_version: 1
shipped:
${manifestTasks}\`\`\`
`;
  writeFileSync(join(dir, "024-fixture.md"), upstream);
}

test("findSectionBoundary: a supplement heading (### Phase 3B) bounds the preceding numbered phase", () => {
  const body = "\nbody of phase 3\n\n### Phase 3B — Supplement\n\nmore";
  const idx = findSectionBoundary(body);
  assert.ok(idx > 0);
  assert.equal(body.slice(idx).startsWith("### Phase 3B"), true);
});

test("extractPhaseSection: integer lookup does not swallow the supplement section's tasks", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pf-supplement-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    writeSupplementUpstream(planDir, { ship3B: false });
    const source = readFileSync(join(planDir, "024-fixture.md"), "utf8");
    const phase3 = extractPhaseSection(source, 3);
    assert.ok(phase3);
    assert.deepEqual(extractDeclaredTaskIds(phase3), ["T-024-3-1"]);
    const phase3B = extractPhaseSection(source, "3B");
    assert.ok(phase3B);
    assert.deepEqual(extractDeclaredTaskIds(phase3B), ["T-024-3B-1", "T-024-3B-2"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("external_plan_phase_merged: supplement gate halts while the 3B tasks are unshipped", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pf-supplement-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    writeSupplementUpstream(planDir, { ship3B: false });
    const r = resolvePrecondition(
      { type: "external_plan_phase_merged", plan: 24, phase: "3B" },
      { repoRoot: tmp },
    );
    assert.equal(r.ok, false);
    assert.match(r.halt, /Phase 3B not shipped — missing tasks: T-024-3B-1, T-024-3B-2/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("external_plan_phase_merged: supplement gate passes once the tasks ship under an integer phase", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pf-supplement-"));
  try {
    const planDir = join(tmp, "docs", "plans");
    mkdirSync(planDir, { recursive: true });
    writeSupplementUpstream(planDir, { ship3B: true });
    const r = resolvePrecondition(
      { type: "external_plan_phase_merged", plan: 24, phase: "3B" },
      { repoRoot: tmp },
    );
    assert.equal(r.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("external_plan_phase_merged: near-miss supplement labels stay rejected", () => {
  for (const phase of ["3b", "B3", "33BB", "3B4"]) {
    const r = resolvePrecondition(
      { type: "external_plan_phase_merged", plan: 24, phase },
      { repoRoot: "/nonexistent" },
    );
    assert.equal(r.ok, false, `phase ${phase} must be rejected`);
    assert.match(r.halt, /unsupported phase value/);
  }
});

test("gateStatusPromotion ignores Status-shaped table rows in the body (header-region scope — Codex r3)", () => {
  // Missing header row + an embedded example table later in the body must
  // NOT green-light the plan.
  const source =
    "# Plan-001\n\nno header table\n\n## Some Section\n\n| Field | Value |\n| --- | --- |\n| **Status** | `approved` |\n";
  const r = gateStatusPromotion(source, "p.md");
  assert.equal(r.ok, false);
  assert.match(r.halt, /status unreadable/);
});

test("gateStatusPromotion fails closed on a missing/unparseable Status row", () => {
  const r = gateStatusPromotion("# Plan-001\n\nno header table here\n", "p.md");
  assert.equal(r.ok, false);
  assert.match(r.halt, /status unreadable/);
});

test("gateStatusPromotion reads the unbackticked Status cell too", () => {
  const source = "# Plan-001\n\n| Field | Value |\n| --- | --- |\n| **Status** | approved |\n";
  assert.equal(gateStatusPromotion(source, "p.md").ok, true);
});

test("runPreflight enforces Gate 7 only when checkStatusPromotion is set (CLI default), and the halt precedes the phase walk", () => {
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(skillMd, `---\nname: test\nrequires_files: []\n---\n\nbody`);
  const planFile = join(repo, "docs", "plans", "001-test.md");
  // Review-status plan with a ticked audit box and NO phase sections: Gate 7
  // must halt before the "no Phase headers" exit-2 path, proving placement.
  writeFileSync(
    planFile,
    `# Plan-001\n\n| Field | Value |\n| --- | --- |\n| **Status** | \`review\` |\n\n## Preconditions\n\n- [x] **Plan-readiness audit complete per runbook.\n`,
  );
  const gated = runPreflight(planFile, undefined, {
    repoRoot: repo,
    skillMd,
    checkStatusPromotion: true,
  });
  assert.equal(gated.exit, 1);
  assert.match(gated.stdout, /plan not promoted \(Gate 7\)/);
  // Programmatic default (checkStatusPromotion unset) skips the gate and
  // falls through to the phase walk's exit-2 — the pre-Gate-7 behavior.
  const ungated = runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
  assert.equal(ungated.exit, 2);
});

test("CLI entry: review-status plan halts at Gate 7 by default; --allow-unpromoted skips loudly", () => {
  const repo = makeTempRepo();
  const skillMd = join(repo, ".claude", "skills", "plan-execution", "SKILL.md");
  writeFileSync(skillMd, `---\nname: test\nrequires_files: []\n---\n\nbody`);
  const planFile = join(repo, "docs", "plans", "001-test.md");
  writeFileSync(
    planFile,
    `# Plan-001\n\n| Field | Value |\n| --- | --- |\n| **Status** | \`review\` |\n\n## Preconditions\n\n- [x] **Plan-readiness audit complete per runbook.\n`,
  );
  // Gate 7 fires before Gate 6, so no --allow-stale-manifest is needed —
  // the halt path stays network-free by construction.
  const gated = spawnSync(process.execPath, [PREFLIGHT_CLI, planFile], { encoding: "utf8" });
  assert.equal(gated.status, 1, `status=${gated.status} stdout=${gated.stdout}`);
  assert.match(gated.stdout, /plan not promoted \(Gate 7\)/);
  const skipped = spawnSync(
    process.execPath,
    [PREFLIGHT_CLI, planFile, "--allow-unpromoted", "--allow-stale-manifest"],
    { encoding: "utf8" },
  );
  assert.match(
    skipped.stderr,
    /Gate 7 \(status promotion \+ governance preconditions\) SKIPPED via --allow-unpromoted/,
  );
  assert.doesNotMatch(String(skipped.stdout), /plan not promoted/);
});

// ---------- explicit supplement-phase-label dispatch ----------
// Supplement phases (`### Phase 3B — …`) are campaign supplements hanging off
// the phase they extend. The no-argument walk is numeric-only BY DESIGN and
// never selects one; before this feature `Number("3B")` was NaN, so the label
// was also unreachable explicitly (exit 2, `bad phase argument`) and a
// supplement could only be verified by direct read. These tests pin both
// halves: the label now dispatches through every gate a numeric phase runs,
// and the walker still refuses to auto-select it.

test("parsePhaseArgument accepts phase numbers and supplement labels, rejects everything else", () => {
  assert.equal(parsePhaseArgument(undefined), undefined);
  assert.equal(parsePhaseArgument("4"), 4);
  assert.equal(parsePhaseArgument("12"), 12);
  assert.equal(parsePhaseArgument("3B"), "3B");
  assert.equal(parsePhaseArgument("10Z"), "10Z");
  // Case is load-bearing: the corpus writes uppercase supplement labels, and a
  // lowercase spelling resolves no heading, so accepting it would dispatch
  // nothing while looking valid.
  assert.equal(parsePhaseArgument("3b"), null);
  // Remainder labels are gate OPERANDS (external_plan_phase_merged), not
  // execution targets — deliberately not dispatchable.
  assert.equal(parsePhaseArgument("R2"), null);
  assert.equal(parsePhaseArgument("3.5"), null);
  assert.equal(parsePhaseArgument("3B4"), null);
  assert.equal(parsePhaseArgument("abc"), null);
  assert.equal(parsePhaseArgument(""), 0);
});

test("walkSupplementPhases finds supplement headings only, and requires the title separator", () => {
  const src = `### Phase 1 — Numeric

### Phase 1B — Supplement one

### Phase R2 — Remainder

### Phase 2B

### Phase 3B: Colon separator
`;
  assert.deepEqual(walkSupplementPhases(src), [
    { number: "1B", title: "Supplement one" },
    { number: "3B", title: "Colon separator" },
  ]);
  // The numeric walker is untouched by any of it.
  assert.deepEqual(
    walkPhases(src).map((p) => p.number),
    [1],
  );
});

test("shippedTaskIdsAcrossManifest unions every entry's tasks regardless of phase key", () => {
  const manifest = {
    ok: true,
    shipped: [
      { phase: 1, task: "T1.1" },
      { phase: 2, task: ["T2.1", "T-001-1B-1"] },
    ],
  };
  assert.deepEqual([...shippedTaskIdsAcrossManifest(manifest)].sort(), [
    "T-001-1B-1",
    "T1.1",
    "T2.1",
  ]);
  assert.deepEqual([...shippedTaskIdsAcrossManifest({ ok: false })], []);
  assert.deepEqual([...shippedTaskIdsAcrossManifest(null)], []);
});

test("runPreflight dispatches an explicit supplement label through every gate and returns its size class", () => {
  const { repo, skillMd, planFile } = buildTestRepo({
    phases: [
      { n: 1, title: "Bootstrap", tasks: ["T1.1"] },
      { n: "1B", title: "Supplement", tasks: ["T-001-1B-1"], invariant: 6 },
      { n: 2, title: "Renderer", tasks: ["T2.1"] },
    ],
  });
  const r = runPreflight(planFile, "1B", { repoRoot: repo, skillMd });
  assert.equal(r.exit, 0, `exit was ${r.exit}; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.equal(r.stdout, "1B");
  assert.equal(r.sizeClass, "S");
});

test("runPreflight halts on an explicit supplement whose Gate-5 preconditions are unmet", () => {
  // The failure must be the GATE's, not the argument parser's: pre-feature this
  // invocation died at `bad phase argument` and the phase's real precondition
  // was never evaluated at all.
  const { repo, skillMd, planFile } = buildTestRepo({
    phases: [
      { n: 1, title: "Bootstrap", tasks: ["T1.1"] },
      {
        n: "1B",
        title: "Supplement",
        tasks: ["T-001-1B-1"],
        invariant: 6,
        preconditionsYaml: `preconditions:
  - { type: plan_phase, plan: 099, phase: 1, status: merged }`,
      },
    ],
  });
  const r = runPreflight(planFile, "1B", { repoRoot: repo, skillMd });
  assert.equal(r.exit, 1, `exit was ${r.exit}; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stdout, /precondition unmet/i);
  assert.match(r.stdout, /Phase 1B/);
  assert.match(r.stdout, /Plan-099/);
  assert.doesNotMatch(r.stdout, /bad phase argument/);
});

test("runPreflight fails closed on an explicit label naming no supplement heading", () => {
  const { repo, skillMd, planFile } = buildTestRepo({
    phases: [
      { n: 1, title: "Bootstrap", tasks: ["T1.1"] },
      { n: "1B", title: "Supplement", tasks: ["T-001-1B-1"], invariant: 6 },
    ],
  });
  const r = runPreflight(planFile, "9C", { repoRoot: repo, skillMd });
  assert.equal(r.exit, 1, `exit was ${r.exit}; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stdout, /supplement phase 9C not found/);
  // Self-contained: names what the plan actually declares, and the separator
  // trap that makes a heading invisible to the resolver.
  assert.match(r.stdout, /Phase 1B/);
  assert.match(r.stdout, /separator/);
});

test("runPreflight halts an explicit supplement whose tasks already shipped under an integer phase key", () => {
  // The fail-open this closes: a supplement label can never BE a manifest phase
  // key (validateEntry forces positive integers), so phase-key equality returns
  // an EMPTY shipped set, classifies every supplement `partially_shipped`, and
  // re-dispatches shipped work forever. The supplement's task ships here under
  // integer phase 1 — the only place it can ship.
  const { repo, skillMd, planFile } = buildTestRepo({
    phases: [
      { n: 1, title: "Bootstrap", tasks: ["T1.1"] },
      { n: "1B", title: "Supplement", tasks: ["T-001-1B-1"], invariant: 6 },
    ],
    manifestEntries: `shipped:
  - phase: 1
    task: [T1.1, T-001-1B-1]
    pr: 6
    sha: ca22530
    merged_at: 2026-04-27
    files: []
    verifies_invariant: []
    spec_coverage: []`,
  });
  const r = runPreflight(planFile, "1B", { repoRoot: repo, skillMd });
  assert.equal(r.exit, 1, `exit was ${r.exit}; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stdout, /phase already shipped/);
  assert.match(r.stdout, /Phase 1B/);
});

test("the no-argument walk never selects a supplement, even an otherwise-eligible one", () => {
  // The claim is "skipped BY DESIGN", so the supplement has to be provably
  // dispatchable — otherwise this test cannot distinguish a walker that skips
  // supplements from a fixture whose supplement merely failed a gate. Phase 1
  // is fully shipped (silent skip), Phase 1B passes every gate, Phase 2 passes:
  // the walk must resolve 2.
  const { repo, skillMd, planFile } = buildTestRepo({
    phases: [
      { n: 1, title: "Bootstrap", tasks: ["T1.1"] },
      { n: "1B", title: "Supplement", tasks: ["T-001-1B-1"], invariant: 6 },
      { n: 2, title: "Renderer", tasks: ["T2.1"] },
    ],
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
  const explicit = runPreflight(planFile, "1B", { repoRoot: repo, skillMd });
  assert.equal(
    explicit.exit,
    0,
    `supplement must be dispatchable for this test to mean anything; stdout=${explicit.stdout}`,
  );

  const walked = runPreflight(planFile, undefined, { repoRoot: repo, skillMd });
  assert.equal(walked.exit, 0, `exit was ${walked.exit}; stdout=${walked.stdout}`);
  assert.equal(walked.stdout, "2");
  assert.notEqual(walked.stdout, "1B");
});

test("CLI entry: an explicit supplement label prints the label then its size class", () => {
  // `invariant: 3`, not the 6 the programmatic tests use: the spawned CLI
  // derives the REAL repoRoot from its own __dirname, so Gate 4's invariant
  // screen resolves `I-001-N` against the real docs/plans/001-*.md (which
  // declares I-001-1..3) rather than against this temp fixture.
  const { planFile } = buildTestRepo({
    phases: [
      { n: 1, title: "Bootstrap", tasks: ["T1.1"] },
      { n: "1B", title: "Supplement", tasks: ["T-001-1B-1"], invariant: 3 },
    ],
  });
  const r = spawnSync(
    process.execPath,
    [PREFLIGHT_CLI, planFile, "1B", "--allow-stale-manifest", "--allow-unpromoted"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  // The two-line success contract, across the real argv → exit-code plumbing.
  assert.equal(r.stdout, "1B\nsize-class: S\n");
});

test("CLI entry: a malformed phase argument exits 2 and names both accepted forms", () => {
  const { planFile } = buildTestRepo({
    phases: [{ n: 1, title: "Bootstrap", tasks: ["T1.1"] }],
  });
  for (const bad of ["3b", "R2", "abc"]) {
    const r = spawnSync(
      process.execPath,
      [PREFLIGHT_CLI, planFile, bad, "--allow-stale-manifest", "--allow-unpromoted"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 2, `${bad}: status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, new RegExp(`bad phase argument: ${bad}\\b`));
    assert.match(r.stderr, /supplement label/);
    assert.equal(r.stdout, "");
  }
});
