# Plan-execution Housekeeper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 7th plan-execution subagent role (`plan-execution-housekeeper`) and its companion script (`post-merge-housekeeper.mjs`) so Phase E auto-updates `docs/architecture/cross-plan-dependencies.md` §6 NS-XX entries + plan §Done Checklists in the same commit as plan-execution work.

**Architecture:** Hybrid script + subagent. Script (`post-merge-housekeeper.mjs`, Node.js, no deps beyond `node:test`) does deterministic mechanical edits (status flip / `PRs:` tick / mermaid recolor / plan checklist tick) and emits a manifest. Subagent (`.claude/agents/plan-execution-housekeeper.md`, color: blue, tools `Read,Grep,Glob,Edit,Write`) does semantic work (ready-set re-derivation, line-cite sweep, NS auto-create body composition, completion-prose). Manifest at `.agents/tmp/housekeeper-manifest-PR<N>.json` is the contract between stages.

**Tech Stack:** Node.js (`--experimental-strip-types` per ADR-022), `node:test` + `node:assert/strict`, fixture-corpus pattern (one input/expected dir per scenario), markdown subagent definitions, prose orchestrator amendments to `SKILL.md`.

**Spec:** `docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md` (status: `approved`, committed at `7ba2bd5`).

---

## Phasing & PR Boundaries

The spec §10.1 prescribes **four PRs**, in this order:

| Phase | PR | Scope | Auto-housekept? |
| --- | --- | --- | --- |
| 1 | PR 1 | NS-23 schema amendment + `PRs:` block migration to NS-02/04/15..21 | NO (housekeeper doesn't exist; NS-23 flips manually inline per §3a.3 NS-12 precedent) |
| 2 | PR 2 | Move `scripts/preflight-contract.md` → `references/preflight-contract.md` + 5 inline path updates (OPTIONAL — can fold into PR 3) | NO (no §6 implication) |
| 3 | PR 3 | `post-merge-housekeeper.mjs` + 10 fixture scenarios + tests + CI wiring | NO (script ships; subagent doesn't exist yet for orchestrator dispatch) |
| 4 | PR 4 | `plan-execution-housekeeper.md` subagent + `references/post-merge-housekeeper-contract.md` + SKILL.md Phase E amendments + state-recovery.md + failure-modes.md updates | NO (final manual cycle; PR 4 introduces the housekeeper, can't self-housekeep) |

PR 1 MUST be its own PR (it establishes the schema PR 3/4 depend on). PR 4 MUST be a single PR (script + subagent + orchestrator-side amendments must ship atomically per §10.1 last paragraph). PRs 2-3 may bundle.

Default below: **4 PRs**, one per Phase. To bundle PR 2 into PR 3, complete Phase 2 tasks on the Phase 3 branch and use one combined commit message.

---

## File Structure

### New files (created by this plan)

```
.claude/agents/
└── plan-execution-housekeeper.md                                        ⬅ Phase 4 (subagent definition; color: blue; tools Read,Grep,Glob,Edit,Write)

.claude/skills/plan-execution/
├── scripts/
│   ├── post-merge-housekeeper.mjs                                       ⬅ Phase 3 (the script; mechanical-stage logic)
│   └── __tests__/
│       ├── post-merge-housekeeper.test.mjs                              ⬅ Phase 3 (Layer 1 fixture-driven tests)
│       ├── post-merge-housekeeper-orchestrator-helpers.test.mjs         ⬅ Phase 4 (Layer 2 prompt + manifest-validation tests)
│       ├── helpers/
│       │   └── fixture-loader.mjs                                       ⬅ Phase 3 (loads input/expected/args.json/expected-manifest.json per fixture)
│       └── fixtures/                                                    ⬅ Phase 3 (10 scenario directories per spec §8.1)
│           ├── 01-single-pr-happy-path/{input,expected,args.json,expected-manifest.json}
│           ├── 02-multi-pr-tick-only/...
│           ├── 03-multi-pr-completion/...
│           ├── 04-multi-pr-blocked-upstream/...
│           ├── 05-exit-1-no-ns-match/...
│           ├── 06-exit-2-multi-ns-match/...
│           ├── 07-exit-3-no-checklist/...
│           ├── 08-exit-4-multi-pr-no-task-id/...
│           ├── 09-exit-5-schema-violation-malformed-prs/...
│           └── 10-mermaid-class-attachment-variant/...
├── lib/
│   └── housekeeper-orchestrator-helpers.mjs                             ⬅ Phase 4 (`buildHousekeeperPrompt`, `validateManifestSubagentStage`)
└── references/
    └── post-merge-housekeeper-contract.md                               ⬅ Phase 4 (manifest schema, exit codes, validation invariants, recovery diagnostic, completion-rule matrix from spec §3a.2, file-reference extraction heuristic from spec §3a.4)

.github/workflows/
└── ci.yml                                                               ⬅ Phase 3 (NEW step `node --test .claude/skills/plan-execution/scripts/__tests__/`; existing workflow file unless missing)
```

### Moved files

| From | To | Phase |
| --- | --- | --- |
| `.claude/skills/plan-execution/scripts/preflight-contract.md` | `.claude/skills/plan-execution/references/preflight-contract.md` | Phase 2 |

### Modified files

| File | Edit | Phase |
| --- | --- | --- |
| `docs/architecture/cross-plan-dependencies.md` | Insert NS-23 entry; migrate NS-02/04/15..21 to `PRs:` shape; mermaid graph node for NS-23 | 1 |
| `docs/architecture/cross-plan-dependencies.md` | Re-rendering after PR 4's first auto-run | (post-PR 4 / out of plan scope) |
| `.claude/skills/plan-execution/scripts/preflight.mjs` lines 3, 537 | Update path references after Phase 2 move | 2 |
| `.claude/skills/plan-execution/SKILL.md` | "Six subagent roles" → "Seven subagent roles" + housekeeper row appended; Phase E section rewritten with candidate-lookup prose; Reference Files section gains `post-merge-housekeeper-contract.md` row; 3 path references updated post Phase 2 move | 2 (paths) + 4 (Phase E + role count) |
| `.claude/skills/plan-execution/references/state-recovery.md` | Add "Phase E housekeeping recovery" section with diagnostic from spec §7.2; cross-link `post-merge-housekeeper-contract.md`; flag (not reconcile) the existing `.agents/tmp/` lifecycle drift per spec §9.3 | 4 |
| `.claude/skills/plan-execution/references/failure-modes.md` | Add row for "subagent edits files outside manifest's `affected_files` declaration" with round-trip pattern; cross-link BLOCKED routing for housekeeper schema-violation halts (no new exit-state introduced) | 4 |

**Out of scope for this plan** (per spec §2.2 and §10.5):

- `.agents/tmp/` lefthook cleanup job (spec §10.5 recommends skip for V1)
- Reconciling `state-recovery.md:174`'s `.agents/tmp/` lifecycle prose — flagged but not fixed (spec §9.3 explicit deferral)
- `pnpm-workspace.yaml` integration of `.claude/skills/plan-execution/` as a workspace package (spec §10.4 recommendation (a) over (b))

---

## Invariants (carry forward; check after each phase)

| ID | Invariant | Where it's checked |
| --- | --- | --- |
| I-1 | Spec §1.1.1 verbatim NS quote blocks remain extractable by the cite-target hook (`../../<tree>/...` path form) | Inline in Tasks 1.1 step 3, 1.7 step 2, 2.5 step 1, 4.6 step 6, 4.7 step 3, 4.9 step 4 (every doc-edit task runs `pre-commit-runner.ts` against the modified file). PLUS dedicated regression test in Task 4.8 step 5 (NEW — see I-1 dedicated test below). |
| I-2 | The four canonical subagent exit-states (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED) are reused — NO new exit-state is introduced by the housekeeper | Task 4.1 subagent body's "## Exit states" section restates the four canonical states; Task 4.7 routing rules 20-21 explicitly note "NOT a new exit-state per spec §7.1 invariant"; PLUS dedicated regression test in Task 4.8 step 6 (NEW — see I-2 dedicated test below) that grep-asserts the subagent definition file contains exactly four `RESULT: <STATE>` references. |
| I-3 | Script never imports `child_process.spawn('git', ...)` — `tools:` omission is the mechanical guard but the script also doesn't shell out for git diff (orchestrator passes the diff path or content via flag/file) | Task 4.1 subagent definition's `tools:` field omits `Bash` (mechanical guard for the SUBAGENT). For the SCRIPT (post-merge-housekeeper.mjs) the same invariant holds via prose discipline; PLUS dedicated regression test in Task 4.8 step 7 (NEW — see I-3 dedicated test below) that grep-asserts no `child_process` import OR `spawn('git'` callsite exists in the script. |
| I-4 | Manifest format matches spec §5.3 verbatim (no version field, no extra top-level keys without spec amendment) | Task 4.8 step 2 (D-7 row 13) zod-parse test pins the schema; if a top-level key is added without amending the schema, the test fails. |
| I-5 | The `<TODO subagent prose>` placeholder string is exactly that literal — script writes it, subagent's manifest-validation test catches its absence pre-commit | Task 3.15 (script writes the literal); Task 4.3 (`validateManifestSubagentStage` test catches placeholder presence in affected_files); P2 fix (validator also scans `semantic_edits` field values for the literal). |
| I-6 | All file-overlap checks treat directory tokens (trailing `/`) as prefix matchers and file tokens as exact matches per spec §5.1 step 3 + §3a.4 step 2a | Phase 3 fixtures 03 / 05 / 06 / 07 + Task 3.6 `extractFileReferences: directory-token (trailing slash) goes to directories not files` test. |
| I-7 | `--candidate-ns` and `--auto-create` are mutually exclusive — passing both or neither → exit ≥6 | Task 3.7 mutual-exclusion test + P4 fix (exit-code ≥6 assertion on the thrown ParseArgsError). |

---

## Decisions Locked During Planning

This section pre-resolves spec §11 open questions and review-surfaced ambiguities so downstream tasks have unambiguous targets. Cite this section by `Refs: Plan §Decisions-Locked` from any task that depends on a locked decision.

### D-1 (resolves spec §11 Q11.4): Prompt template canonicalization

The housekeeper subagent prompt template's canonical form lives in `.claude/skills/plan-execution/references/post-merge-housekeeper-contract.md` (authored in Phase 4, Task 4.2). The script holds an in-source template-string copy that is reproduced verbatim from the contract; a Layer 2 snapshot test (Phase 4, Task 4.8 step 1) pins the script's emitted prompt against the contract's `## Canonical Subagent Prompt Template` fenced block so drift is caught at CI time. Rationale: prevents script/subagent template divergence under the dual-source pattern already used by `preflight.mjs` ↔ `preflight-contract.md`.

### D-2 (resolves spec §11 Q11.6): Subagent set-quantifier reverification scope is `cross-plan-dependencies.md` §6 prose only

For set-quantifier reverification (the protection that motivates Q11.6 — re-deriving claims like "ready set shares no files with X" / "all Y are Z" / "no W in the list does Q" against post-merge state), the housekeeper subagent reads ONLY the prose paragraphs in `docs/architecture/cross-plan-dependencies.md` §6 (the `## 6. Active Next Steps DAG` section's intro/closing prose plus inline narrative between NS entries) — NOT the NS catalog item bodies, NOT adjacent docs, NOT the design spec's §6 (which is `## 6. Data flow`, a system description with no enumerable claim set). This is option (c) in spec §11 Q11.6 (which contextually scopes "§6" to `cross-plan-dependencies.md` §6 — option (a) of the same Q11.6 explicitly names that file). Rationale per spec: narrowest scope, no false-positive sweep, caps protection at §6-resident claims (claims in other docs covered by Layer 4 only). The subagent of course also reads its own manifest input and the merged commit context for completion-prose composition; the §6-prose-only constraint applies specifically to the set-quantifier reverification surface.

### D-3 (resolves spec §11 Q11.7): Phase E ticks ALL Phase boxes

When Phase E fires after a multi-Phase merge, the housekeeper ticks ALL boxes in the plan's `## Done Checklist` corresponding to the merged Phase (not just the most recent task). This matches spec §5.1 step 7 verbatim: "Tick **all** boxes (rationale: Q11.7 — Phase E only fires after a complete Phase merges)." Rationale: Phase E is gated by the orchestrator's "complete Phase merge" trigger, so partial-tick semantics would contradict the trigger contract.

### D-4 (review A5): `--task` flag accepts three forms

The script's `parseArgs --task` value MUST satisfy this regex:

```
/^(T\d+(\.\d+)?|T-\d{3}-\d+-\d+|tier-\d+)$/
```

Three accepted forms:

- `T<N>` or `T<N.M>` — phase- or sub-task IDs from non-cross-plan plans (e.g. `T5`, `T5.1`)
- `T-NNN-N-N` — cross-plan task IDs from `docs/plans/NNN-...` (e.g. `T-001-5-1`)
- `tier-K` — Tier-K range-form audits (e.g. `tier-3` for the §4.3.2 rule-3 single-tier audit; `tier-3-9` is REJECTED — range merges always use the lower endpoint)

Rationale (review A5): the spec §4.3.2 rule-3 lookup permits `Tier-K` but the original parseArgs regex rejected it; the rule cannot fire if the script can't accept the input.

### D-5 (review A7): Backlog reservation BL-109

The downstream lifecycle-drift work referenced in Task 4.6 (recovery-doc edits) is reserved as **BL-109** with the title:

> Reconcile `.agents/tmp/` lifecycle drift between `state-recovery.md` and `lefthook.yml`

`docs/backlog.md` next-free is BL-109 (BL-108 is the last active item; BL-101..BL-105, BL-107 are archived). The plan SHALL not introduce a literal `BL-NNN` placeholder anywhere — every backlog cite is `BL-109`.

### D-6 (review A4): Fixture 00 harness allowlist-skip

Fixture `00-loader-smoke` (Phase 3, Task 3.20) is the only fixture that omits `docs/architecture/cross-plan-dependencies.md` because its purpose is to assert the script's loader rejects an empty plan-file with exit 5 BEFORE touching the catalog. The fixture-harness loop in Task 3.20 step 4 SHALL guard with:

```js
if (fixture === "00-loader-smoke") continue; // smoke-only fixture; loader rejects before catalog read
```

Rationale: the harness's `runHousekeeper` invocation expects the catalog file to exist for §3a.4 file-reference extraction; without the skip, the catalog-loader would crash before the loader-rejection codepath is reached.

### D-7 (review AdvF-1): §5.5 17-row → fixture / unit-test coverage matrix

The 17 rows of spec §5.5 verification table map to test artifacts as follows. Phase 3 fixtures use the names already declared in Tasks 3.20-3.29 (no renames needed); the matrix adds two NEW fixtures (`11-tier-range-audit`, `12-auto-create`) authored under new Tasks 3.30 and 3.31 to close the §5.5 coverage gap. Phase 4 unit tests cover the rows that depend on subagent-stage behavior. Phase 3 arg-parsing tests cover the row that tests the script's CLI surface.

| §5.5 row | Scenario | Test artifact | Where authored |
| --- | --- | --- | --- |
| 1 | Single-PR plan, single-Phase merge → all Phase tasks tick + Status `completed` | fixture `01-single-pr-happy-path` | Task 3.20 |
| 2 | Multi-PR plan, leaf-PR merge → row tick + Status `in_progress` (no auto-complete) | fixture `02-multi-pr-tick-only` | Task 3.21 |
| 3 | Multi-PR plan, last-PR merge → row tick + recompute → Status `completed` | fixture `03-multi-pr-completion` | Task 3.22 |
| 4 | Multi-PR with upstream blocked → blocked-override per spec §3a.2 row 5 | fixture `04-multi-pr-blocked-upstream` | Task 3.23 |
| 5 | No-NS-match (no candidate matches inputs) → exit 1 | fixture `05-exit-1-no-ns-match` | Task 3.24 |
| 6 | Zero-NS file-overlap (file_overlap=zero) → SOFT-WARN exit 0 | fixture `06-exit-2-file-overlap-zero` (renamed per P6) | Task 3.25 |
| 7 | Plan has no Done Checklist sub-section → exit 3 | fixture `07-exit-3-no-checklist` | Task 3.26 |
| 8 | Multi-PR entry but `--task` arg missing → exit 4 | fixture `08-exit-4-multi-pr-no-task-id` | Task 3.27 |
| 9 | `PRs:` block schema-violation (missing PR/date annotation on checked row) → exit 5 | fixture `09-exit-5-schema-violation-malformed-prs` | Task 3.28 |
| 10 | Mermaid `:::ready` immediately followed by edge syntax (`--> NS02`) → regex captures class only | fixture `10-mermaid-class-attachment-variant` | Task 3.29 |
| 11 | Tier-K range-form audit lookup against actual NS catalog (rule 3, range form `tier-3`) | fixture `11-tier-range-audit` (NEW) | Task 3.30 (NEW) |
| 12 | Subagent receives prompt with all required §5.3 fields | Phase 4 unit test (snapshot vs Task 4.2 contract) | Task 4.8 |
| 13 | Subagent emits manifest matching schema (no `<TODO>` placeholders) | Phase 4 unit test (zod parse against §5.3 schema) | Task 4.8 |
| 14 | Manifest's `affected_files` superset of script-detected file overlap | Phase 4 unit test (set-superset assertion) | Task 4.8 |
| 15 | Subagent edits files outside `affected_files` → routing rule fires DONE_WITH_CONCERNS | Phase 4 unit test (sprawl-detection helper) + routing rule 20 in failure-modes.md | Task 4.8 (helper test) + Task 4.7 (routing rule prose) |
| 16 | `--auto-create` creates new NS row when no candidate matches AND user passed `--auto-create` | fixture `12-auto-create` (NEW) | Task 3.31 (NEW) |
| 17 | `--candidate-ns` and `--auto-create` mutually exclusive (exit ≥6); plan/task/tier required for non-cleanup discovery | Phase 3 arg-parsing test | Task 3.7 |

The matrix lives canonically here; Phase 3 fixture-author tasks (3.20-3.31) reference rows by number ("this fixture covers §5.5 row N, see Plan §Decisions-Locked D-7"). Rationale: spec §5.5 is the verification floor; without an explicit row→artifact mapping, individual fixtures could ship without ever covering rows 11/14/15/16.

Numbering note: the original Phase 3 ended at Task 3.31 (Open the PR). With NEW Tasks 3.30 (fixture 11) and 3.31 (fixture 12), the prior CI step + PR tasks are renumbered to Tasks 3.32 (CI) and 3.33 (PR) — see those tasks below for the renumbered headings.

---

## Phase 1 — PR 1: NS-23 Schema Amendment + `PRs:` Block Migration

**Goal:** Author NS-23 in §6 (per spec §3a.3 verbatim shape) AND migrate NS-02 / NS-04 / NS-15..NS-21 to the new `PRs:` block grammar (per spec §3a.1). Manually housekept (housekeeper doesn't exist yet).

**Branch:** `feat/ns-23-schema-amendment` **Estimated PR size:** ~150 line diff in `docs/architecture/cross-plan-dependencies.md` (one new entry + four migrated entries + one mermaid node line + one classDef line wherever §6 mermaid block defines the `:::completed` class).

### Task 1.1: Insert NS-23 entry into §6

**Files:**

- Modify: `docs/architecture/cross-plan-dependencies.md` — append new `### NS-23: §6 schema amendment for multi-PR housekeeping` heading + body after the highest existing NS entry (currently NS-22 at lines 502-510 per spec §1.1.1)

- [ ] **Step 1: Locate insertion point**

```bash
grep -n "^### NS-" docs/architecture/cross-plan-dependencies.md | tail -5
```

Expected output: NS-15..NS-21 (range) and NS-22 are the last two; the NS-22 entry ends before the §7 "Maintenance" heading. Find that boundary line.

- [ ] **Step 2: Insert NS-23 verbatim from spec §3a.3**

Insert this block AFTER NS-22's `- Exit Criteria:` line and BEFORE the `## 7.` heading (path form is `../<tree>/` because we're INSIDE `docs/architecture/`, not from the spec's POV):

```markdown
### NS-23: §6 schema amendment for multi-PR housekeeping

- Status: `todo`
- Type: governance (doc-only)
- Priority: `P1`
- Upstream: none
- References: [housekeeper design](../superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md) §3a
- Summary: Add structured `PRs:` sub-field to NS-02, NS-04, NS-15..NS-21 per the housekeeper design's §3a.1 grammar. Single-PR entries (NS-01, NS-03, NS-05..NS-10, NS-11, NS-13a, NS-13b, NS-14, NS-22) are unchanged. The amendment is the first dogfood for the housekeeper itself: NS-23's Status flips to `completed` MANUALLY when this PR merges (the housekeeper does not exist yet to auto-flip it). The next plan-execution PR after the housekeeper ships (PR 4 in §10.1) is the housekeeper's first auto-run.
- Exit Criteria: §6 entries NS-02, NS-04, NS-15..NS-21 carry `PRs:` blocks per §3a.1 grammar; `- Status: \`completed\` (resolved YYYY-MM-DD via this commit — schema amendment landed; housekeeper design §3a in-scope)` recorded inline on this entry.
```

- [ ] **Step 3: Verify cite-target hook passes for the insertion**

```bash
node --experimental-strip-types tools/docs-corpus/bin/pre-commit-runner.ts docs/architecture/cross-plan-dependencies.md
```

Expected: no output (hook silent on success). The `../superpowers/specs/...md` link must resolve from `docs/architecture/`'s POV (`..` → `docs/`, then descend into `superpowers/specs/`).

### Task 1.2: Add NS-23 to mermaid graph

**Files:**

- Modify: `docs/architecture/cross-plan-dependencies.md` mermaid graph block (§6, lines 282-336 per spec §1.1.1 reference)

- [ ] **Step 1: Open the mermaid block; find the last NS-NN node line + the existing `classDef` block at the bottom**

```bash
grep -n "classDef\|NS22" docs/architecture/cross-plan-dependencies.md
```

Expected: The mermaid block ends with `classDef ready ...`, `classDef blocked ...`, `classDef completed ...` definitions. NS22 is the last NS node line.

- [ ] **Step 2: Add NS-23 node line immediately after NS-22's node line, with `:::ready` class**

The node form per spec §1.1.2 mermaid mapping: `NS23[NS-23: §6 schema amendment<br/>multi-PR housekeeping]:::ready`

- [ ] **Step 3: Verify the diagram still renders**

```bash
grep -A 1 "NS23" docs/architecture/cross-plan-dependencies.md
```

Expected: line shape `    NS23[NS-23: §6 schema amendment<br/>multi-PR housekeeping]:::ready` (indentation matches surrounding mermaid lines).

### Task 1.3: Migrate NS-02 to `PRs:` block

**Files:**

- Modify: `docs/architecture/cross-plan-dependencies.md` NS-02 entry (heading at the line returned by `grep -n "^### NS-02" docs/architecture/cross-plan-dependencies.md`)

- [ ] **Step 1: Read NS-02's current body**

```bash
grep -n "^### NS-02" docs/architecture/cross-plan-dependencies.md
```

Then `sed -n '<start>,<+15>p' docs/architecture/cross-plan-dependencies.md` (or use `Read` with `offset` and `limit`).

- [ ] **Step 2: Append `- PRs:` block after `- Exit Criteria:` line**

Per spec §3a.1, the block's grammar is:

```markdown
- PRs:
  - [x] T5.1 — sessionClient + I1-I4 integration tests (PR #34, merged 2026-05-04)
  - [ ] T5.5 — pg.Pool-backed Querier composition
  - [ ] T5.6 — strengthen createSession lock-ordering test
```

If T5.1 has already shipped (PR #34 per spec §3a.1's NS-02 example), the first item is checked with the merge annotation; T5.5/T5.6 are unchecked. Verify T5.1's actual PR number and merge date via `git log --oneline | grep "T5.1"` before writing.

- [ ] **Step 3: Update NS-02's `- Status:` to reflect `PRs:` recompute**

Per spec §3a.2 matrix row "≥1 checked, ≥1 unchecked, no upstream-blocked": `- Status: \`in_progress\` (last shipped: PR #<N>, YYYY-MM-DD)`.

- [ ] **Step 4: Verify the block parses correctly**

```bash
grep -A 4 "^- PRs:" docs/architecture/cross-plan-dependencies.md | head -20
```

Expected: shows the migrated NS-02 `PRs:` block with correct indentation (`  - [x]` / `  - [ ]`).

### Task 1.4: Migrate NS-04 to `PRs:` block

**Files:**

- Modify: `docs/architecture/cross-plan-dependencies.md` NS-04 entry (heading at line ~372 per spec §1.1.1; verify with grep)

- [ ] **Step 1: Read NS-04's current body** (procedure same as 1.3 step 1).

- [ ] **Step 2: Append `- PRs:` block per spec §3a.1**

NS-04 is a cross-plan PR pair, internally a 3-step sequence (per its `- Type:` qualifier). Each PR/step gets one task-id row:

```markdown
- PRs:
  - [ ] T-024-2-1 — pty-host.ts contract types (Plan-024 side)
  - [ ] T5.4 — spawn-cwd-translator.ts wiring (Plan-001 side)
  - [ ] T-024-2-1.integration — RustSidecarPtyHost↔NodePtyHost handoff smoke test
```

Adjust task-ids and descriptions to match Plan-024 §Phase 2 + Plan-001 §T5.4's actual breakdown — read those plan sections before authoring (they are the source of truth, not the spec's example wording).

- [ ] **Step 3: Update NS-04's `- Status:`** per spec §3a.2 matrix: if all unchecked → `\`todo\``; if any blocked-upstream → `\`blocked\``.

- [ ] **Step 4: Verify block grammar**

```bash
grep -B 2 -A 5 "T-024-2-1" docs/architecture/cross-plan-dependencies.md
```

Expected: NS-04's `- PRs:` block shows the three task-id rows correctly nested under the `- PRs:` bullet.

### Task 1.5: Migrate NS-15..NS-21 to `PRs:` block

**Files:**

- Modify: `docs/architecture/cross-plan-dependencies.md` NS-15..NS-21 range entry (heading at line ~492 per spec §1.1.1)

- [ ] **Step 1: Read the range entry's current body**

```bash
grep -n "^### NS-15..NS-21" docs/architecture/cross-plan-dependencies.md
```

- [ ] **Step 2: Append `- PRs:` block with one row per tier (K=3 through K=9)**

Per spec §5.5 row 17: "multi-PR shape: `PRs:` block tick per §3a.1 (one tier per box, K=3..9)". The block:

```markdown
- PRs:
  - [ ] tier-3 — Plan-003 plan-readiness audit (Tier 3)
  - [ ] tier-4 — Plan-004 plan-readiness audit (Tier 4)
  - [ ] tier-5 — Plan-005 plan-readiness audit (Tier 5)
  - [ ] tier-6 — Plan-006 plan-readiness audit (Tier 6)
  - [ ] tier-7 — Plan-007 plan-readiness audit (Tier 7)
  - [ ] tier-8 — Plan-008 plan-readiness audit (Tier 8)
  - [ ] tier-9 — Plan-009 plan-readiness audit (Tier 9)
```

The `<task-id>` for audits is the tier-K identifier (e.g., `tier-3`); the housekeeper's heading-token matcher already extracts `Tier <K>` substrings (per spec §4.3.2 rule 4 range arithmetic), so the task-id need not duplicate the tier substring elsewhere in the row.

- [ ] **Step 3: Verify block grammar via the directory-listing pattern**

```bash
grep -B 1 -A 10 "^- PRs:" docs/architecture/cross-plan-dependencies.md | grep "tier-"
```

Expected: 7 rows, all unchecked, grammar matches `  - [ ] tier-K — ...`.

### Task 1.6: Manually flip NS-23 status to completed (the inline NS-12-precedent record)

**Files:**

- Modify: `docs/architecture/cross-plan-dependencies.md` — NS-23's `- Status:` line authored in Task 1.1

- [ ] **Step 1: Replace `- Status: \`todo\`` with the completed-with-inline-resolution form**

Per spec §3a.3 NS-23 Exit Criteria, the form is exactly (date pinned to plan-write date 2026-05-03 per P3 fix):

```markdown
- Status: `completed` (resolved 2026-05-03 via this commit — schema amendment landed; housekeeper design §3a in-scope)
```

If the PR doesn't merge on 2026-05-03 (the plan-write date) — e.g., it sits in review for several days — UPDATE this date to the actual merge date BEFORE squash-merge, in the same `develop`-bound feature-branch tip commit. Do NOT amend after merge: per the GitFlow-lite branch model the squash commit is final. The date written here MUST equal the date `git log --pretty=format:'%cs' -1` would report on the squash-merge commit when it lands.

- [ ] **Step 2: Re-color NS-23 in the mermaid graph from `:::ready` to `:::completed`**

Modify the line authored in Task 1.2: change `:::ready` → `:::completed`.

- [ ] **Step 3: Verify both are in sync**

```bash
grep -A 8 "^### NS-23" docs/architecture/cross-plan-dependencies.md && grep "NS23\[" docs/architecture/cross-plan-dependencies.md
```

Expected: heading body shows `Status: \`completed\` (...)`, mermaid line shows `NS23[...]:::completed`.

### Task 1.7: Run pre-commit hooks and commit

**Files:**

- Modify: `docs/architecture/cross-plan-dependencies.md` (already staged from Tasks 1.1-1.6)

- [ ] **Step 1: Stage the file**

```bash
git add docs/architecture/cross-plan-dependencies.md
```

- [ ] **Step 2: Run docs-corpus-checks standalone (faster than full lefthook chain)**

```bash
node --experimental-strip-types tools/docs-corpus/bin/pre-commit-runner.ts docs/architecture/cross-plan-dependencies.md
```

Expected: silent (no violations).

- [ ] **Step 3: Run full lefthook pre-commit chain**

```bash
git commit -m "$(cat <<'EOF'
docs(repo): NS-23 schema amendment + PRs: block migration

Authors NS-23 inline (manually housekept; the housekeeper subagent
doesn't exist yet to auto-flip it). Migrates NS-02, NS-04, NS-15..NS-21
to the structured \`PRs:\` block grammar per Spec
docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md
§3a.1.

Refs: NS-23, Spec docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md §3a.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit lands. If hooks fail, fix the surfaced issue and create a NEW commit (do not amend per CLAUDE.md commit discipline).

- [ ] **Step 4: Push + open PR**

```bash
git push -u origin feat/ns-23-schema-amendment
gh pr create --title "docs(repo): NS-23 schema amendment + PRs: block migration" --body "$(cat <<'EOF'
## Summary
- Authors NS-23 entry in §6 of cross-plan-dependencies.md (manually housekept; flipped to \`completed\` inline per NS-12 precedent — the housekeeper subagent doesn't exist yet to auto-flip it).
- Migrates NS-02, NS-04, NS-15..NS-21 to the structured \`- PRs:\` block grammar per Spec §3a.1.
- Updates §6 mermaid graph: NS23 node added, then re-colored \`:::completed\` to match the inline-completed Status.

## Refs
- Spec: docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md §3a, §3a.1, §3a.3
- Plan: docs/superpowers/plans/2026-05-03-plan-execution-housekeeper-implementation.md §Phase 1

## Test plan
- [ ] CI green
- [ ] Codex 👍
- [ ] 0 unresolved threads

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

#### Done Checklist

The housekeeper subagent ticks these boxes in Phase E after PR 1 squash-merges. Until then, leave unchecked. (Manual flip for PR 1 only — the housekeeper doesn't exist yet at PR-1 merge time; PR 4 is its first auto-run per spec §10.2.)

- [ ] Task 1.1 — NS-23 entry inserted into §6
- [ ] Task 1.2 — NS-23 added to mermaid graph
- [ ] Task 1.3 — NS-02 migrated to `PRs:` block
- [ ] Task 1.4 — NS-04 migrated to `PRs:` block
- [ ] Task 1.5 — NS-15..NS-21 migrated to `PRs:` block
- [ ] Task 1.6 — NS-23 status flipped to `completed` inline
- [ ] Task 1.7 — pre-commit hooks run + commit + PR opened + merged

---

## Phase 2 — PR 2: `preflight-contract.md` Move + Path Updates

**Goal:** Relocate `preflight-contract.md` from `scripts/` to `references/` (uniform layout with the new `post-merge-housekeeper-contract.md` per spec §9.1) AND update 5 inline references.

**Branch:** `chore/move-preflight-contract` **Estimated PR size:** 1 file move + 5 inline path edits.

This is small and low-risk; the spec marks PR 2 as bundle-able into PR 3. If bundling, complete these tasks on the Phase 3 branch and call them out in the Phase 3 commit body.

### Task 2.1: Move the file via `git mv` (preserves blame)

**Files:**

- Move: `.claude/skills/plan-execution/scripts/preflight-contract.md` → `.claude/skills/plan-execution/references/preflight-contract.md`

- [ ] **Step 1: Move with `git mv`**

```bash
git mv .claude/skills/plan-execution/scripts/preflight-contract.md .claude/skills/plan-execution/references/preflight-contract.md
```

- [ ] **Step 2: Verify `git status` shows the rename**

```bash
git status --short
```

Expected: `R .claude/skills/plan-execution/scripts/preflight-contract.md -> .claude/skills/plan-execution/references/preflight-contract.md` (rename detected).

### Task 2.2: Update path reference at `preflight.mjs` line 3

**Files:**

- Modify: `.claude/skills/plan-execution/scripts/preflight.mjs:3` (header comment)

The current line uses a relative-from-scripts/ path (`./preflight-contract.md`). After the move, the contract lives one level up under `references/`, so the relative path becomes `../references/preflight-contract.md`.

- [ ] **Step 1: Verify the exact pre-move text**

```bash
sed -n '3p' .claude/skills/plan-execution/scripts/preflight.mjs
```

Expected output (verbatim, including leading `// `):

```
// Authoritative contract: ./preflight-contract.md.
```

If the line has drifted from this exact form, STOP and reconcile manually before applying step 2.

- [ ] **Step 2: Apply Edit with exact old_string / new_string**

Use the Edit tool (NOT sed) with:

- `file_path`: `.claude/skills/plan-execution/scripts/preflight.mjs`
- `old_string`: `// Authoritative contract: ./preflight-contract.md.`
- `new_string`: `// Authoritative contract: ../references/preflight-contract.md.`

- [ ] **Step 3: Verify the edit landed**

```bash
sed -n '3p' .claude/skills/plan-execution/scripts/preflight.mjs
```

Expected: `// Authoritative contract: ../references/preflight-contract.md.`

### Task 2.3: Update path reference at `preflight.mjs` line 544

**Files:**

- Modify: `.claude/skills/plan-execution/scripts/preflight.mjs:544` (usage-error message body)

The current line is a JS string literal embedded in an error message. The bare filename `preflight-contract.md` (no relative-path qualifier) is the actual substring; after the move, replace it with `../references/preflight-contract.md` to give the user a path that resolves from the script's own directory.

- [ ] **Step 1: Verify the exact pre-move text**

```bash
sed -n '542,547p' .claude/skills/plan-execution/scripts/preflight.mjs
```

Expected output around line 544 (verbatim, including leading whitespace and trailing comma):

```
      "Usage: node preflight.mjs <plan-file> [phase-number]\nSee preflight-contract.md.\n",
```

If the line has drifted from this exact form, STOP and reconcile manually before applying step 2.

- [ ] **Step 2: Apply Edit with exact old_string / new_string**

Use the Edit tool (NOT sed) with:

- `file_path`: `.claude/skills/plan-execution/scripts/preflight.mjs`
- `old_string`: `      "Usage: node preflight.mjs <plan-file> [phase-number]\nSee preflight-contract.md.\n",`
- `new_string`: `      "Usage: node preflight.mjs <plan-file> [phase-number]\nSee ../references/preflight-contract.md.\n",`

- [ ] **Step 3: Verify the edit landed**

```bash
sed -n '544p' .claude/skills/plan-execution/scripts/preflight.mjs
```

Expected: contains the substring `See ../references/preflight-contract.md.`

### Task 2.4: Update path references at `SKILL.md` lines 142, 507, 518

**Files:**

- Modify: `.claude/skills/plan-execution/SKILL.md` (3 cite lines per spec §9.3)

- [ ] **Step 1: Read each line range**

```bash
sed -n '140,144p;505,520p' .claude/skills/plan-execution/SKILL.md
```

- [ ] **Step 2: Update each `scripts/preflight-contract.md` reference to `references/preflight-contract.md`**

Three Edit calls (one per line). Verify all three are distinct enough that `replace_all` won't over-substitute — if they're not, edit each individually using surrounding context.

### Task 2.5: Verify nothing else references the old path

**Files:**

- Read: any file that may still cite `scripts/preflight-contract.md`

- [ ] **Step 1: Grep the repo for the old path**

```bash
grep -rn "scripts/preflight-contract.md" .claude/ docs/
```

Expected: no matches (or only matches inside the spec's verbatim NS quote blocks under `docs/superpowers/specs/`, which are illustrations and don't need updating).

- [ ] **Step 2: Stage + commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(repo): move preflight-contract.md to references/

Relocates preflight-contract.md from scripts/ to references/ to keep
the skill's directory layout uniform — markdown contract docs belong
in references/, scripts/ only holds executable .mjs files. Updates
five inline path references (preflight.mjs lines 3, 537; SKILL.md
lines 142, 507, 518).

Refs: Spec docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md §9.1, §9.3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push -u origin chore/move-preflight-contract
gh pr create --title "chore(repo): move preflight-contract.md to references/" --body "..."
```

#### Done Checklist

The housekeeper subagent ticks these boxes in Phase E after PR 2 squash-merges. (Manual flip for PR 2 only — same reason as Phase 1.)

- [ ] Task 2.1 — `git mv scripts/preflight-contract.md → references/preflight-contract.md`
- [ ] Task 2.2 — `preflight.mjs:3` path reference updated
- [ ] Task 2.3 — `preflight.mjs:544` path reference updated
- [ ] Task 2.4 — `SKILL.md` lines 142/507/518 path references updated
- [ ] Task 2.5 — repo-wide grep confirms zero remaining `scripts/preflight-contract.md` references outside spec quote blocks; commit + PR opened + merged

---

## Phase 3 — PR 3: Author script + tests + CI wiring

**Goal:** Build `post-merge-housekeeper.mjs` end-to-end (mechanical-stage logic; both `--candidate-ns` and `--auto-create` modes) with 10 fixture-driven Layer 1 tests + pure-parser unit tests + GitHub Actions CI wiring per spec §10.4(a).

**Branch:** `feat/post-merge-housekeeper-script` **Estimated PR size:** ~1500 lines of new code (script ~700, tests ~400, fixtures ~400 across 10 directories), 1 CI yaml step.

This is the largest PR. Tasks are TDD-shaped: write the failing test first, run it, implement the minimum to pass, run again, commit.

### Task 3.1: Set up fixture loader helper (foundation for all fixture-driven tests)

**Files:**

- Create: `.claude/skills/plan-execution/scripts/__tests__/helpers/fixture-loader.mjs`
- Create: `.claude/skills/plan-execution/scripts/__tests__/helpers/__tests__/fixture-loader.test.mjs`
- Create: `.claude/skills/plan-execution/scripts/__tests__/fixtures/00-loader-smoke/{input,expected,args.json,expected-manifest.json}` (a trivial fixture exercising the loader without touching real housekeeper logic)

- [ ] **Step 1: Write loader test (failing — module doesn't exist yet)**

```js
// .claude/skills/plan-execution/scripts/__tests__/helpers/__tests__/fixture-loader.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { listFixtures, readArgs, readExpectedManifest } from "../fixture-loader.mjs";

test("listFixtures returns all immediate subdirectories of fixtures/", () => {
  const fixtures = listFixtures(new URL("../../fixtures", import.meta.url).pathname);
  assert.ok(fixtures.length >= 1);
  assert.ok(
    fixtures.every(
      (f) =>
        typeof f.name === "string" &&
        typeof f.inputDir === "string" &&
        typeof f.expectedDir === "string",
    ),
  );
});

test("readArgs parses args.json into the runHousekeeper-shaped args", () => {
  const fixture = listFixtures(new URL("../../fixtures", import.meta.url).pathname).find(
    (f) => f.name === "00-loader-smoke",
  );
  const args = readArgs(fixture);
  assert.equal(typeof args.prNumber, "number");
});
```

- [ ] **Step 2: Run test (expected: FAIL — module not found)**

```bash
node --test --experimental-strip-types .claude/skills/plan-execution/scripts/__tests__/helpers/__tests__/fixture-loader.test.mjs
```

Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module ... fixture-loader.mjs`.

- [ ] **Step 3: Create the fixture-loader.mjs module**

```js
// .claude/skills/plan-execution/scripts/__tests__/helpers/fixture-loader.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export function listFixtures(fixturesDir) {
  return readdirSync(fixturesDir)
    .filter((name) => statSync(join(fixturesDir, name)).isDirectory())
    .map((name) => ({
      name,
      inputDir: join(fixturesDir, name, "input"),
      expectedDir: join(fixturesDir, name, "expected"),
      argsPath: join(fixturesDir, name, "args.json"),
      expectedManifestPath: join(fixturesDir, name, "expected-manifest.json"),
    }));
}

export function readArgs(fixture) {
  return JSON.parse(readFileSync(fixture.argsPath, "utf8"));
}

export function readExpectedManifest(fixture) {
  return JSON.parse(readFileSync(fixture.expectedManifestPath, "utf8"));
}

export function expectFilesEqual(actualDir, expectedDir) {
  // Walk expectedDir; for each expected file, assert actualDir has the same path with byte-equal content.
  // Implementation: recursive readdir + readFileSync compare. Throw on mismatch with a unified-diff-style message.
  // Defer the diff prettifier to a subsequent task if helpful — for now, throw with the file path + first differing line.
  // (Full body omitted here for plan brevity; mirror the shape used in preflight.test.mjs's expectation helpers.)
}
```

- [ ] **Step 4: Author 00-loader-smoke fixture**

Create `__tests__/fixtures/00-loader-smoke/`:

```
input/README.md       (single line "smoke")
expected/README.md    (single line "smoke")
args.json             ({"prNumber": 1, "candidateNs": "NS-01"})
expected-manifest.json  ({"pr_number": 1})
```

- [ ] **Step 5: Re-run test (expected: PASS)**

```bash
node --test --experimental-strip-types .claude/skills/plan-execution/scripts/__tests__/helpers/__tests__/fixture-loader.test.mjs
```

Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/plan-execution/scripts/__tests__/helpers/ .claude/skills/plan-execution/scripts/__tests__/fixtures/00-loader-smoke/
git commit -m "test(repo): scaffold fixture-loader helper for housekeeper tests"
```

### Task 3.2: Pure parser — `parseNsHeading`

**Files:**

- Create: `.claude/skills/plan-execution/scripts/post-merge-housekeeper.mjs` (initial scaffold + first export)
- Create: `.claude/skills/plan-execution/scripts/__tests__/post-merge-housekeeper.test.mjs` (initial test file with `parseNsHeading` cases)

- [ ] **Step 1: Write `parseNsHeading` test cases (failing)**

```js
// .claude/skills/plan-execution/scripts/__tests__/post-merge-housekeeper.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNsHeading } from "../post-merge-housekeeper.mjs";

test("parseNsHeading parses plain numeric NS heading", () => {
  const result = parseNsHeading("### NS-01: Plan-024 Phase 1 — Rust crate scaffolding");
  assert.deepEqual(result, {
    nsNum: 1,
    suffix: null,
    rangeUpperNum: null,
    title: "Plan-024 Phase 1 — Rust crate scaffolding",
  });
});

test("parseNsHeading parses NS heading with suffix letter", () => {
  const result = parseNsHeading("### NS-13a: Spec-status promotion gate clarification");
  assert.deepEqual(result, {
    nsNum: 13,
    suffix: "a",
    rangeUpperNum: null,
    title: "Spec-status promotion gate clarification",
  });
});

test("parseNsHeading parses range-form NS heading", () => {
  const result = parseNsHeading("### NS-15..NS-21: Tier 3-9 plan-readiness audits");
  assert.deepEqual(result, {
    nsNum: 15,
    suffix: null,
    rangeUpperNum: 21,
    title: "Tier 3-9 plan-readiness audits",
  });
});

test("parseNsHeading returns null for non-NS heading", () => {
  assert.equal(parseNsHeading("### 1.1 The §6 NS-XX convention"), null);
  assert.equal(parseNsHeading("- Status: `todo`"), null);
});
```

- [ ] **Step 2: Run test (expected: FAIL — module / function not defined)**

```bash
node --test --experimental-strip-types .claude/skills/plan-execution/scripts/__tests__/post-merge-housekeeper.test.mjs
```

- [ ] **Step 3: Implement `parseNsHeading` in post-merge-housekeeper.mjs**

Per spec §5.1 step 1, the regex is `^### NS-(\d+)(?:\.\.NS-(\d+))?([a-z])?: (.+)$`.

```js
// .claude/skills/plan-execution/scripts/post-merge-housekeeper.mjs
const NS_HEADING_RE = /^### NS-(\d+)(?:\.\.NS-(\d+))?([a-z])?: (.+)$/;

export function parseNsHeading(line) {
  const m = NS_HEADING_RE.exec(line);
  if (!m) return null;
  return {
    nsNum: Number(m[1]),
    suffix: m[3] ?? null,
    rangeUpperNum: m[2] ? Number(m[2]) : null,
    title: m[4],
  };
}
```

- [ ] **Step 4: Run test (expected: PASS, 4 tests)**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(repo): parseNsHeading parser for housekeeper script"
```

### Task 3.3: Pure parser — `parseSubFields`

**Files:**

- Modify: `.claude/skills/plan-execution/scripts/post-merge-housekeeper.mjs` (add `parseSubFields`)
- Modify: `.claude/skills/plan-execution/scripts/__tests__/post-merge-housekeeper.test.mjs` (add cases)

- [ ] **Step 1: Write tests (failing)**

```js
import { parseSubFields } from "../post-merge-housekeeper.mjs";

test("parseSubFields extracts the seven required sub-fields", () => {
  const body = `- Status: \`todo\`
- Type: code
- Priority: \`P1\`
- Upstream: none
- References: [Plan-024](../plans/024-rust-pty-sidecar.md)
- Summary: prose
- Exit Criteria: ticked`;
  const result = parseSubFields(body);
  assert.equal(result.status.atomic, "todo");
  assert.equal(result.type, "code");
  assert.equal(result.priority.atomic, "P1");
  assert.equal(result.upstream, "none");
  assert.match(result.references, /Plan-024/);
  assert.equal(result.summary, "prose");
  assert.equal(result.exit_criteria, "ticked");
});

test("parseSubFields returns null sub-fields when absent (don't throw)", () => {
  const body = `- Status: \`todo\`
- Type: code`;
  const result = parseSubFields(body);
  assert.equal(result.priority, null);
  assert.equal(result.references, null);
});
```

- [ ] **Step 2: Run (FAIL — function not defined).**

- [ ] **Step 3: Implement.** Walk lines, match `^- (Status|Type|Priority|Upstream|References|Summary|Exit Criteria): (.+)$`. For Status / Priority extract the backticked atomic via secondary regex `^\`([^\`]+)\`(?:\s+(.+))?$`against the captured value, returning`{ atomic, prose | null }`. Return an object with one key per known sub-field, `null` for absent fields.

- [ ] **Step 4: Run (PASS).**

- [ ] **Step 5: Commit.**

### Task 3.4: Pure parser — `parsePRsBlock`

**Files:**

- Modify: `.claude/skills/plan-execution/scripts/post-merge-housekeeper.mjs` (add `parsePRsBlock`)
- Modify: `.claude/skills/plan-execution/scripts/__tests__/post-merge-housekeeper.test.mjs`

- [ ] **Step 1: Write tests (failing) per spec §3a.1 grammar**

```js
import { parsePRsBlock } from "../post-merge-housekeeper.mjs";

test("parsePRsBlock parses unchecked + checked items with PR annotations", () => {
  const body = `- PRs:
  - [x] T5.1 — sessionClient + I1-I4 integration tests (PR #34, merged 2026-05-04)
  - [ ] T5.5 — pg.Pool-backed Querier composition
  - [ ] T5.6 — strengthen createSession lock-ordering test`;
  const result = parsePRsBlock(body);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], {
    taskId: "T5.1",
    description: "sessionClient + I1-I4 integration tests",
    checked: true,
    prNumber: 34,
    mergedAt: "2026-05-04",
  });
  assert.deepEqual(result[1], {
    taskId: "T5.5",
    description: "pg.Pool-backed Querier composition",
    checked: false,
    prNumber: null,
    mergedAt: null,
  });
});

test("parsePRsBlock returns null when no PRs: block present", () => {
  assert.equal(parsePRsBlock("- Status: `todo`\n- Type: code"), null);
});

test("parsePRsBlock throws on malformed checked-item missing PR annotation", () => {
  const body = `- PRs:\n  - [x] T5.1 — but no annotation`;
  assert.throws(() => parsePRsBlock(body), /missing.*PR.*annotation/i);
});
```

- [ ] **Step 2-5: FAIL → implement → PASS → commit.**

Implementation hints: outer match for `^- PRs:$` line, then iterate following lines until first non-`  - [` line. Per-row regex: `^  - \[([ x])\] ([^—]+) — (.+)$`. For checked rows, secondary regex on the description to extract `(PR #(\d+), merged (\d{4}-\d{2}-\d{2}))` — throw `Error('PRs block malformed: checked task ${taskId} missing required (PR #N, merged YYYY-MM-DD) annotation')` on absence.

### Task 3.5: Pure parser — `computeStatusFromPRs` (the §3a.2 matrix)

**Files:**

- Modify: post-merge-housekeeper.mjs + test file

- [ ] **Step 1: Write tests covering all six matrix rows (failing)**

```js
import { computeStatusFromPRs } from "../post-merge-housekeeper.mjs";

test("computeStatusFromPRs: absent PRs (single-PR) returns single-pr completion", () => {
  const result = computeStatusFromPRs({
    prsBlock: null,
    upstreamBlocked: false,
    today: "2026-05-10",
    prNumber: 42,
  });
  assert.match(
    result,
    /^- Status: `completed` \(resolved 2026-05-10 via PR #42 — <TODO subagent prose>\)/,
  );
});

test("computeStatusFromPRs: all unchecked + no upstream blocked → todo", () => {
  const prsBlock = [{ checked: false }, { checked: false }];
  const result = computeStatusFromPRs({ prsBlock, upstreamBlocked: false });
  assert.equal(result, "- Status: `todo`");
});

test("computeStatusFromPRs: all unchecked + upstream blocked → blocked", () => {
  const prsBlock = [{ checked: false }, { checked: false }];
  const result = computeStatusFromPRs({ prsBlock, upstreamBlocked: true });
  assert.equal(result, "- Status: `blocked`");
});

test("computeStatusFromPRs: ≥1 checked + ≥1 unchecked + no upstream → in_progress (last shipped)", () => {
  const prsBlock = [{ checked: true, prNumber: 34, mergedAt: "2026-05-04" }, { checked: false }];
  const result = computeStatusFromPRs({ prsBlock, upstreamBlocked: false });
  assert.match(result, /^- Status: `in_progress` \(last shipped: PR #34, 2026-05-04\)/);
});

test("computeStatusFromPRs: ≥1 checked + ≥1 unchecked + upstream blocked → blocked override", () => {
  const prsBlock = [{ checked: true }, { checked: false }];
  const result = computeStatusFromPRs({ prsBlock, upstreamBlocked: true });
  assert.match(result, /^- Status: `blocked` \(overrides — see Upstream:/);
});

test("computeStatusFromPRs: all checked → completed (resolved via last sub-task)", () => {
  const prsBlock = [
    { checked: true, prNumber: 34, mergedAt: "2026-05-04" },
    { checked: true, prNumber: 38, mergedAt: "2026-05-10" },
  ];
  const result = computeStatusFromPRs({
    prsBlock,
    upstreamBlocked: false,
    today: "2026-05-10",
    prNumber: 38,
  });
  assert.match(
    result,
    /^- Status: `completed` \(resolved 2026-05-10 via PR #38 — last sub-task; <TODO subagent prose>\)/,
  );
});
```

- [ ] **Step 2-5: FAIL → implement → PASS → commit.**

Implementation: switch on `(prsBlock === null, allChecked, anyChecked, upstreamBlocked)` per spec §3a.2 matrix. Each branch returns the literal Status line shape from the matrix.

### Task 3.6: Pure parser — `extractFileReferences` (§3a.4 heuristic, file/dir kinds + brace expansion)

**Files:**

- Modify: post-merge-housekeeper.mjs + test file

- [ ] **Step 1: Write tests (failing) covering each heuristic axis**

```js
import { extractFileReferences } from "../post-merge-housekeeper.mjs";

test("extractFileReferences: markdown link in References extracts .md path", () => {
  const refs = "[Plan-024](../plans/024-rust-pty-sidecar.md)"; // path extraction only; line-cite parsing tested separately via fixture data
  const summary = "";
  const result = extractFileReferences({
    references: refs,
    summary,
    repoRoot: "/repo",
    entryFile: "/repo/docs/architecture/cross-plan-dependencies.md",
  });
  assert.deepEqual(result.files, ["docs/plans/024-rust-pty-sidecar.md"]);
  assert.deepEqual(result.directories, []);
});

test("extractFileReferences: bare-path token in Summary extracts source-file path", () => {
  const result = extractFileReferences({
    references: "",
    summary: "Modify packages/runtime-daemon/src/bootstrap/secure-defaults-events.ts:24,35,59",
    repoRoot: process.cwd() /* test repo */,
    entryFile: "...",
  });
  assert.ok(
    result.files.includes("packages/runtime-daemon/src/bootstrap/secure-defaults-events.ts"),
  );
});

test("extractFileReferences: directory-token (trailing slash) goes to directories not files", () => {
  const result = extractFileReferences({
    references: "",
    summary: "diff touches packages/runtime-daemon/src/pty/",
    repoRoot: process.cwd(),
    entryFile: "...",
  });
  assert.deepEqual(result.directories, ["packages/runtime-daemon/src/pty/"]);
  assert.deepEqual(result.files, []);
});

test("extractFileReferences: brace expansion produces Cartesian product of nested groups (5 paths, all extant)", () => {
  // Synthetic test against EXTANT packages so the filesystem-resolution filter (next test) sees them as resolved.
  // Shape mirrors the spec §3a.4 NS-01 example (outer brace contains literal entries AND nested groups);
  // the package set below was chosen because every expanded path exists on disk in this repo:
  //   - packages/contracts/src/{session,event,error}.ts  (3 paths)
  //   - packages/runtime-daemon/src/{index,bootstrap/secure-defaults}.ts  (2 paths)
  // Total: 5. Verified extant via `ls packages/{contracts,runtime-daemon}/src/...` at plan-write time
  // (2026-05-03). If the package layout changes before this fixture lands, re-pick five extant paths
  // — DO NOT fall back to the original `packages/sidecar-rust-pty/...` set (those paths do not exist
  // in this repo; using non-extant paths makes the filesystem-resolution filter (next test) coverage
  // meaningless because every expanded entry would also be filtered).
  const summary =
    "Refactor packages/{contracts/src/{session,event,error}.ts,runtime-daemon/src/{index,bootstrap/secure-defaults}.ts}";
  const result = extractFileReferences({
    references: "",
    summary,
    repoRoot: process.cwd(),
    entryFile: "...",
  });
  assert.equal(result.files.length, 5);
  assert.ok(result.files.includes("packages/contracts/src/session.ts"));
  assert.ok(result.files.includes("packages/contracts/src/event.ts"));
  assert.ok(result.files.includes("packages/contracts/src/error.ts"));
  assert.ok(result.files.includes("packages/runtime-daemon/src/index.ts"));
  assert.ok(result.files.includes("packages/runtime-daemon/src/bootstrap/secure-defaults.ts"));
  assert.equal(result.unresolvable.length, 0);
});

test("extractFileReferences: skips Upstream / Type / Status / Priority / Exit Criteria sub-fields per scoping note", () => {
  // Per spec §3a.4 step 5 scoping note: only References + Summary are scanned.
  const result = extractFileReferences({
    references: "",
    summary: "",
    upstream: "Plan-024:267 — packages/contracts/src/session.ts referenced inline",
    repoRoot: process.cwd(),
    entryFile: "...",
  });
  assert.deepEqual(result.files, []);
});

test("extractFileReferences: filesystem-resolution filter discards typos at top level", () => {
  // Path that doesn't exist on disk should be surfaced in `unresolvable` and excluded from `files`.
  const result = extractFileReferences({
    references: "",
    summary: "Modify packages/this-package-does-not-exist/src/foo.ts",
    repoRoot: process.cwd(),
    entryFile: "...",
  });
  assert.equal(result.files.length, 0);
  assert.equal(result.unresolvable.length, 1);
  assert.equal(result.unresolvable[0].path, "packages/this-package-does-not-exist/src/foo.ts");
  assert.equal(result.unresolvable[0].path_kind, "file");
});

test("extractFileReferences: filesystem-resolution filter discards typo'd entries inside a brace expansion", () => {
  // Brace-expansion + filter interaction: among the four expanded paths, three are extant
  // (session.ts, event.ts, error.ts) and one is a typo (session-typo.ts). The extant three
  // should land in `files`, the typo in `unresolvable` — proving the filter runs AFTER expansion
  // (not before, which would over-include) and on a per-path basis (not all-or-nothing).
  const summary = "Touches packages/contracts/src/{session,event,error,session-typo}.ts";
  const result = extractFileReferences({
    references: "",
    summary,
    repoRoot: process.cwd(),
    entryFile: "...",
  });
  assert.equal(result.files.length, 3);
  assert.ok(result.files.includes("packages/contracts/src/session.ts"));
  assert.ok(result.files.includes("packages/contracts/src/event.ts"));
  assert.ok(result.files.includes("packages/contracts/src/error.ts"));
  assert.equal(result.unresolvable.length, 1);
  assert.equal(result.unresolvable[0].path, "packages/contracts/src/session-typo.ts");
});
```

- [ ] **Step 2-5: FAIL → implement → PASS → commit.**

Implementation regexes per spec §3a.4 (apply path-form-shift: spec uses `../../` paths because it lives at `docs/superpowers/specs/`; the regex inside the script uses `(\.\./[^)]+\.md)` because the on-disk text in `cross-plan-dependencies.md` uses one fewer `../`):

```js
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((\.\.\/[^)]+\.md)\)(:\d+(-\d+)?)?/g;
const BARE_PATH_RE =
  /[a-zA-Z0-9_./\-]+\.(md|ts|js|mjs|sql|rs|toml|json|ya?ml)(:\d+(,\d+)*(-\d+)?)?/g;
const DIR_PATH_RE = /[a-zA-Z0-9_./\-]+\//g;

// ...
// Brace expansion (recursive comma-split inside outermost braces, Cartesian product against surrounding literal)
function expandBraces(token) {
  /* recursive impl */
}

// Filesystem resolution: resolve relative-to-entryFile-dir for markdown links, relative-to-repoRoot for bare/dir paths.
// Use existsSync + statSync to filter; mismatched-kind (e.g., file token resolves to a dir) → surfaces in unresolvable.
```

### Task 3.7: Argument parsing + validation (§5.1 step 0)

**Files:**

- Modify: post-merge-housekeeper.mjs + test file

- [ ] **Step 1: Write tests (failing)**

```js
import { parseArgs } from "../post-merge-housekeeper.mjs";

test("parseArgs requires --candidate-ns OR --auto-create (mutual exclusion)", () => {
  assert.throws(
    () => parseArgs(["30"]),
    /must pass exactly one of --candidate-ns or --auto-create/,
  );
  assert.throws(
    () => parseArgs(["30", "--candidate-ns", "NS-01", "--auto-create"]),
    /mutually exclusive/,
  );
});

test("parseArgs requires at-least-one of --plan / --task / --tier (non-cleanup default)", () => {
  assert.throws(() => parseArgs(["30", "--auto-create"]), /at least one of --plan, --task, --tier/);
});

test("parseArgs accepts pure --candidate-ns when candidate is cleanup/governance Type (no plan/task/tier needed)", () => {
  // The carve-out is enforced at runtime when the candidate is loaded (we don't know Type from args alone),
  // so parseArgs treats this as a soft case: it allows the form, runtime check catches non-cleanup misdispatch.
  const args = parseArgs(["30", "--candidate-ns", "NS-22"]);
  assert.equal(args.candidateNs, "NS-22");
  assert.equal(args.plan, null);
});

test("parseArgs validates --plan shape (NNN or NNN-partial)", () => {
  assert.equal(parseArgs(["30", "--plan", "024", "--auto-create"]).plan, "024");
  assert.equal(parseArgs(["30", "--plan", "023-partial", "--auto-create"]).plan, "023-partial");
  assert.throws(() => parseArgs(["30", "--plan", "abc", "--auto-create"]), /--plan/);
});

test("parseArgs validates --phase shape (digit or [A-Z])", () => {
  assert.equal(parseArgs(["30", "--plan", "024", "--phase", "1", "--auto-create"]).phase, "1");
  assert.equal(parseArgs(["30", "--plan", "024", "--phase", "B", "--auto-create"]).phase, "B");
  assert.throws(
    () => parseArgs(["30", "--plan", "024", "--phase", "ab", "--auto-create"]),
    /--phase/,
  );
});

test("parseArgs validates --task shape (three accepted forms per Plan §Decisions-Locked D-4)", () => {
  // Form 1: T<N> or T<N.M> — phase- or sub-task IDs from non-cross-plan plans
  assert.equal(parseArgs(["30", "--plan", "001", "--task", "T5.1", "--auto-create"]).task, "T5.1");
  assert.equal(parseArgs(["30", "--plan", "001", "--task", "T5", "--auto-create"]).task, "T5");
  // Form 2: T-NNN-N-N — cross-plan task IDs from docs/plans/NNN-...
  assert.equal(
    parseArgs(["30", "--plan", "024", "--task", "T-024-2-1", "--auto-create"]).task,
    "T-024-2-1",
  );
  // Form 3: tier-K — Tier-K range-form audits (covers spec §4.3.2 rule-3 lookup per D-4)
  assert.equal(parseArgs(["30", "--task", "tier-3", "--auto-create"]).task, "tier-3");
  // Rejects: bare numerics (form 1 requires leading T), range form (tier-3-9 — range merges always pick lower endpoint)
  assert.throws(
    () => parseArgs(["30", "--plan", "024", "--task", "5.1", "--auto-create"]),
    /--task/,
  );
  assert.throws(() => parseArgs(["30", "--task", "tier-3-9", "--auto-create"]), /--task/);
});

// P4 fix — I-7 mutual-exclusion exit-code assertion: `--candidate-ns` and `--auto-create` are
// mutually exclusive. Passing both OR neither must exit ≥6 (per spec §5.1 step 0 + Plan Invariant I-7).
// The mutual-exclusion test above (line ~1019) already throws; this test asserts that the THROWN
// error carries the expected exit code (≥6) so callers can exit-code-discriminate this class of
// failure without re-parsing the message.
test("parseArgs: mutual-exclusion violations carry exit code ≥6 (Plan Invariant I-7)", () => {
  // Both flags passed
  let err;
  try {
    parseArgs(["30", "--candidate-ns", "NS-01", "--auto-create"]);
  } catch (e) {
    err = e;
  }
  assert.ok(err, "expected throw");
  assert.ok(typeof err.exitCode === "number", "ParseArgsError must carry exitCode");
  assert.ok(err.exitCode >= 6, `expected exitCode ≥6, got ${err.exitCode}`);

  // Neither flag passed
  err = undefined;
  try {
    parseArgs(["30"]);
  } catch (e) {
    err = e;
  }
  assert.ok(err, "expected throw");
  assert.ok(err.exitCode >= 6, `expected exitCode ≥6, got ${err.exitCode}`);
});
```

- [ ] **Step 2-5: FAIL → implement → PASS → commit.**

Implementation: walk argv, parse known flags, validate per spec §5.1 step 0 regex set. Throw on violations (caller catches and exits ≥6). The `--task` regex MUST be (per Plan §Decisions-Locked D-4):

```js
const TASK_RE = /^(T\d+(\.\d+)?|T-\d{3}-\d+-\d+|tier-\d+)$/;
```

Throw a custom `ParseArgsError` with an `exitCode` property (set to 6 for mutual-exclusion violations, 6 for shape-validation violations); the CLI entrypoint (Task 3.19) translates `error.exitCode` into the process exit code so callers can route on it.

### Task 3.8: Verification — Type-signature consistency check

**Files:**

- Modify: post-merge-housekeeper.mjs + test file

- [ ] **Step 1: Write tests (failing) for each spec §5.1 step 3 Type-signature rule**

```js
import { verifyTypeSignature } from "../post-merge-housekeeper.mjs";

test("verifyTypeSignature: code Type accepts packages/ + apps/ touches", () => {
  assert.deepEqual(
    verifyTypeSignature({ type: "code", touchedFiles: ["packages/runtime-daemon/src/foo.ts"] }),
    { ok: true },
  );
  assert.deepEqual(
    verifyTypeSignature({ type: "code", touchedFiles: ["apps/desktop/src/main.ts"] }),
    { ok: true },
  );
  assert.deepEqual(
    verifyTypeSignature({
      type: "code",
      touchedFiles: [".github/workflows/ci.yml", "packages/sidecar-rust-pty/Cargo.toml"],
    }),
    { ok: true },
  );
});

test("verifyTypeSignature: code Type rejects pure-doc diff", () => {
  assert.equal(
    verifyTypeSignature({ type: "code", touchedFiles: ["docs/plans/024-rust-pty-sidecar.md"] }).ok,
    false,
  );
});

test("verifyTypeSignature: audit (doc-only) rejects packages/ touches", () => {
  assert.equal(
    verifyTypeSignature({
      type: "audit (doc-only)",
      touchedFiles: ["packages/contracts/src/foo.ts"],
    }).ok,
    false,
  );
  assert.equal(
    verifyTypeSignature({ type: "audit (doc-only)", touchedFiles: ["docs/plans/002-foo.md"] }).ok,
    true,
  );
});

test("verifyTypeSignature: code + governance requires BOTH docs/ and packages|apps/", () => {
  assert.equal(
    verifyTypeSignature({
      type: "code + governance",
      touchedFiles: ["docs/plans/024-foo.md", "packages/foo/src/bar.ts"],
    }).ok,
    true,
  );
  assert.equal(
    verifyTypeSignature({ type: "code + governance", touchedFiles: ["packages/foo/src/bar.ts"] })
      .ok,
    false,
  );
});

test("verifyTypeSignature: cleanup is permissive with cleanup_diff_unverified concern", () => {
  const result = verifyTypeSignature({ type: "cleanup", touchedFiles: ["any/file.ts"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.concerns, [{ kind: "cleanup_diff_unverified" }]);
});
```

- [ ] **Step 2-5: FAIL → implement → PASS → commit.**

Implementation: helper `partition(touchedFiles)` returns `{ packages, apps, docs }` flags; switch on `type` per spec §5.1 step 3 first sub-bullet.

### Task 3.9: Verification — File-overlap check (three-state outcome for code Types)

**Files:**

- Modify: post-merge-housekeeper.mjs + test file

- [ ] **Step 1: Write tests covering PASS / file_overlap_zero / SOFT-WARN / SKIP per spec §5.1 step 3**

```js
import { verifyFileOverlap } from "../post-merge-housekeeper.mjs";

test("verifyFileOverlap (code, file-path entry): PASS when intersect non-empty", () => {
  const refs = { files: ["packages/sidecar-rust-pty/src/main.rs"], directories: [] };
  const touched = ["packages/sidecar-rust-pty/src/main.rs"];
  assert.deepEqual(verifyFileOverlap({ type: "code", refs, touched }), {
    ok: true,
    kind: "pass_file_path",
  });
});

test("verifyFileOverlap (code, dir-prefix entry): PASS when any touched file starts with dir", () => {
  const refs = { files: [], directories: ["packages/runtime-daemon/src/pty/"] };
  const touched = ["packages/runtime-daemon/src/pty/node-pty-host.ts"];
  assert.deepEqual(verifyFileOverlap({ type: "code", refs, touched }), {
    ok: true,
    kind: "pass_dir_prefix",
  });
});

test("verifyFileOverlap (code, refs non-empty + intersection empty): halt file_overlap_zero", () => {
  const refs = { files: ["packages/sidecar-rust-pty/src/main.rs"], directories: [] };
  const touched = ["docs/plans/007-foo.md"]; // unrelated diff
  const result = verifyFileOverlap({ type: "code", refs, touched });
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, "file_overlap_zero");
});

test("verifyFileOverlap (code, refs empty): SOFT-WARN file_overlap_unverifiable_for_sparse_body", () => {
  const refs = { files: [], directories: [] };
  const result = verifyFileOverlap({ type: "code", refs, touched: ["packages/foo/src/bar.ts"] });
  assert.equal(result.ok, true); // continues
  assert.deepEqual(result.concerns, [{ kind: "file_overlap_unverifiable_for_sparse_body" }]);
});

test("verifyFileOverlap (audit Types): SKIP unconditionally", () => {
  const result = verifyFileOverlap({
    type: "audit (doc-only)",
    refs: { files: [], directories: [] },
    touched: [],
  });
  assert.deepEqual(result, { ok: true, kind: "skip" });
});

test("verifyFileOverlap (governance / cleanup Types): SKIP unconditionally", () => {
  for (const t of [
    "cleanup",
    "cleanup (doc-only)",
    "governance",
    "governance (doc-only)",
    "governance (load-bearing)",
  ]) {
    assert.deepEqual(
      verifyFileOverlap({ type: t, refs: { files: [], directories: [] }, touched: [] }),
      { ok: true, kind: "skip" },
    );
  }
});

test("verifyFileOverlap: doc-path-only PASS for NS-04-shape (References plan-link only)", () => {
  // NS-04: References cites Plan-001 + Plan-024 markdown links; Summary names no source paths.
  // Diff touches the plan Decision Logs on governance side.
  const refs = {
    files: ["docs/plans/001-shared-session-core.md", "docs/plans/024-rust-pty-sidecar.md"],
    directories: [],
  };
  const touched = [
    "docs/plans/001-shared-session-core.md",
    "packages/runtime-daemon/src/session/spawn-cwd-translator.ts",
  ];
  const result = verifyFileOverlap({
    type: "code (cross-plan PR pair, internally a 3-step sequence)",
    refs,
    touched,
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "pass_doc_path_only"); // discriminator preserved per spec §5.5 verification table
});
```

- [ ] **Step 2-5: FAIL → implement → PASS → commit.**

### Task 3.10: Verification — Plan-identity sanity check

**Files:**

- Modify: post-merge-housekeeper.mjs + test file

- [ ] **Step 1: Write tests covering each spec §5.1 step 3 plan-identity disjunct + cleanup carve-out + tier range arithmetic**

```js
import { verifyPlanIdentity } from "../post-merge-housekeeper.mjs";

test("verifyPlanIdentity: passes when --plan substring present in heading", () => {
  const result = verifyPlanIdentity({
    headingTitle: "Plan-024 Phase 1 — Rust crate scaffolding",
    args: { plan: "024" },
    type: "code",
  });
  assert.equal(result.ok, true);
});

test("verifyPlanIdentity: fails when --plan substring missing", () => {
  const result = verifyPlanIdentity({
    headingTitle: "Plan-024 Phase 1",
    args: { plan: "007" },
    type: "code",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, "plan_identity_missing");
});

test("verifyPlanIdentity: --task substring branch", () => {
  assert.equal(
    verifyPlanIdentity({
      headingTitle: "Plan-001 T5.4 cwd-translator + Plan-024 T-024-2-1",
      args: { plan: "001", task: "T5.4" },
      type: "code (cross-plan PR pair, internally a 3-step sequence)",
    }).ok,
    true,
  );
});

test("verifyPlanIdentity: --tier substring branch (rule 3)", () => {
  assert.equal(
    verifyPlanIdentity({
      headingTitle: "Tier 2 plan-readiness audit — Plan-002",
      args: { plan: "002", tier: "2" },
      type: "audit (doc-only)",
    }).ok,
    true,
  );
});

test("verifyPlanIdentity: --tier range-arithmetic branch (rule 4) — Tier 5 in [3, 9]", () => {
  assert.equal(
    verifyPlanIdentity({
      headingTitle: "Tier 3-9 plan-readiness audits",
      args: { tier: "5" },
      type: "audit (doc-only chain)",
      rangeBoundaries: { K1: 3, K2: 9 },
    }).ok,
    true,
  );
  assert.equal(
    verifyPlanIdentity({
      headingTitle: "Tier 3-9 plan-readiness audits",
      args: { tier: "12" },
      type: "audit (doc-only chain)",
      rangeBoundaries: { K1: 3, K2: 9 },
    }).ok,
    false,
  );
});

test("verifyPlanIdentity: cleanup/governance Types SKIP the check", () => {
  for (const t of [
    "cleanup",
    "cleanup (doc-only)",
    "governance",
    "governance (doc-only)",
    "governance (load-bearing)",
  ]) {
    const result = verifyPlanIdentity({
      headingTitle: "anything no plan no tier",
      args: {
        /* none passed */
      },
      type: t,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.concerns, [{ kind: "plan_identity_skipped_for_manual_dispatch" }]);
  }
});
```

- [ ] **Step 2-5: FAIL → implement → PASS → commit.**

### Task 3.11: Mechanical edit — Single-PR status flip (step 5a)

**Files:**

- Modify: post-merge-housekeeper.mjs + test file

- [ ] **Step 1: Write tests (failing)**

```js
import { applyStatusFlipSinglePr } from "../post-merge-housekeeper.mjs";

test("applyStatusFlipSinglePr replaces todo status with completed-with-placeholder", () => {
  const lines = ["### NS-01: Plan-024 Phase 1", "- Status: `todo`", "- Type: code"];
  const result = applyStatusFlipSinglePr({
    lines,
    statusLineIndex: 1,
    prNumber: 30,
    today: "2026-05-10",
  });
  assert.equal(
    result[1],
    "- Status: `completed` (resolved 2026-05-10 via PR #30 — <TODO subagent prose>)",
  );
});

test("applyStatusFlipSinglePr handles in_progress status (not just todo)", () => {
  const lines = ["...", "- Status: `in_progress` (last shipped: PR #20, 2026-05-01)", "..."];
  const result = applyStatusFlipSinglePr({
    lines,
    statusLineIndex: 1,
    prNumber: 30,
    today: "2026-05-10",
  });
  assert.equal(
    result[1],
    "- Status: `completed` (resolved 2026-05-10 via PR #30 — <TODO subagent prose>)",
  );
});
```

- [ ] **Step 2-5: FAIL → implement → PASS → commit.**

### Task 3.12: Mechanical edit — Multi-PR tick + completion-matrix recompute (step 5b)

**Files:**

- Modify: post-merge-housekeeper.mjs + test file

- [ ] **Step 1: Write tests (failing)**

```js
import { applyMultiPrTickAndRecompute } from "../post-merge-housekeeper.mjs";

test("applyMultiPrTickAndRecompute: tick T5.5 row, recompute Status to in_progress", () => {
  const lines = [
    "### NS-02: Plan-001 Phase 5 Lane A",
    "- Status: `in_progress` (last shipped: PR #34, 2026-05-04)",
    "- ... other fields ...",
    "- PRs:",
    "  - [x] T5.1 — sessionClient (PR #34, merged 2026-05-04)",
    "  - [ ] T5.5 — pg.Pool-backed Querier composition",
    "  - [ ] T5.6 — strengthen createSession lock-ordering test",
  ];
  const result = applyMultiPrTickAndRecompute({
    lines,
    statusLineIndex: 1,
    prsBlockStartIndex: 3,
    taskId: "T5.5",
    prNumber: 38,
    today: "2026-05-10",
    upstreamBlocked: false,
  });
  assert.match(
    result[5],
    /^  - \[x\] T5\.5 — pg\.Pool-backed Querier composition \(PR #38, merged 2026-05-10\)$/,
  );
  // Status recomputed: still ≥1 unchecked (T5.6) → in_progress
  assert.match(result[1], /^- Status: `in_progress` \(last shipped: PR #38, 2026-05-10\)/);
});

test("applyMultiPrTickAndRecompute: tick last unchecked → recompute Status to completed", () => {
  const lines = [
    "...",
    "- Status: `in_progress` (last shipped: PR #38, 2026-05-10)",
    "...",
    "- PRs:",
    "  - [x] T5.1 — sessionClient (PR #34, merged 2026-05-04)",
    "  - [x] T5.5 — pg.Pool-backed Querier composition (PR #38, merged 2026-05-10)",
    "  - [ ] T5.6 — strengthen createSession lock-ordering test",
  ];
  const result = applyMultiPrTickAndRecompute({
    lines,
    statusLineIndex: 1,
    prsBlockStartIndex: 3,
    taskId: "T5.6",
    prNumber: 41,
    today: "2026-05-15",
    upstreamBlocked: false,
  });
  assert.match(
    result[1],
    /^- Status: `completed` \(resolved 2026-05-15 via PR #41 — last sub-task; <TODO subagent prose>\)/,
  );
});

test("applyMultiPrTickAndRecompute: blocked-override sets Status to blocked when upstreamBlocked true (spec §3a.2 row 5)", () => {
  // Spec §3a.2 row 5: ≥1 checked, ≥1 unchecked + upstream blocked → Status `blocked`
  // The merged PR ticks its row, but recompute observes the upstream-blocked signal and overrides
  // what would otherwise be `in_progress` to `blocked` with the upstream NS reference inline.
  const lines = [
    "### NS-02: Plan-001 Phase 5 Lane A",
    "- Status: `in_progress` (last shipped: PR #34, 2026-05-04)",
    "- Upstream: NS-04 (blocked)",
    "- PRs:",
    "  - [x] T5.1 — sessionClient (PR #34, merged 2026-05-04)",
    "  - [ ] T5.5 — pg.Pool-backed Querier composition",
    "  - [ ] T5.6 — strengthen createSession lock-ordering test",
  ];
  const result = applyMultiPrTickAndRecompute({
    lines,
    statusLineIndex: 1,
    prsBlockStartIndex: 3,
    taskId: "T5.5",
    prNumber: 38,
    today: "2026-05-10",
    upstreamBlocked: true,
    upstreamNsRef: "NS-04",
  });
  // Row 4 (T5.5) is ticked
  assert.match(
    result[4],
    /^  - \[x\] T5\.5 — pg\.Pool-backed Querier composition \(PR #38, merged 2026-05-10\)$/,
  );
  // Status reflects blocked-override per spec §3a.2 row 5 — `in_progress` would have been the answer
  // without the override, but upstreamBlocked=true forces `blocked` with upstream-NS annotation.
  assert.match(
    result[1],
    /^- Status: `blocked` \(blocked-on NS-04; last shipped: PR #38, 2026-05-10\)/,
  );
});

test("applyMultiPrTickAndRecompute: blocked-override does NOT fire when all checked (spec §3a.2 row 6 — no override on all-checked)", () => {
  // Spec §3a.2 row 6: all checked, regardless of upstream state → Status `completed`
  // The override only applies to row 5 (mixed checked/unchecked); row 6 always wins to `completed`
  // because "all PRs in this NS shipped" is a terminal state that an external block can no longer alter.
  const lines = [
    "### NS-02: Plan-001 Phase 5 Lane A",
    "- Status: `in_progress` (last shipped: PR #38, 2026-05-10)",
    "- Upstream: NS-04 (blocked)",
    "- PRs:",
    "  - [x] T5.1 — sessionClient (PR #34, merged 2026-05-04)",
    "  - [x] T5.5 — pg.Pool-backed Querier composition (PR #38, merged 2026-05-10)",
    "  - [ ] T5.6 — strengthen createSession lock-ordering test",
  ];
  const result = applyMultiPrTickAndRecompute({
    lines,
    statusLineIndex: 1,
    prsBlockStartIndex: 3,
    taskId: "T5.6",
    prNumber: 41,
    today: "2026-05-15",
    upstreamBlocked: true,
    upstreamNsRef: "NS-04",
  });
  // All three rows now checked
  assert.match(
    result[5],
    /^  - \[x\] T5\.6 — strengthen createSession lock-ordering test \(PR #41, merged 2026-05-15\)$/,
  );
  // Status is `completed` despite upstreamBlocked=true — row 6 has no override
  assert.match(
    result[1],
    /^- Status: `completed` \(resolved 2026-05-15 via PR #41 — last sub-task; <TODO subagent prose>\)/,
  );
});
```

- [ ] **Step 2-5: FAIL → implement → PASS → commit.**

Implementation note: Use the parsers from Task 3.4 + 3.5 internally. `applyMultiPrTickAndRecompute` should be a thin orchestrator: tick the matching row → re-parse the block → call `computeStatusFromPRs` → splice the new Status line in at `statusLineIndex`.

### Task 3.13: Mechanical edit — Mermaid class swap (step 6)

**Files:**

- Modify: post-merge-housekeeper.mjs + test file

- [ ] **Step 1: Write tests (failing)**

````js
import { applyMermaidClassSwap } from "../post-merge-housekeeper.mjs";

test("applyMermaidClassSwap: changes :::ready to :::completed for matching node", () => {
  const lines = [
    "```mermaid",
    "    NS01[NS-01: Plan-024 Phase 1<br/>Rust crate scaffolding]:::ready",
    "```",
  ];
  const result = applyMermaidClassSwap({ lines, nsNum: 1, newClass: "completed" });
  assert.match(result[1], /:::completed$/);
});

test("applyMermaidClassSwap: handles edge syntax following the class attachment", () => {
  // Per spec §8.1 fixture 10 — line shape `NS01[...]:::ready --> NS02[...]:::ready`
  const lines = ["    NS01[NS-01: foo]:::ready --> NS02[NS-02: bar]:::ready"];
  const result = applyMermaidClassSwap({ lines, nsNum: 1, newClass: "completed" });
  assert.match(result[0], /NS01\[NS-01: foo\]:::completed --> NS02\[NS-02: bar\]:::ready/);
});

test("applyMermaidClassSwap: never modifies classDef definitions", () => {
  const lines = ["    classDef ready fill:#fff", "    NS01[NS-01: foo]:::ready"];
  const result = applyMermaidClassSwap({ lines, nsNum: 1, newClass: "completed" });
  assert.equal(result[0], "    classDef ready fill:#fff"); // unchanged
});
````

- [ ] **Step 2-5: FAIL → implement → PASS → commit.**

Implementation: regex `^(\s*NS<NN>\[[^\]]+\]):::(ready|blocked|completed)(.*)$`, replace group 2 with `newClass`. Skip lines matching `^\s*classDef`.

### Task 3.14: Mechanical edit — Plan §Done Checklist tick (step 7)

**Files:**

- Modify: post-merge-housekeeper.mjs + test file

- [ ] **Step 1: Write tests (failing)**

```js
import { tickPlanDoneChecklist } from "../post-merge-housekeeper.mjs";

test("tickPlanDoneChecklist: ticks all unchecked boxes in the matched Phase's checklist", () => {
  const lines = [
    "### Phase 1 — Rust crate scaffolding",
    "...",
    "#### Done Checklist",
    "",
    "- [ ] First item",
    "- [ ] Second item",
    "- [x] Third item already done",
    "",
    "### Phase 2 — Other",
    "#### Done Checklist",
    "",
    "- [ ] Should NOT be ticked (different phase)",
  ];
  const { lines: result, ticksApplied } = tickPlanDoneChecklist({ lines, phase: "1" });
  assert.equal(ticksApplied, 2);
  assert.equal(result[4], "- [x] First item");
  assert.equal(result[5], "- [x] Second item");
  assert.equal(result[12], "- [ ] Should NOT be ticked (different phase)"); // unchanged
});

test("tickPlanDoneChecklist: returns ticksApplied=0 + flag when no checklist found", () => {
  const lines = ["### Phase 1 — Foo", "no checklist sub-section"];
  const { ticksApplied, notFound } = tickPlanDoneChecklist({ lines, phase: "1" });
  assert.equal(ticksApplied, 0);
  assert.equal(notFound, true);
});
```

- [ ] **Step 2-5: FAIL → implement → PASS → commit.**

Implementation: walk lines to find `### Phase <phase> —`, then walk forward to next `### Phase` heading, locate `#### Done Checklist` between, tick all `- [ ]` lines inside. Caller uses `notFound` to drive exit code 3.

### Task 3.15: Manifest emission (step 8)

**Files:**

- Modify: post-merge-housekeeper.mjs + test file

- [ ] **Step 1: Write tests (failing)**

```js
import { emitManifest } from "../post-merge-housekeeper.mjs";

test("emitManifest writes JSON matching spec §5.3 shape (--candidate-ns mode)", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "manifest-emit-"));
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
    mechanicalEdits: {
      /* per spec §5.3 */
    },
    schemaViolations: [],
    affectedFiles: [
      "docs/architecture/cross-plan-dependencies.md",
      "docs/plans/024-rust-pty-sidecar.md",
    ],
    semanticWorkPending: [
      "compose_status_completion_prose",
      "ready_set_re_derivation",
      "line_cite_sweep",
      "set_quantifier_reverification",
      "ns_auto_create_evaluation",
      "unannotated_referenced_files_check",
    ],
  });
  const written = JSON.parse(readFileSync(result.manifestPath, "utf8"));
  assert.equal(written.pr_number, 30);
  assert.equal(written.script_exit_code, 0);
  assert.equal(written.result, null);
  assert.deepEqual(written.semantic_edits, {});
  assert.deepEqual(written.concerns, []);
});

test("emitManifest writes auto-create stub manifest when scriptExitCode=0 + autoCreate=true", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "manifest-ac-"));
  const result = emitManifest({
    repoRoot: tmpRepo,
    prNumber: 50,
    plan: "029",
    phase: "2",
    taskId: null,
    scriptExitCode: 0,
    autoCreate: { reservedNsNn: 24, derivedTitleSeed: "Plan-029 Phase 2 — example" },
    mechanicalEdits: {
      plan_checklist_ticks: [{ file: "docs/plans/029-foo.md", phase: "2", items_ticked: 4 }],
    },
    schemaViolations: [],
    affectedFiles: ["docs/architecture/cross-plan-dependencies.md", "docs/plans/029-foo.md"],
    semanticWorkPending: [
      "auto_create_compose_entry",
      "auto_create_compose_mermaid_node",
      "auto_create_derive_upstream",
    ],
  });
  const written = JSON.parse(readFileSync(result.manifestPath, "utf8"));
  assert.equal(written.auto_create.reserved_ns_nn, 24);
  assert.equal(written.mechanical_edits.status_flip, undefined); // absent for auto-create
});

// P5 fix — auto_create:null variant: when --candidate-ns mode is active, the manifest's
// `auto_create` field MUST be explicitly null (not undefined, not absent). Spec §5.3 schema
// requires the key to be present so consumers can switch on `manifest.auto_create === null`
// vs `manifest.auto_create !== null` without `hasOwnProperty` guards. This test pins that
// the --candidate-ns code path emits the null sentinel.
test("emitManifest emits auto_create:null sentinel in --candidate-ns mode (not undefined)", () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), "manifest-cn-null-"));
  const result = emitManifest({
    repoRoot: tmpRepo,
    prNumber: 31,
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
    // autoCreate is OMITTED from the call args (i.e., undefined input)
  });
  const raw = readFileSync(result.manifestPath, "utf8");
  const written = JSON.parse(raw);
  // Two assertions: (1) the key MUST be present as a top-level property, and (2) its value MUST be JSON null.
  // JSON serialization erases undefined; only an explicit null survives the round-trip.
  assert.ok(
    Object.prototype.hasOwnProperty.call(written, "auto_create"),
    "manifest must include auto_create key even in --candidate-ns mode (spec §5.3 schema requirement)",
  );
  assert.equal(
    written.auto_create,
    null,
    "auto_create MUST be JSON null (not undefined / not absent)",
  );
  // Belt-and-suspenders: the raw JSON string contains the literal `"auto_create": null` (or compact form)
  assert.match(raw, /"auto_create"\s*:\s*null/);
});
```

- [ ] **Step 2-5: FAIL → implement → PASS → commit.**

Implementation: build the JSON object per spec §5.3 verbatim shape, write to `.agents/tmp/housekeeper-manifest-PR<N>.json` under `repoRoot`. Ensure `.agents/tmp/` is created if absent.

### Task 3.16: AUTO-CREATE — Reserve next free NS-NN (step 1')

**Files:**

- Modify: post-merge-housekeeper.mjs + test file

- [ ] **Step 1: Write tests (failing)**

```js
import { reserveNextFreeNs } from "../post-merge-housekeeper.mjs";

test("reserveNextFreeNs returns max(NN)+1 across all NS-NN headings", () => {
  const content = "### NS-01: a\n### NS-22: z\n### NS-13a: b\n### NS-15..NS-21: r";
  assert.equal(reserveNextFreeNs(content), 23);
});

test("reserveNextFreeNs skips NS-23 if already reserved per §3a.3", () => {
  const content = "### NS-22: z\n### NS-23: §6 schema amendment";
  assert.equal(reserveNextFreeNs(content), 24);
});

test("reserveNextFreeNs throws on collision (defensive numbering race)", () => {
  // Two NS-23 headings somehow present
  const content = "### NS-22: z\n### NS-23: first\n### NS-23: second";
  assert.throws(() => reserveNextFreeNs(content), /duplicate.*NS-23/i);
});
```

- [ ] **Step 2-5: FAIL → implement → PASS → commit.**

### Task 3.17: AUTO-CREATE — Duplicate-title guard (step 2')

**Files:**

- Modify: post-merge-housekeeper.mjs + test file

- [ ] **Step 1: Write tests (failing)**

```js
import { checkDuplicateTitle } from "../post-merge-housekeeper.mjs";

test("checkDuplicateTitle returns ok when title is novel", () => {
  assert.deepEqual(
    checkDuplicateTitle({
      existingTitles: ["Plan-024 Phase 1 — Rust crate scaffolding"],
      newTitle: "Plan-029 Phase 2 — example",
    }),
    { ok: true },
  );
});

test("checkDuplicateTitle returns failure on substring-match collision", () => {
  const result = checkDuplicateTitle({
    existingTitles: ["Plan-024 Phase 1 — Rust crate scaffolding"],
    newTitle: "Plan-024 Phase 1 — Rust crate scaffolding (refresh)",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, "auto_create_duplicate_title");
});
```

- [ ] **Step 2-5: FAIL → implement → PASS → commit.**

### Task 3.18: Top-level orchestrator — `runHousekeeper`

**Files:**

- Modify: post-merge-housekeeper.mjs + test file

- [ ] **Step 1: Write a smoke test that exercises the full happy-path pipeline**

```js
import { runHousekeeper } from "../post-merge-housekeeper.mjs";

test("runHousekeeper: end-to-end --candidate-ns NS-01 happy path on minimal fixture", async () => {
  // Snapshot fixture 01 to a tmp dir; run runHousekeeper; assert exit code 0 + manifest written.
  const tmpRepo = mkdtempSync(join(tmpdir(), "rh-smoke-"));
  cpSync("./fixtures/01-single-pr-happy-path/input", tmpRepo, { recursive: true });
  // A10 fix: pass deterministic `today` so Status-line dates are reproducible across CI runs.
  const result = await runHousekeeper({
    args: { prNumber: 30, plan: "024", phase: "1", candidateNs: "NS-01" },
    repoRoot: tmpRepo,
    today: "2026-05-03",
  });
  assert.equal(result.exitCode, 0);
  assert.ok(existsSync(join(tmpRepo, ".agents/tmp/housekeeper-manifest-PR30.json")));
});
```

- [ ] **Step 2-5: FAIL → implement → PASS → commit.**

Implementation: glue Tasks 3.7-3.17 into a single function. Per spec §5.1 design choices: returns `{ exitCode, manifestPath }` (does NOT throw on exit ≥ 1; throws only on internal bugs). The signature MUST accept `today` (per A10 fix):

```js
export async function runHousekeeper({
  args,
  repoRoot,
  today = process.env.HOUSEKEEPER_TODAY ?? new Date().toISOString().slice(0, 10),
}) {
  // ...thread `today` into every callsite that emits a date string into the cross-plan-dependencies
  // entry (Status line "resolved YYYY-MM-DD via ...", PRs-row "merged YYYY-MM-DD") so fixture-driven
  // tests get deterministic output.
}
```

Rationale (A10): Tasks 3.11 + 3.15 (`applyStatusFlip`, `writeManifest`) emit `today`-derived date strings. Without threading the parameter through `runHousekeeper`, the fixture-harness call gets `new Date()` (today's actual date), which makes manifest-comparison assertions non-deterministic. The `process.env.HOUSEKEEPER_TODAY` fallback lets shells override the date too — convenient for one-off debugging.

### Task 3.19: Add the entrypoint (CLI invocation) at module bottom

**Files:**

- Modify: post-merge-housekeeper.mjs (add `if (import.meta.url === \`file://${process.argv[1]}\`)` block at bottom)

- [ ] **Step 1: Add the CLI entrypoint**

```js
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const result = await runHousekeeper({ args, repoRoot: process.cwd() });
  process.exit(result.exitCode);
}
```

- [ ] **Step 2: Sanity-test invocation from shell (no test file; manual)**

```bash
node --experimental-strip-types .claude/skills/plan-execution/scripts/post-merge-housekeeper.mjs --help
```

Expected: arg-parsing error message OR usage prose if a `--help` branch is implemented (defer the `--help` UX polish to a follow-on task; minimum: doesn't crash with native module error).

- [ ] **Step 3: Commit.**

### Task 3.20: Author fixture 01 — single-pr-happy-path

**Files:**

- Create: `.claude/skills/plan-execution/scripts/__tests__/fixtures/01-single-pr-happy-path/`
  - `input/docs/architecture/cross-plan-dependencies.md` — minimal §6 with NS-01 entry + mermaid block (real content trimmed to relevant lines)
  - `input/docs/plans/024-rust-pty-sidecar.md` — minimal Phase 1 + Done Checklist
  - `expected/docs/architecture/cross-plan-dependencies.md` — same as input but NS-01 status flipped + mermaid recolored (with `<TODO subagent prose>` placeholder still in place)
  - `expected/docs/plans/024-rust-pty-sidecar.md` — checklist ticked
  - `args.json` — `{"prNumber": 30, "plan": "024", "phase": "1", "candidateNs": "NS-01"}`
  - `expected-manifest.json` — full per-spec §5.3 shape

- [ ] **Step 1: Build input/expected pair via copy-trim from real corpus**

```bash
mkdir -p .claude/skills/plan-execution/scripts/__tests__/fixtures/01-single-pr-happy-path/{input/docs/{architecture,plans},expected/docs/{architecture,plans}}
# Copy real cross-plan-dependencies.md, then trim to NS-01 entry + a stub mermaid block (10-20 lines)
# Copy real 024-rust-pty-sidecar.md, then trim to Phase 1 + Done Checklist (10-20 lines)
# Make a copy in expected/, then mutate: NS-01 status → completed, mermaid NS01 → :::completed, plan checklist boxes ticked
```

- [ ] **Step 2: Author args.json**

```json
{ "prNumber": 30, "plan": "024", "phase": "1", "candidateNs": "NS-01" }
```

- [ ] **Step 3: Author expected-manifest.json (full per spec §5.3)**

Use the example in spec §5.3 verbatim, but replace `<TODO subagent prose>` only where appropriate (in mechanical_edits.status_flip.to_line — yes, it's preserved at this stage; stage 2 subagent replaces it).

- [ ] **Step 4: Run fixture-driven Layer 1 test (write the harness if not yet done)**

The harness lives at `.claude/skills/plan-execution/scripts/__tests__/post-merge-housekeeper.test.mjs` (the same file Tasks 3.2–3.18 have been extending). Append the fixture-driven block AFTER the pure-parser tests so the harness has access to `runHousekeeper` already imported at the top.

Required imports (add to the file's import block at the top — collapse with any pre-existing `node:fs` import line, do NOT re-import):

```js
import {
  mkdtempSync,
  cpSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
```

The harness body (append at the bottom of the test file):

```js
// Fixture-driven Layer 1 harness — picks up every directory under fixtures/ as a test case.
// Per Plan §Decisions-Locked D-6: fixture 00-loader-smoke is allowlist-skipped here because its
// purpose is to assert the loader rejects an empty plan-file BEFORE catalog read; the harness's
// runHousekeeper call expects the catalog file to exist.
// Per Plan §Decisions-Locked D-7: fixture 11-tier-range-audit exercises the §4.3.2 rule-3 lookup;
// the harness handles it identically (no special-casing needed).
const FIXTURES_DIR = new URL("./fixtures", import.meta.url).pathname;

function listFixtures(dir) {
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort()
    .map((name) => ({
      name,
      inputDir: join(dir, name, "input"),
      expectedDir: join(dir, name, "expected"),
      argsPath: join(dir, name, "args.json"),
      expectedManifestPath: join(dir, name, "expected-manifest.json"),
    }));
}

for (const fixture of listFixtures(FIXTURES_DIR)) {
  // D-6: 00-loader-smoke uses its own dedicated test (Task 3.1, not this harness).
  if (fixture.name === "00-loader-smoke") continue;

  test(`fixture: ${fixture.name}`, async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), `housekeeper-${fixture.name}-`));
    try {
      cpSync(fixture.inputDir, tmpRepo, { recursive: true });
      const args = JSON.parse(readFileSync(fixture.argsPath, "utf8"));
      const expectedManifest = JSON.parse(readFileSync(fixture.expectedManifestPath, "utf8"));
      // A10 fix: pass deterministic `today` so manifest's date fields are reproducible.
      // The runHousekeeper signature accepts today via opts (default: HOUSEKEEPER_TODAY env or now).
      const result = await runHousekeeper({
        args,
        repoRoot: tmpRepo,
        today: "2026-05-03",
      });
      assert.equal(
        result.exitCode,
        expectedManifest.script_exit_code,
        `fixture ${fixture.name}: exitCode mismatch`,
      );
      expectFilesEqual(tmpRepo, fixture.expectedDir);
      // The manifest is only written when exitCode is 0 (mechanical edits succeeded) OR ≤ 2
      // (verification surfaced but caller may proceed); skip the manifest assertion on hard-fail
      // exits where the script bails before write.
      if (result.manifestPath) {
        assert.deepEqual(
          JSON.parse(readFileSync(result.manifestPath, "utf8")),
          expectedManifest,
          `fixture ${fixture.name}: manifest mismatch`,
        );
      }
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
}
```

The `expectFilesEqual` helper is the diff-walk used in Task 3.1's fixture-loader smoke test (re-exported from `helpers/fixture-loader.mjs`); add to the import block:

```js
import { expectFilesEqual } from "./helpers/fixture-loader.mjs";
```

- [ ] **Step 5: Run (expected: PASS for fixture 01).**

```bash
node --test --experimental-strip-types .claude/skills/plan-execution/scripts/__tests__/post-merge-housekeeper.test.mjs
```

Expected: ≥ 1 test passes (`fixture: 01-single-pr-happy-path`); other fixtures fail because they're not authored yet (Tasks 3.21-3.29 + the new 11). The 00-loader-smoke harness loop SKIPS that fixture per D-6, so it does NOT show up in the harness output.

- [ ] **Step 6: Commit.**

### Task 3.21-3.29: Author the remaining 9 fixtures + assert each runs green

Each fixture is one task (3.21 through 3.29 — one per scenario in spec §8.1):

- 3.21: 02-multi-pr-tick-only (D-7 row 2 — multi-PR plan, leaf-PR merge → row tick + Status `in_progress`, no auto-complete)
- 3.22: 03-multi-pr-completion (D-7 row 3 — multi-PR plan, last-PR merge → row tick + recompute → Status `completed`)
- 3.23: 04-multi-pr-blocked-upstream (D-7 row 4 alt — multi-PR with upstream blocked → blocked-override per spec §3a.2 row 5)
- 3.24: 05-exit-1-no-ns-match (negative — args refer to NS that doesn't exist; expect exit 1)
- 3.25: 06-exit-2-file-overlap-zero (per Plan §Decisions-Locked D-7 row 6 + P6 fix — file-overlap=zero produces SOFT-WARN exit 0 with `verification_warnings` populated; previous name `06-exit-2-multi-ns-match` was wrong because multi-NS file-overlap is exit 2 not file-overlap-zero, and the multi-NS case has its own dedicated fixture 04 from D-7 row 5)
- 3.26: 07-exit-3-no-checklist (negative — plan has no Done Checklist sub-section; expect exit 3, fixture's expected manifest's `mechanical_edits.plan_checklist_ticks` is empty array)
- 3.27: 08-exit-4-multi-pr-no-task-id (negative — multi-PR entry but `--task` arg missing; expect exit 4)
- 3.28: 09-exit-5-schema-violation-malformed-prs (negative — `PRs:` block missing the required `(PR #N, merged YYYY-MM-DD)` annotation on a checked row; expect exit 5)
- 3.29: 10-mermaid-class-attachment-variant (variant — `:::ready` followed by edge syntax `--> NS02`; ensures regex correctly captures the class without consuming the edge)

For each:

- [ ] **Step 1: Author input/ + expected/ + args.json + expected-manifest.json (mirroring fixture 01's shape).**
- [ ] **Step 2: Run the fixture-driven test.**
- [ ] **Step 3: Commit.**

(Each task is ~5-10 minutes of fixture authoring; the harness from Task 3.20 step 4 picks up new fixtures automatically — except the allowlist-skipped 00-loader-smoke per Plan §Decisions-Locked D-6.)

### Task 3.30: Author fixture 11 — `11-tier-range-audit` (NEW per Plan §Decisions-Locked D-7 row 11)

**Files:**

- Create: `.claude/skills/plan-execution/scripts/__tests__/fixtures/11-tier-range-audit/`
  - `input/docs/architecture/cross-plan-dependencies.md` — minimal §6 with one range-form NS heading like `### NS-15..NS-21: Tier 3-9 plan-readiness audits` plus a stub mermaid block
  - `input/docs/plans/<plan>.md` — minimal Tier-3 plan with a Done Checklist
  - `expected/...` — same files with NS-15..NS-21's Status flipped + checklist ticked
  - `args.json` — `{"prNumber": 31, "tier": "tier-3", "candidateNs": null, "autoCreate": null}` plus the script-internal heading-only signal that triggers §4.3.2 rule-3 lookup (the `--task tier-3` form per Plan §Decisions-Locked D-4 if heading-only path is preferred)
  - `expected-manifest.json` — full per-spec §5.3 shape with `mechanical_edits.status_flip.candidate_lookup_path: "rule-3-tier-K"` populated so the matrix-row 11 assertion can verify the rule-3 codepath actually fired

- [ ] **Step 1: Author input/ pair**

```bash
mkdir -p .claude/skills/plan-execution/scripts/__tests__/fixtures/11-tier-range-audit/{input/docs/{architecture,plans},expected/docs/{architecture,plans}}
# Copy real cross-plan-dependencies.md, trim to NS-15..NS-21 entry + 1-2 sibling entries + minimal mermaid block
# Author a synthetic Tier-3 plan stub that the rule-3 lookup can match against (use a real Tier-3 plan
# name like 002-tier-3-substrate.md if one exists; otherwise author tier-3-test-fixture.md as a stub).
```

- [ ] **Step 2: Author args.json**

```json
{ "prNumber": 31, "task": "tier-3", "candidateNs": "NS-15..NS-21" }
```

- [ ] **Step 3: Author expected-manifest.json with `candidate_lookup_path: "rule-3-tier-K"`**

This is the row-11 assertion target — the manifest must record WHICH §4.3.2 rule fired (rule-1/rule-2/rule-3/rule-4). Add the field if not yet schemed in §5.3 (Phase 4 task 4.5 should canonicalize the field name in the contract; the script writes it during manifest assembly).

- [ ] **Step 4: Run fixture-driven test**

```bash
node --test --experimental-strip-types .claude/skills/plan-execution/scripts/__tests__/post-merge-housekeeper.test.mjs
```

Expected: `fixture: 11-tier-range-audit` passes; harness picks it up automatically.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/plan-execution/scripts/__tests__/fixtures/11-tier-range-audit/
git commit -m "test(repo): add fixture 11-tier-range-audit (D-7 row 11 — §4.3.2 rule-3 coverage)"
```

### Task 3.31: Author fixture 12 — `12-auto-create` (NEW per Plan §Decisions-Locked D-7 row 16)

**Files:**

- Create: `.claude/skills/plan-execution/scripts/__tests__/fixtures/12-auto-create/`
  - `input/docs/architecture/cross-plan-dependencies.md` — §6 corpus where NO existing NS entry matches the merged PR's diff (i.e., a fresh Plan/Phase the catalog hasn't seen before)
  - `input/docs/plans/<new-plan>.md` — the plan being merged (with Done Checklist)
  - `expected/docs/architecture/cross-plan-dependencies.md` — same as input PLUS a newly-inserted NS-NN entry at max(NN)+1 with `<TODO subagent prose>` placeholders in Type/Priority/Upstream/References/Summary/Exit Criteria
  - `expected/docs/plans/<new-plan>.md` — same as input with checklist ticked
  - `args.json` — `{"prNumber": 32, "plan": "029", "phase": "1", "autoCreate": true}` (no `candidateNs`)
  - `expected-manifest.json` — `auto_create.reserved_ns_nn: <next-free>`, `mechanical_edits.status_flip` ABSENT (per §5.3 — auto-create has no status flip; new entry's Status starts as `todo` until subagent fills it)

- [ ] **Step 1: Author input/ pair (run `reserveNextFreeNs` mentally to predict the NN; document the prediction in the args.json comment)**

- [ ] **Step 2: Author args.json + expected-manifest.json**

- [ ] **Step 3: Run fixture-driven test**

Expected: `fixture: 12-auto-create` passes.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/plan-execution/scripts/__tests__/fixtures/12-auto-create/
git commit -m "test(repo): add fixture 12-auto-create (D-7 row 16 — auto-create codepath coverage)"
```

### Task 3.32: Add CI step per spec §10.4(a)

**Files:**

- Modify: `.github/workflows/ci.yml` — add a new step inside the `test-node22` job, after the existing per-package test step (line 95 at plan-write time; verify line number first since CI yaml drifts as the project adds steps).

- [ ] **Step 1: Read current ci.yml to confirm the insertion point**

```bash
sed -n '85,100p' .github/workflows/ci.yml
```

Expected output (verbatim, at plan-write time 2026-05-03):

```yaml
- name: Build (Node 22 tier — excluding control-plane)
  run: pnpm turbo run build --filter='!@ai-sidekicks/control-plane'

- name: Typecheck (Node 22 tier — excluding control-plane)
  run: pnpm turbo run typecheck --filter='!@ai-sidekicks/control-plane'

- name: Lint per-package (Node 22 tier — excluding control-plane)
  run: pnpm turbo run lint --filter='!@ai-sidekicks/control-plane'

- name: Test (Node 22 tier — excluding control-plane)
  run: pnpm turbo run test --filter='!@ai-sidekicks/control-plane'
```

The new step lands AFTER the "Test (Node 22 tier ...)" step. If the file has drifted from the above shape, STOP and reconcile manually — the CI yaml is load-bearing and we don't want to insert in the wrong position.

- [ ] **Step 2: Insert the plan-execution skill-test step using exact Edit**

Use the Edit tool with:

- `file_path`: `.github/workflows/ci.yml`
- `old_string` (note: leading whitespace matches the file's indentation — 6 spaces on `- name:` lines):

```
      - name: Test (Node 22 tier — excluding control-plane)
        run: pnpm turbo run test --filter='!@ai-sidekicks/control-plane'

  # Tier-2 (Node 24 — control-plane + CLI per ADR-022 §Decision row 8). The
```

- `new_string`:

```
      - name: Test (Node 22 tier — excluding control-plane)
        run: pnpm turbo run test --filter='!@ai-sidekicks/control-plane'

      # Plan-execution skill tests (Layer 1 fixture-driven + Layer 2 unit). Closes the gap
      # noted in spec §10.4(a) — pre-housekeeper, the .claude/skills/plan-execution/scripts/
      # tests had no CI run. Uses --experimental-strip-types per ADR-022 + repo precedent
      # (tools/docs-corpus/bin/pre-commit-runner.ts ships with the same flag).
      - name: Run plan-execution skill tests (Layer 1 + Layer 2)
        run: node --test --experimental-strip-types .claude/skills/plan-execution/scripts/__tests__/

  # Tier-2 (Node 24 — control-plane + CLI per ADR-022 §Decision row 8). The
```

The new step uses the same Node 22 runner already configured for the test-node22 job — no additional matrix axis needed. The `--experimental-strip-types` flag is a no-op for pure `.mjs` imports but tolerates any inline TS-style import that may land in the future without breaking CI.

- [ ] **Step 3: Verify locally that the test command actually runs all fixture tests**

```bash
node --test --experimental-strip-types .claude/skills/plan-execution/scripts/__tests__/
```

Expected: every fixture-driven test + every parser test runs and passes (12 fixtures from Tasks 3.20-3.31 + parser units from 3.2-3.6 + arg-parsing from 3.7).

- [ ] **Step 4: Verify the yaml parses with actionlint or basic syntax check**

```bash
# If actionlint is installed:
actionlint .github/workflows/ci.yml
# Otherwise, fallback: yaml-roundtrip parse check via Python
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo "yaml OK"
```

- [ ] **Step 5: Commit.**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(repo): wire plan-execution skill tests into test-node22 job"
```

Note: the commit type `ci(repo):` is per the commitlint enum (verified at commitlint.config.mjs line 23 — `ci` is in the type enum; `repo` is in the scope enum). Do NOT use `feat(plan-execution):` — `plan-execution` is NOT in the scope enum.

### Task 3.33: Open the PR

- [ ] **Step 1: Push + open PR**

```bash
git push -u origin feat/post-merge-housekeeper-script
gh pr create --title "feat(repo): post-merge-housekeeper.mjs + 12 fixture tests + CI wiring" --body "$(cat <<'EOF'
## Summary
- Adds \`post-merge-housekeeper.mjs\` end-to-end (mechanical-stage logic; both \`--candidate-ns\` and \`--auto-create\` modes).
- 12 fixture-driven Layer 1 tests covering happy-path + each exit code + mermaid edge variant + §4.3.2 rule-3 Tier-K coverage + auto-create coverage per spec §5.5 + Plan §Decisions-Locked D-7.
- Pure parser unit tests (parseNsHeading, parseSubFields, parsePRsBlock, computeStatusFromPRs, extractFileReferences).
- GitHub Actions CI step wiring per spec §10.4(a) — closes a pre-existing gap where preflight tests had no CI run.

## Refs
- Spec: docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md §5.1, §3a.4, §3a.2, §5.5, §8.1, §10.4
- Plan: docs/superpowers/plans/2026-05-03-plan-execution-housekeeper-implementation.md §Phase 3 + §Decisions-Locked D-7

## Test plan
- [ ] CI green (incl. new test step)
- [ ] Codex 👍
- [ ] 0 unresolved threads
- [ ] All 12 fixture tests pass locally + in CI
- [ ] §5.5 coverage matrix (D-7) row-by-row spot-check: every Phase-3 row has a passing fixture test

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

#### Done Checklist

The housekeeper subagent ticks these boxes in Phase E after PR 3 squash-merges. (Manual flip for PR 3 only — same reason as Phase 1; PR 4 is the housekeeper's first auto-run per spec §10.2.)

- [ ] Task 3.1 — Fixture-loader helper scaffolded
- [ ] Task 3.2 — `parseNsHeading` parser shipped
- [ ] Task 3.3 — `parseSubFields` parser shipped
- [ ] Task 3.4 — `parsePRsBlock` parser shipped
- [ ] Task 3.5 — `computeStatusFromPRs` (§3a.2 matrix) shipped
- [ ] Task 3.6 — `extractFileReferences` (§3a.4 heuristic) shipped
- [ ] Task 3.7 — `parseArgs` + validation (§5.1 step 0) shipped
- [ ] Task 3.8 — Type-signature consistency check shipped
- [ ] Task 3.9 — File-overlap three-state check shipped
- [ ] Task 3.10 — Plan-identity sanity check shipped
- [ ] Task 3.11 — Single-PR status flip shipped
- [ ] Task 3.12 — Multi-PR tick + completion-matrix recompute shipped
- [ ] Task 3.13 — Mermaid class swap shipped
- [ ] Task 3.14 — Plan §Done Checklist tick shipped
- [ ] Task 3.15 — Manifest emission shipped
- [ ] Task 3.16 — `reserveNextFreeNs` shipped
- [ ] Task 3.17 — Duplicate-title guard shipped
- [ ] Task 3.18 — `runHousekeeper` orchestrator shipped
- [ ] Task 3.19 — CLI entrypoint shipped
- [ ] Task 3.20 — Fixture 01 (single-pr-happy-path) authored + green
- [ ] Tasks 3.21-3.29 — Fixtures 02-10 authored + each green
- [ ] Task 3.30 — Fixture 11 (tier-range-audit) authored + green
- [ ] Task 3.31 — Fixture 12 (auto-create) authored + green
- [ ] Task 3.32 — CI step added to `.github/workflows/ci.yml` test-node22 job
- [ ] Task 3.33 — PR opened + merged

---

## Phase 4 — PR 4: Author subagent + wire orchestrator + ship

**Goal:** Add `plan-execution-housekeeper` subagent definition + the orchestrator-side amendments (SKILL.md Phase E rewrite, state-recovery.md appendix, failure-modes.md row, post-merge-housekeeper-contract.md reference doc) + Layer 2 prompt-construction & manifest-validation tests. Ship as a single PR per spec §10.1 last paragraph.

**Branch:** `feat/plan-execution-housekeeper-subagent` **Estimated PR size:** ~600 lines (subagent definition ~150, contract reference ~250, SKILL.md edits ~80, state-recovery + failure-modes ~60, Layer 2 tests ~100).

### Task 4.1: Author the subagent definition

**Files:**

- Create: `.claude/agents/plan-execution-housekeeper.md`

- [ ] **Step 1: Write the YAML frontmatter per spec §5.2**

```yaml
---
name: plan-execution-housekeeper
color: blue
description: Internal subagent for the /plan-execution orchestrator only. Do not invoke directly — the orchestrator dispatches this subagent in Phase E after running post-merge-housekeeper.mjs to perform semantic state hygiene (ready-set re-derivation, line-cite sweep, set-quantifier reverification, NS-XX auto-create, schema-violation reporting, completion-prose composition) on the merged PR's cross-plan-dependencies.md §6 + downstream-doc context. The orchestrator passes the manifest path + script exit code via the prompt parameter; this subagent edits affected files and returns an extended manifest plus a RESULT: tag.
model: inherit
tools: ["Read", "Grep", "Glob", "Edit", "Write"]
---
```

- [ ] **Step 2: Write the body sections per spec §5.2 enumeration**

Sections (mirror `plan-execution-contract-author.md` shape):

```markdown
You are the housekeeper subagent for the `/plan-execution` orchestrator. Your axis is semantic state hygiene across the doc corpus after a plan-execution PR squash-merges.

You are dispatched in isolation. You see only the input the orchestrator gave you (manifest path + script exit code) and the corpus on disk. You have no `Bash`, no `git`, no ability to re-run the script. Your one job is to perform the semantic edits the script can't, validate them, and return a `RESULT:` tag.

## Inputs

The orchestrator passes you (via the `prompt` parameter):

- Manifest path: absolute path to `.agents/tmp/housekeeper-manifest-PR<N>.json`
- Script exit code: 0 / 1 / 2 / 3 / 4 / 5 / ≥6 per spec §5.1
- PR number, plan, phase, optional task-id

If any input is missing or unparseable, return `RESULT: NEEDS_CONTEXT` with a description of the gap.

## Mindset

Your axis is semantic state hygiene across the doc corpus. Mechanical edits are already done; your job is the work that needs to _understand_ the new state.

For each `semantic_work_pending` item in the manifest, either:

- perform the work and add a corresponding `semantic_edits` entry, OR
- explain why it's deferred via a `concerns` entry.

Never silently skip a pending item.

## Hard rules

- **No git, no Bash.** Mechanically enforced via `tools:` omission. You read + edit files only.
- **Do NOT re-run the script.** It has already run; the manifest is its output.
- **Edit only files declared in the manifest's `affected_files` list.** Extending the list is permitted when the line-cite sweep finds new affected files; the orchestrator validates the extension is justified (via a `concerns` entry of `kind: affected_files_extension`).
- **Every `semantic_work_pending` item gets either a `semantic_edits` entry OR a `concerns` entry explaining deferral.** No silent skipping.
- **Replace any `<TODO subagent prose>` placeholders the script left in `Status:` lines** with composed one-line resolution prose matching the NS-12 precedent shape (see `references/post-merge-housekeeper-contract.md` § Status format).
- **Schema violations from script exit 5 are surfaced in `concerns` with `kind: schema_violation` + structured remediation hint, then return `RESULT: BLOCKED`.** Never silently fix. This is the canonical "subagent cannot proceed" exit-state per `references/failure-modes.md` § BLOCKED — the housekeeper's contract is enforce-the-schema-or-halt, identical in shape to a reviewer's ACTIONABLE finding.
- **PRs that touch NS-referenced files but whose body does not annotate any NS-XX** are surfaced as `concerns` with `kind: unannotated_ns_referenced_files` and the entry returns `RESULT: DONE_WITH_CONCERNS`. Do NOT silently no-op. The Reviewer/user decides whether to backfill the NS annotation in PR description or accept the omission.

## Decision presentation

For ambiguous re-derivations (e.g., "is this NS now ready or still blocked by NS-13b?"), present recommendation + alternative + tipping constraint in your `semantic_edits` entry's prose.

## Exit states

The four canonical exit-states from `references/failure-modes.md` (no new states introduced):

- `DONE` — all `semantic_work_pending` items have `semantic_edits` entries; no `concerns` entries.
- `DONE_WITH_CONCERNS` — all pending work addressed, but at least one `concerns` entry surfaces an issue the Reviewer/user should consider.
- `NEEDS_CONTEXT` — you cannot proceed without user input (e.g., AUTO-CREATE Type-classification rule's "Otherwise" halt per spec §5.4; ambiguous re-derivation).
- `BLOCKED` — enforced halt (schema violation, verification failure surfaced from script exit 2).

## Report format

Return:

1. The list of files you edited (must be ⊆ `manifest.affected_files` ∪ `concerns[kind=affected_files_extension].path`).
2. The manifest path (you rewrite it before returning).
3. A suggested commit message in the form: `chore(repo): housekeeping for PR #<N> — NS-XX completion`.
4. A final `RESULT: <state>` tag.

## Reference files

- `references/post-merge-housekeeper-contract.md` — full manifest schema, exit codes, validation invariants, recovery diagnostic, completion-rule matrix, file-reference extraction heuristic.
- `references/failure-modes.md` — the four canonical subagent exit states.
- `references/state-recovery.md` § "Phase E housekeeping recovery" — diagnostic for crash-resume mid-housekeeping.
```

- [ ] **Step 3: Verify yaml + body parse correctly** (lefthook commit-msg hook does not validate subagent files; rely on standalone yaml lint)

```bash
node -e "const yaml = require('yaml'); const fs = require('fs'); const text = fs.readFileSync('.claude/agents/plan-execution-housekeeper.md', 'utf8'); const m = text.match(/^---\n([\s\S]+?)\n---/); console.log(yaml.parse(m[1]))"
```

If `yaml` isn't installed locally, skip this step and rely on the runtime parser when the subagent is dispatched. Mismatch shows up as "agent not found" or YAML parse error.

- [ ] **Step 4: Commit.**

### Task 4.2: Author the contract reference doc

**Files:**

- Create: `.claude/skills/plan-execution/references/post-merge-housekeeper-contract.md`

- [ ] **Step 1: Author the doc**

The doc is the housekeeper's portable reference. Sections (per spec §9.1) — **note the outer fence is 4 backticks** so the inner 3-backtick prompt-template fence in the `## Canonical Subagent Prompt Template` section renders correctly when the contract is authored:

````markdown
# post-merge-housekeeper Contract

The plan-execution housekeeper subagent and its companion script (`scripts/post-merge-housekeeper.mjs`) implement Phase E's auto-housekeeping per Spec [docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md](../../../../docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md).

## Manifest schema

[Insert spec §5.3 verbatim — full JSON example with field annotations.]

## Exit codes

[Insert spec §5.1 exit-code table.]

## Validation invariants

[Insert spec §5.3 validation invariants.]

## Recovery diagnostic

[Insert spec §7.2 resume diagnostic.]

## Completion-rule matrix

[Insert spec §3a.2 matrix.]

## File-reference extraction heuristic

[Insert spec §3a.4 heuristic with all 6 steps.]

## Status format

NS-12 precedent (cross-plan-dependencies.md:454):

> `- Status: \`completed\` (resolved YYYY-MM-DD via PR #<N> — <one-line resolution narrative>)`

The atomic value is backticked (`\`completed\``); the parenthetical resolution prose is one line, the same shape NS-12 uses inline. The script writes `<TODO subagent prose>` as a placeholder; the subagent replaces it with composed prose matching NS-12 tone.

## Canonical Subagent Prompt Template

The script's `buildHousekeeperPrompt` helper (in `lib/housekeeper-orchestrator-helpers.mjs`) emits this prompt verbatim to the `plan-execution-housekeeper` subagent at Phase E dispatch time. The Layer 2 snapshot test in `scripts/__tests__/post-merge-housekeeper-orchestrator-helpers.test.mjs` (Task 4.8 step 1) pins the script's emitted prompt against this fenced block — drift in either direction fails CI (per Plan §Decisions-Locked D-1: this contract is canonical; the script reproduces it verbatim, with `<manifest-path>` / `PR #<N>` / `exit code: <N>` substituted at render time).

```
You are the plan-execution-housekeeper subagent. Phase E auto-housekeeping for PR #<N> ran with exit code: <N>. Manifest: <manifest-path>.

Your responsibilities (per Spec §5.4 / §6.2):

1. Compose completion-prose — replace every `<TODO subagent prose>` placeholder in the manifest's `mechanical_edits.status_flip.to_line` (and in any `semantic_edits` field the script left stubbed) with one-line resolution narratives matching the NS-12 precedent shape. Use the merged-commit context (PR title, body, file diff) to ground each narrative.

2. Re-derive set-quantifier claims — read ONLY `docs/architecture/cross-plan-dependencies.md` §6 prose paragraphs (the `## 6. Active Next Steps DAG` section's intro/closing prose plus inline narrative between NS entries; per Plan §Decisions-Locked D-2). For any quantifying claim invalidated by the merge (e.g. "ready set shares no files with X" / "all Y are Z" / "no W in the list does Q"), surface the invalidation in `concerns[]` with `kind: "set_quantifier_drift"`.

3. AUTO-CREATE body — if `manifest.auto_create !== null`, compose the new NS entry's body (Type / Status / Priority / Upstream / References / Summary / Exit Criteria sub-fields) per the AUTO-CREATE allocation rules in spec §5.4.

4. Reconcile schema_violations — every entry in `manifest.schema_violations` MUST surface in `manifest.concerns[]` with `kind: "schema_violation"`. The script halted with exit ≥1 if any are present; the subagent's job is to surface them, not silently fix them.

5. Bound your edits to `manifest.affected_files` — out-of-scope edits trigger an orchestrator round-trip per `references/failure-modes.md` rule 20 (sprawl routing). To justify a scope expansion, add a `concerns` entry `{kind: affected_files_extension, addressing: <reason>}` and extend `affected_files`.

6. Write back the updated manifest (overwrite `<manifest-path>`) plus any direct file edits via the Edit tool.

7. Return one of the four canonical exit-states (per Plan Invariant I-2): DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. No new exit-state.

Hard rules:
- Do NOT introduce new exit-states.
- Do NOT edit files outside `manifest.affected_files`.
- Do NOT leave `<TODO subagent prose>` placeholders intact.
- Do NOT read NS catalog item BODIES; the §6-prose-only constraint applies to the set-quantifier reverification surface (responsibility #2).
- Do NOT confuse design-spec §6 ("Data flow") with `cross-plan-dependencies.md` §6 ("Active Next Steps DAG"); D-2 routes to the latter.
```
````

- [ ] **Step 2: Verify cite-target hook passes**

```bash
node --experimental-strip-types tools/docs-corpus/bin/pre-commit-runner.ts .claude/skills/plan-execution/references/post-merge-housekeeper-contract.md
```

- [ ] **Step 3: Commit.**

### Task 4.3: Author the orchestrator-helpers module

**Files:**

- Create: `.claude/skills/plan-execution/lib/housekeeper-orchestrator-helpers.mjs`

- [ ] **Step 1: Write the prompt-construction helper test (failing)**

```js
// .claude/skills/plan-execution/scripts/__tests__/post-merge-housekeeper-orchestrator-helpers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
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
  try {
    // Author docs/architecture/cross-plan-dependencies.md with the placeholder string in a Status: line
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
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// P2 fix — validator MUST also scan the VALUES inside semantic_edits.* for leftover placeholders.
// Rationale: the subagent may correctly populate semantic_edits but copy-paste the placeholder
// string into the value (e.g., `compose_status_completion_prose: "...resolved via PR #30 — <TODO subagent prose>"`)
// — when those values get written to the file, the file ends up with the placeholder. Catching at
// the manifest stage is cheaper than catching after the file is mutated.
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
  // Some semantic_edits keys produce arrays of prose lines (e.g., line_cite_sweep yields N annotation strings).
  // Validator must walk any nested structure to find the placeholder, not just check top-level string values.
  const manifest = {
    semantic_work_pending: ["line_cite_sweep"],
    semantic_edits: {
      line_cite_sweep: [
        "Updated cite at line 42",
        "Updated cite at line 57 — <TODO subagent prose>", // leftover in element [1]
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
```

The new tests reference `mkdirSync`, `writeFileSync`, and `rmSync` (Test 6 reaps its tmp dir via `try/finally` to match the sibling `post-merge-housekeeper.test.mjs` convention) — add to the test file's `node:fs` import block (collapse with any existing `node:fs` import line):

```js
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
```

- [ ] **Step 2: FAIL → implement → PASS → commit.**

Implementation:

```js
// .claude/skills/plan-execution/lib/housekeeper-orchestrator-helpers.mjs
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Module-scope literal: the placeholder string the script writes into stubbed `Status:` lines and
// `semantic_edits` values for the subagent to replace. Kept in one place so a future change to the
// literal (or to the validator's checks for it) stays in sync across `validateManifestSubagentStage`
// and `walkForPlaceholder`. Module-private — the prompt template embeds the literal as prose.
const PLACEHOLDER = "<TODO subagent prose>";

export function buildHousekeeperPrompt({ manifestPath, scriptExitCode, prNumber, manifest }) {
  // Pure string composition; tests pin prompt drift.
  //
  // BASE-vs-AUGMENTED contract (load-bearing for the Layer 2 snapshot test in Task 4.8 step 1):
  //
  // 1. BASE prompt = the canonical template in `references/post-merge-housekeeper-contract.md`'s
  //    `## Canonical Subagent Prompt Template` section, verbatim, with three substitutions:
  //      `<manifest-path>` → `manifestPath`
  //      `PR #<N>`        → `PR #${prNumber}`
  //      `exit code: <N>` → `exit code: ${scriptExitCode}`
  //    The base prompt is emitted ALWAYS (every mode). The snapshot test pins this verbatim.
  //
  // 2. AUGMENTATIONS — appended AFTER the base prompt, conditionally, when manifest fields are non-empty:
  //      - manifest.auto_create !== null  → append `\n\nReserved NS slot: NS-${manifest.auto_create.reserved_ns_nn}\nDerived title seed: ${manifest.auto_create.derived_title_seed}\n`
  //          (This is what the AUTO-CREATE test at line ~2218 asserts via /NS-24/ when reserved_ns_nn=24.)
  //      - manifest.schema_violations.length > 0  → append `\n\nRESULT: BLOCKED\nschema_violations: ${JSON.stringify(manifest.schema_violations)}\n`
  //          (This is what the schema-violation test at line ~2225 asserts via /RESULT: BLOCKED/ when scriptExitCode=5.)
  //
  // The snapshot test's input (auto_create: null, schema_violations: []) skips both augmentations,
  // so the rendered prompt equals the canonical template after the three substitutions are reverted.
}

export function validateManifestSubagentStage({ manifest, repoRoot = process.cwd() }) {
  const gaps = [];

  for (const item of manifest.semantic_work_pending ?? []) {
    const inEdits =
      manifest.semantic_edits &&
      Object.prototype.hasOwnProperty.call(manifest.semantic_edits, item);
    const inConcerns = (manifest.concerns ?? []).some((c) => c.addressing === item);
    if (!inEdits && !inConcerns)
      gaps.push(
        `${item} listed in semantic_work_pending but absent from semantic_edits and concerns`,
      );
  }

  for (const path of manifest.affected_files ?? []) {
    const full = join(repoRoot, path);
    if (existsSync(full)) {
      const text = readFileSync(full, "utf8");
      if (text.includes(PLACEHOLDER))
        gaps.push(`${PLACEHOLDER} placeholder still present in ${path}`);
    }
  }

  // P2 fix — scan semantic_edits VALUES for leftover placeholders (the subagent may correctly
  // populate the field but copy-paste the placeholder into the value). Walk nested structures
  // (string / array / object) so all prose surfaces get checked, not just top-level strings.
  for (const [field, value] of Object.entries(manifest.semantic_edits ?? {})) {
    walkForPlaceholder(value, [field], (path) => {
      gaps.push(`${PLACEHOLDER} placeholder still present in semantic_edits.${path.join(".")}`);
    });
  }

  // schema_violations × concerns reconciliation: every entry in schema_violations must appear in
  // concerns with matching kind: schema_violation
  for (const sv of manifest.schema_violations ?? []) {
    const matched = (manifest.concerns ?? []).some((c) => c.kind === "schema_violation");
    if (!matched) gaps.push(`schema_violation ${sv.kind} not surfaced in concerns`);
  }
  return gaps.length === 0 ? { valid: true } : { valid: false, gaps };
}

// Helper: walk a JSON-shaped value (string / array / plain object) and call `onHit` for each
// string leaf containing the placeholder. The `path` array tracks the field path so error
// messages can pinpoint which nested field carries the placeholder.
function walkForPlaceholder(value, path, onHit) {
  if (typeof value === "string") {
    if (value.includes(PLACEHOLDER)) onHit(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkForPlaceholder(item, [...path, String(i)], onHit));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walkForPlaceholder(v, [...path, k], onHit);
  }
}
```

### Task 4.4: SKILL.md edits — Phase E section rewrite

**Files:**

- Modify: `.claude/skills/plan-execution/SKILL.md` Phase E section (lines 421-466 per current shape; verify with grep below before editing — line numbers may have drifted by the time this task runs)

- [ ] **Step 1: Locate the Phase E section**

```bash
grep -n "^## Phase E\|^### Phase E\|^#### Phase E" .claude/skills/plan-execution/SKILL.md
```

Expected: one or two matches inside SKILL.md's "Phases" section. Note the start-line and end-line (next `^##` or `^###` heading) — that range is the section-to-replace.

- [ ] **Step 2: Replace the Phase E section with the verbatim text below**

Use the Edit tool with `old_string` = the entire current Phase E section content (read it fully first via Read with offset/limit) and `new_string` = the exact prose block below. Do NOT paraphrase — this prose is the contract that future plan-execution runs cite.

```markdown
## Phase E — Post-merge housekeeping

Phase E fires AFTER `gh pr merge --squash --delete-branch` returns success — i.e., after the squash-merge commit is on `develop`. It updates the §6 NS catalog and the plan's `Done Checklist` so the catalog stays a faithful index of what shipped. The housekeeper is a 7th plan-execution role (color: blue, tools: Read/Grep/Glob/Edit/Write); see `references/post-merge-housekeeper-contract.md` for the full contract.

The phase has 8 steps in this exact order — DO NOT reorder; step 6 (Progress Log) explicitly moves AFTER housekeeping per spec §6.1 design choice (a single commit bundles housekeeping + log so the post-merge state is atomic):

1. **Run candidate-lookup** over `docs/architecture/cross-plan-dependencies.md` §6 per the four heading-only matching rules in `references/post-merge-housekeeper-contract.md` § Candidate-Lookup Rules:
   - Rule 1: Plan + Phase match (e.g., diff touches `docs/plans/024-rust-pty-sidecar.md` + commit cites Phase 1 → match `### NS-NN: Plan-024 Phase 1 — ...`)
   - Rule 2: Plan + task-id match (e.g., commit cites `T5.1` → match `### NS-NN: Plan-001 Phase 5 Lane A` whose `PRs:` block has a `T5.1` row)
   - Rule 3: Plan + Tier-K match (e.g., diff is a Tier-3 plan-readiness audit → match `### NS-15..NS-21: Tier 3-9 plan-readiness audits` via the lower-endpoint of the range form `tier-3`)
   - Rule 4: No-match fallback (drop to step 2 NEEDS_CONTEXT branch)

2. **Dispatch the script** `node --experimental-strip-types .claude/skills/plan-execution/scripts/post-merge-housekeeper.mjs` based on rule outcome:
   - 1 candidate match → `--candidate-ns NS-NN <plan/phase/task flags>`
   - 0 candidate matches → `--auto-create <plan/phase/task flags>` (script reserves next free NS-NN, writes a stub entry with `<TODO subagent prose>` placeholders)
   - 2+ candidate matches → halt with NEEDS_CONTEXT (orchestrator surfaces both candidates to the user; do NOT auto-disambiguate)

3. **Validate the script-stage manifest** at `.agents/tmp/housekeeper-manifest-PR<N>.json` against the script-stage invariants per spec §5.3:
   - exit code matches `script_exit_code`
   - `mechanical_edits.status_flip.to_line` contains `<TODO subagent prose>` literal placeholder string (subagent fills this)
   - `affected_files` is a subset of files actually edited by the script

4. **Dispatch the `plan-execution-housekeeper` subagent** with the manifest path. The subagent reads the manifest, composes completion-prose for each `<TODO subagent prose>` placeholder using merged-commit context, then re-derives set-quantifier claims by reading ONLY `docs/architecture/cross-plan-dependencies.md` §6 prose (per Plan §Decisions-Locked D-2 — NOT the design spec §6, which is `## 6. Data flow`). Writes back via Edit tool. Returns one of the four canonical exit-states (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED) — no new exit-state per Plan Invariant I-2.

5. **Validate the subagent-stage manifest**:
   - `<TODO subagent prose>` literal is GONE from every line the script touched
   - subagent's edits are confined to `affected_files` (out-of-scope edits → DONE_WITH_CONCERNS routing per `references/failure-modes.md`)
   - schema_violations from script stage are reconciled (each one either fixed or surfaced in `concerns`)

6. **Append the Progress Log entry** to the active session's progress log file (`.agents/tmp/<session-id>/progress.md`). This step explicitly MOVED from before-merge to after-housekeeping per spec §6.1 — the log entry references the squash-merge commit hash + housekeeping commit message + any subagent concerns, so callers reading the log see "shipped + housekept" as one event.

7. **Single `git commit`** that bundles housekeeping (steps 4-5 edits) + Progress Log (step 6 edit) into one commit on `develop`. The commit message follows the contract:
```

chore(repo): housekeeping for PR #<N> — NS-XX <flip-or-create>

```
(subagent's manifest provides the suggested message; orchestrator may amend to add concerns annotations).

8. **Push + verify** — `git push origin develop`. The housekeeping commit is now part of the develop-bound history; subsequent plan-execution runs see the updated catalog. Phase E ENDS here; the orchestrator drains the session.
```

Cross-references the engineer must also add (use Edit calls per cross-link):

- A new bullet at the top of Phase E noting "Per Plan §Decisions-Locked D-3: Phase E ticks ALL Done-Checklist boxes for the merged Phase, not just the most recent task — this matches the orchestrator's complete-Phase-merge trigger."
- A footnote at step 1 cross-linking to Plan §Decisions-Locked D-7 (the §5.5 17-row coverage matrix) so engineers know which fixture validates which rule.

- [ ] **Step 3: Verify rewrite parses + cite-target hook silent**

```bash
node --experimental-strip-types tools/docs-corpus/bin/pre-commit-runner.ts .claude/skills/plan-execution/SKILL.md
```

Expected: silent.

- [ ] **Step 4: Commit.**

### Task 4.5: SKILL.md edits — "Six → Seven subagent roles" line 29

**Files:**

- Modify: `.claude/skills/plan-execution/SKILL.md` line 29 (per spec §9.3)

- [ ] **Step 1: Read current line**

```bash
sed -n '27,32p' .claude/skills/plan-execution/SKILL.md
```

- [ ] **Step 2: Replace "Six subagent roles" → "Seven subagent roles" + append the housekeeper row to the role list**

Use Edit on the exact existing prose. Insert the housekeeper row at the END of the existing role list (the new role is the 7th, appended after `plan-execution-code-reviewer`).

- [ ] **Step 3: Update the Reference Files section to add `references/post-merge-housekeeper-contract.md`**

```bash
grep -n "^## Reference Files\|references/preflight-contract.md" .claude/skills/plan-execution/SKILL.md
```

Then Edit to insert the new reference row alongside the existing one.

- [ ] **Step 4: Commit.**

### Task 4.6: state-recovery.md — Add Phase E housekeeping recovery + inline lookup rules + flag BL-109

**Files:**

- Modify: `.claude/skills/plan-execution/references/state-recovery.md`
- Modify: `docs/backlog.md` (add BL-109 entry)

This task does THREE things in one commit, all closely related: (a) author the recovery diagnostic for Phase E halts, (b) inline the §4.3.2-§4.3.4 candidate-lookup rules so an engineer recovering from a halt has the rules in front of them without having to cross-link to SKILL.md (per A9 — spec §4.3.5 prescribes "lookup rules in BOTH files"), and (c) flag the existing line-174 `.agents/tmp/` lifecycle drift with a BL-109 cross-link (per Plan §Decisions-Locked D-5 + A7).

- [ ] **Step 1: Read current file structure**

```bash
grep -n "^##\|^###" .claude/skills/plan-execution/references/state-recovery.md
```

Expected sections: "Why this matters", "Resumption Checklist", "Edge Cases", "What Durable State Means", "Resuming a Phase A Halt".

- [ ] **Step 2: Append "Phase E housekeeping recovery" section per spec §7.2 verbatim**

Insert at the bottom of the file (AFTER "Resuming a Phase A Halt"). Verbatim text:

```markdown
## Resuming a Phase E housekeeping halt

Phase E (post-merge housekeeping; see SKILL.md § Phase E) halts when:

- The candidate-lookup over §6 returns 2+ matches → `NEEDS_CONTEXT` halt with both candidates surfaced
- The script's mechanical-stage exits ≥1 (NS not found / verification failed / no checklist / multi-PR no task-id / schema violation / arg validation) → see `references/post-merge-housekeeper-contract.md` § Exit Codes
- The subagent returns DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED → routed per `references/failure-modes.md`

Recovery diagnostic — run in this order:

1. **Did the housekeeping commit land?** `git log --oneline -1` on the local `develop` branch — if the latest commit is `chore(repo): housekeeping for PR #<N> — NS-XX ...`, housekeeping completed and Phase E is DONE; resume the next plan-execution from Phase A.
2. **Is the manifest present?** `ls .agents/tmp/housekeeper-manifest-PR<N>.json` (the squash-merge PR number). If absent, the script never wrote it — re-run `node post-merge-housekeeper.mjs` with the same args from the orchestrator's last log entry.
3. **What does `manifest.result` say?** `jq .result .agents/tmp/housekeeper-manifest-PR<N>.json`:
   - `null` → script-stage halt (read `manifest.script_exit_code` + `manifest.schema_violations`)
   - `"DONE"` → housekeeping succeeded; the only remaining work is Phase E step 6-8 (Progress Log + commit + push); finish those manually
   - `"DONE_WITH_CONCERNS"` → read `manifest.concerns`; for each `kind`, follow the routing rule in `references/failure-modes.md`
   - `"NEEDS_CONTEXT"` → read `manifest.concerns[].context_request`; surface to the user; re-dispatch with the requested context
   - `"BLOCKED"` → read `manifest.concerns[].blocker`; cannot proceed; user must decide

Full contract: [`post-merge-housekeeper-contract.md`](post-merge-housekeeper-contract.md).
```

- [ ] **Step 3: Inline the §4.3.2-§4.3.4 candidate-lookup rules (per A9 + spec §4.3.5)**

The diagnostic above mentions "candidate-lookup". A recovering engineer needs the rules in this file too (not just SKILL.md) so they can debug rule-N mismatches without cross-linking. Insert AFTER step 3 of the diagnostic above (before the "Full contract:" closing line):

```markdown
### Candidate-lookup rules (verbatim from SKILL.md § Phase E step 1; mirrored here per spec §4.3.5)

The script's `--candidate-ns` mode is dispatched only after orchestrator-side candidate-lookup returns exactly one match. The four heading-only matching rules (no body parsing) are:

- **Rule 1 — Plan + Phase match:** Diff touches `docs/plans/<NNN>-<slug>.md` AND commit message cites `Phase <N>` → match `### NS-NN: Plan-<NNN> Phase <N> — ...` (case-insensitive on "Phase"). The plan-NN and phase-N must both appear in the heading; `Phase 5 Lane A` matches `Phase 5` (lane suffix is a Phase-5 sub-scope).
- **Rule 2 — Plan + task-id match:** Commit message cites `T<phase>.<sub>` (e.g., `T5.1`) or `T-NNN-N-N` (e.g., `T-001-5-1`) → match `### NS-NN: Plan-<NNN> Phase <N> ...` whose `PRs:` block contains a row matching the task-id. Requires reading the `PRs:` block, but only to disambiguate among Phase-matching candidates.
- **Rule 3 — Plan + Tier-K match:** Diff is a plan-readiness audit (matches `docs/plans/<tier-K>-<...>.md` shape) → match `### NS-NN..NS-MM: Tier <K>-<L> plan-readiness audits` via the lower-endpoint `tier-K` form. The task-arg form is `tier-3` (per Plan §Decisions-Locked D-4); range merges always use the lower endpoint, so `tier-3-9` is REJECTED at arg-parse.
- **Rule 4 — No-match fallback:** If rules 1-3 produce zero matches, the orchestrator drops to `--auto-create` (which reserves the next free NS-NN with stub fields). If the orchestrator's intent was to MATCH (not create), surface NEEDS_CONTEXT halt with the rule-1/2/3 attempts so the user can disambiguate.

If a Phase E halt's `manifest.script_exit_code === 1` (no NS match), trace which rule should have matched and why it didn't — typo'd Plan-NN, missing `PRs:` block row, lookup-rule-3 lower-endpoint mismatch, etc. The fixture `11-tier-range-audit` (Plan §Decisions-Locked D-7 row 11) is the canonical rule-3 test case to consult for shape comparison.
```

- [ ] **Step 4: Reserve BL-109 in `docs/backlog.md`**

Append a new entry to `docs/backlog.md` (at the appropriate Active-items location):

```markdown
### BL-109: Reconcile `.agents/tmp/` lifecycle drift between state-recovery.md and lefthook.yml

- Status: `todo`
- Priority: `P3`
- References:
  - [`state-recovery.md` § "What Durable State Means"](../.claude/skills/plan-execution/references/state-recovery.md) — line documents `.agents/tmp/` as gitignored + deleted-at-commit-time per AGENTS.md
  - [`lefthook.yml`](../lefthook.yml) — current pre-commit chain has NO `.agents/tmp/` prune job
  - [Spec docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md §9.3](../docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md) — explicit deferral; out of housekeeper scope
- Summary: The `state-recovery.md` doc claims `.agents/tmp/` is "deleted at commit time per AGENTS.md", but `lefthook.yml`'s pre-commit chain has no prune job. Either add the lefthook job (mechanical fix) or reword the doc to match observed behavior (no auto-prune; manual cleanup expected). Spec §9.3 defers reconciliation to here.
- Exit Criteria: One of (a) `lefthook.yml` gains a `pre-commit > prune-agents-tmp` job that mirrors AGENTS.md's "deleted at commit time" claim, or (b) `state-recovery.md` is reworded to drop the deletion claim and say "manually clean up after commits" — and the corresponding state-recovery.md `> **Note:**` block authored in this task is removed.
```

- [ ] **Step 5: Add the `> **Note:** ...` block flagging the BL-109 cross-link in state-recovery.md**

Per spec §9.3, add a callout AT line 174 (the existing `.agents/tmp/` lifecycle prose). Insert IMMEDIATELY AFTER that line. The relative path `../../../../docs/backlog.md` is **4 hops** up from `.claude/skills/plan-execution/references/` to the repo root, then down into `docs/` (verified at plan-write time via `readlink -f ../../../../docs/backlog.md` resolving to the absolute repo path). Verbatim text:

```markdown
> **Note (deferred drift; tracked as BL-109):** the assertion above that `.agents/tmp/` is "deleted at commit time per AGENTS.md" describes intended behavior, NOT what `lefthook.yml` currently enforces — the pre-commit chain has no prune job. Reconciliation (add the lefthook job OR reword this doc) is tracked as [BL-109](../../../../docs/backlog.md#bl-109-reconcile-agentstmp-lifecycle-drift-between-state-recoverymd-and-lefthookyml). Per spec §9.3 this is explicitly out of the housekeeper plan's scope.
```

The slug `#bl-109-reconcile-agentstmp-lifecycle-drift-between-state-recoverymd-and-lefthookyml` is GitHub's deterministic slugification of the BL-109 header authored in step 4 (`### BL-109: Reconcile ...`) — colon stripped, dots stripped, slashes stripped, spaces → single dash, runs of dashes collapsed. If step 4's header is reworded, regenerate this slug and update the link.

- [ ] **Step 6: Verify cite-target hook passes**

```bash
node --experimental-strip-types tools/docs-corpus/bin/pre-commit-runner.ts \
  .claude/skills/plan-execution/references/state-recovery.md \
  docs/backlog.md
```

Expected: silent.

- [ ] **Step 7: Commit.**

```bash
git add .claude/skills/plan-execution/references/state-recovery.md docs/backlog.md
git commit -m "$(cat <<'EOF'
docs(repo): add Phase E recovery + inline lookup rules; reserve BL-109

state-recovery.md: append "Resuming a Phase E housekeeping halt" diagnostic
(per spec §7.2) and mirror the four §4.3.2 candidate-lookup rules inline (per
spec §4.3.5) so a recovering engineer doesn't need to cross-link to SKILL.md
to debug rule-N mismatches. Flag the existing line-174 .agents/tmp/ lifecycle
drift with a `> Note:` block linking to BL-109.

backlog.md: reserve BL-109 to track reconciling state-recovery.md's ".agents/
tmp/ deleted at commit time" claim with lefthook.yml (which has no such job).

Refs: spec §6.1, §7.2, §4.3.5, §9.3; Plan §Decisions-Locked D-5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.7: failure-modes.md — Add Phase E housekeeper routing rules + sprawl pattern

**Files:**

- Modify: `.claude/skills/plan-execution/references/failure-modes.md`

This task adds TWO new routing rules (numbered 20 and 21 — continuing the global numbering convention noted at line 164 of the file: "Rule numbers are global across phases ... restarting at 1 after each heading would break the cross-references"). Both rules live under the existing `### Phase E — CI` section and extend it to cover housekeeper-specific patterns. Per spec §7.1 invariant, NO new exit-state is introduced — both rules reuse the existing canonical four (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED).

- [ ] **Step 1: Verify current file structure (sanity check before editing)**

```bash
grep -n "^##\|^###\|^[0-9]\+\." .claude/skills/plan-execution/references/failure-modes.md | head -40
```

Expected: section headings include `## Routing Rules`, `### Phase A`, `### Phase B / C`, `### Phase B level boundary`, `### Phase D`, `### Phase E — CI`. Rule numbers run 1-19 with 17/18/19 inside `### Phase E — CI`. The next rule number is 20.

- [ ] **Step 2: Insert rules 20 and 21 immediately AFTER rule 19 and BEFORE the `<!-- markdownlint-enable MD029 -->` line**

Use the Edit tool with `old_string` = the rule-19 line + the markdownlint-enable line, and `new_string` = the existing rule-19 line + new rules 20-21 + the markdownlint-enable line. Verbatim text:

`old_string`:

```
19. **CI red on infrastructure issue (GitHub Actions outage, unrelated environment failure)** → halt; surface to user.

<!-- markdownlint-enable MD029 -->
```

`new_string`:

```
19. **CI red on infrastructure issue (GitHub Actions outage, unrelated environment failure)** → halt; surface to user.

### Phase E — Post-merge housekeeping (housekeeper subagent + script round-trip)

20. **Housekeeper subagent edits files outside the manifest's `affected_files` declaration** → round-trip dispatch (NOT a new exit-state per spec §7.1 invariant). The orchestrator detects the sprawl by diffing `git status --short` against `manifest.affected_files`; any file in the diff not in `affected_files` is out-of-scope. Re-dispatch the subagent with the prompt: "Your last run edited <file_a>, <file_b> which are NOT in the manifest's `affected_files`. Either (a) revert those out-of-scope edits and re-emit your manifest, OR (b) extend `affected_files` AND add a `concerns` entry of `{kind: affected_files_extension, addressing: <reason>}` to justify the scope expansion." After re-dispatch returns DONE, the orchestrator validates the resolution choice. If the subagent picks (b) with weak justification, downgrade to DONE_WITH_CONCERNS and surface to user.

21. **Housekeeper script schema-violation halt (exit 5) → subagent surfaces in concerns → returns BLOCKED** → reuse the existing BLOCKED routing from rule 4 (graceful drain in worktree mode; immediate halt in sequential mode). Per spec §7.1 invariant, NO new exit-state is introduced for this case. The orchestrator surfaces the consolidated `manifest.schema_violations` list to the user, who decides: (a) accept and let the malformed §6 entry ship — flag for follow-up; (b) abort the housekeeping commit; (c) hand-edit the §6 entry to fix the schema violation, then re-dispatch. Cross-link: `references/post-merge-housekeeper-contract.md` § Exit Codes documents which malformations trigger exit 5.

<!-- markdownlint-enable MD029 -->
```

- [ ] **Step 3: Verify the file parses + cite-target hook silent**

```bash
node --experimental-strip-types tools/docs-corpus/bin/pre-commit-runner.ts .claude/skills/plan-execution/references/failure-modes.md
```

Expected: silent.

- [ ] **Step 4: Update SKILL.md cross-references that name "the rules" by number**

```bash
grep -n "rule 1[0-9]\|rule [0-9]\b" .claude/skills/plan-execution/SKILL.md
```

If any prose references `rule 19` or earlier with phrasing like "the last rule", update to `rule 21` so future maintainers know rule 20-21 exist. (Most callsites cite specific rule numbers like "rule 9" — those don't need updating; only "the last rule" / "the highest-numbered rule" phrasings drift.)

- [ ] **Step 5: Commit.**

```bash
git add .claude/skills/plan-execution/references/failure-modes.md .claude/skills/plan-execution/SKILL.md
git commit -m "docs(repo): add Phase E housekeeper routing rules 20-21 to failure-modes.md"
```

### Task 4.8: Author Layer 2 unit tests for D-7 rows 12-15 (snapshot, zod parse, set-superset, sprawl routing)

**Files:**

- Modify: `.claude/skills/plan-execution/scripts/__tests__/post-merge-housekeeper-orchestrator-helpers.test.mjs` (add 4 unit tests)
- Modify: (test file may need imports for `zod` peer dep; verify it's already a dev dep via `pnpm why zod` from repo root before authoring)

This task closes the §5.5 row 12, 13, 14, 15 coverage gap surfaced in Plan §Decisions-Locked D-7. Each test pins a specific subagent-stage invariant that doesn't fit the fixture-driven Layer 1 harness because it's about subagent prompt/manifest structure rather than mechanical-edit output.

- [ ] **Step 1: Test for D-7 row 12 — prompt-template snapshot vs Task 4.2 contract**

````js
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
  const normalized = emitted
    .replace("/tmp/m.json", "<manifest-path>")
    .replace("PR #30", "PR #<N>")
    .replace("exit code: 0", "exit code: <N>");
  assert.equal(
    normalized.trim(),
    canonicalTemplate.trim(),
    "buildHousekeeperPrompt drift from contract — update one to match the other (Plan §Decisions-Locked D-1: contract is canonical)",
  );
});
````

- [ ] **Step 2: Test for D-7 row 13 — zod parse against §5.3 schema**

```js
import { z } from "zod";

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
});
```

- [ ] **Step 3: Test for D-7 row 14 — `affected_files` superset of script-detected file overlap**

```js
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
```

- [ ] **Step 4: Test for D-7 row 15 — sprawl outside affected_files routes to DONE_WITH_CONCERNS**

This test exercises the routing rule 20 added in Task 4.7. It can live in this file (close to the validator tests) or in a separate `failure-modes-routing.test.mjs` — either is fine; the assertion is the same:

```js
import { detectAffectedFilesSprawl } from "../../lib/housekeeper-orchestrator-helpers.mjs";

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
```

The new `detectAffectedFilesSprawl` helper is added to `housekeeper-orchestrator-helpers.mjs` as a pure function — no I/O, just set-difference. Implementation outline:

```js
export function detectAffectedFilesSprawl({ manifestAffectedFiles, gitDiffFiles }) {
  const declared = new Set(manifestAffectedFiles);
  const outOfScope = gitDiffFiles.filter((f) => !declared.has(f));
  return outOfScope.length === 0
    ? { sprawl: false }
    : {
        sprawl: true,
        outOfScope,
        suggestedRouting: "DONE_WITH_CONCERNS",
        suggestedConcernKind: "affected_files_extension",
      };
}
```

- [ ] **Step 5: Test for I-1 — cite-target hook still extracts spec §1.1.1 verbatim NS quote blocks (NEW per AdvF-5)**

```js
import { execSync } from "node:child_process";

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
```

This test runs `pre-commit-runner.ts` as a subprocess. It uses Node's `execSync` (not Bash) for portability. The test asserts STDERR is empty after success; on failure, the captured output explains which cite broke.

- [ ] **Step 6: Test for I-2 — subagent definition file declares exactly the four canonical exit-states (NEW per AdvF-5)**

```js
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
```

- [ ] **Step 7: Test for I-3 — script does NOT shell out for git (NEW per AdvF-5)**

```js
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
```

- [ ] **Step 8: Run the full test suite to confirm all 7 tests pass + no regression**

```bash
node --test --experimental-strip-types .claude/skills/plan-execution/scripts/__tests__/post-merge-housekeeper-orchestrator-helpers.test.mjs
```

- [ ] **Step 9: Commit.**

```bash
git add .claude/skills/plan-execution/scripts/__tests__/post-merge-housekeeper-orchestrator-helpers.test.mjs .claude/skills/plan-execution/lib/housekeeper-orchestrator-helpers.mjs
git commit -m "test(repo): Layer 2 unit tests for D-7 rows 12-15 + I-1/I-2/I-3 invariant regression"
```

### Task 4.9: Run all Layer 1 + Layer 2 tests locally

- [ ] **Step 1: Run the full test command**

```bash
node --test --experimental-strip-types .claude/skills/plan-execution/scripts/__tests__/
```

Expected: all tests pass (12 fixture tests from Phase 3 + parser units from Phase 3 + 4 Layer 2 helper tests from Task 4.3 + 4 Layer 2 D-7-row tests from Task 4.8).

- [ ] **Step 2: If any fail, fix root cause + re-run.** Do not commit failures.

### Task 4.10: Open the PR

- [ ] **Step 1: Push + open PR**

```bash
git push -u origin feat/plan-execution-housekeeper-subagent
gh pr create --title "feat(repo): housekeeper subagent + Phase E orchestrator wiring" --body "$(cat <<'EOF'
## Summary
- Adds the 7th plan-execution subagent role: \`plan-execution-housekeeper\` (color: blue; tools Read,Grep,Glob,Edit,Write).
- Adds \`references/post-merge-housekeeper-contract.md\` with manifest schema, exit codes, validation invariants, recovery diagnostic, completion-rule matrix, file-reference extraction heuristic.
- SKILL.md Phase E section rewritten with candidate-lookup prose (per spec §4.3.2 / §4.3.3) and 8-step ordering (per spec §6.1 — Progress Log moves AFTER housekeeping into the same commit).
- "Six subagent roles" → "Seven subagent roles" at SKILL.md line 29; Reference Files section gains the contract row.
- state-recovery.md: Phase E housekeeping recovery section (per spec §7.2) + flag for the line-174 .agents/tmp/ lifecycle drift (deferred reconciliation per spec §9.3).
- failure-modes.md: row for "subagent sprawls beyond affected_files" round-trip pattern; cross-links BLOCKED routing for schema-violation halts (no new exit-state introduced).
- Layer 2 tests: prompt construction (3 modes: happy / AUTO-CREATE / schema-violation) + manifest-stage validation (pending-item coverage + leftover-placeholder detection + schema_violation reconciliation).

## Refs
- Spec: docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md §5.2, §5.3, §5.4, §6.1, §6.2, §7.1, §7.2, §7.3, §9.1, §9.3, §10.1
- Plan: docs/superpowers/plans/2026-05-03-plan-execution-housekeeper-implementation.md §Phase 4

## Test plan
- [ ] CI green
- [ ] Codex 👍
- [ ] 0 unresolved threads
- [ ] All Layer 1 + Layer 2 tests pass
- [ ] Manual Layer 3 (subagent E2E) run pre-merge: \`node .claude/skills/plan-execution/scripts/__tests__/run-subagent-against-fixtures.mjs\` against fixtures 01 + 05 + 09 (or whichever fixtures expose the most semantic-stage variation). Note: Layer 3 runner is NOT in this PR's scope (spec §8.3 marks it manual + non-CI).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

#### Done Checklist

The housekeeper subagent itself ticks these boxes in Phase E after PR 4 squash-merges. Per spec §10.2 bootstrap, PR 4 IS the housekeeper's first auto-run — so this checklist is the very first one the housekeeper ticks autonomously. Watch for partial-tick anomalies (D-3 says ALL boxes get ticked; if only some land, the §6.1 ordering invariant is broken).

- [ ] Task 4.1 — Subagent definition `.claude/agents/plan-execution-housekeeper.md` authored
- [ ] Task 4.2 — Contract reference `references/post-merge-housekeeper-contract.md` authored
- [ ] Task 4.3 — Orchestrator-helpers module + Layer 2 helper tests shipped
- [ ] Task 4.4 — SKILL.md Phase E section rewritten verbatim per Plan §Decisions-Locked D-3
- [ ] Task 4.5 — SKILL.md role count "Six → Seven" + Reference Files row added
- [ ] Task 4.6 — state-recovery.md Phase E recovery section + lookup rules + BL-109 cross-link
- [ ] Task 4.7 — failure-modes.md routing rules 20 + 21 added
- [ ] Task 4.8 — Layer 2 D-7-row tests (snapshot, zod, superset, sprawl) shipped
- [ ] Task 4.9 — All Layer 1 + Layer 2 tests run locally (green)
- [ ] Task 4.10 — PR opened + merged

---

## Post-Phase-4 — Validation Window (Spec §10.3)

After PR 4 ships, the next plan-execution PR is the housekeeper's **first auto-run** (per spec §10.2 bootstrap). The validation window per spec §10.3:

- Inspect manifest output at `.agents/tmp/housekeeper-manifest-PR<N>.json` post-merge (still on local clone)
- Inspect resulting §6 / mermaid / plan-checklist edits
- Inspect downstream-doc line cites + set-quantifier claims
- Inspect `Status:` line completion prose for NS-12-shape compliance
- File a new backlog item (next free `BL-NNN` per `docs/backlog.md` at the time the validation window runs — at plan-write time the next free is `BL-110`, since `BL-109` is reserved by Task 4.6 for the `.agents/tmp/` lifecycle drift) if anything is wrong; iterate

**Exit criteria:** 3 consecutive PRs with zero manual housekeeping touch-ups after merge. Until met, the housekeeper is "shipping but on probation" — flag in the next session retrospective.

---

## Self-Review Checklist (already executed inline; documented here for future maintainers)

**Spec coverage:**

- §1 background + schema-by-example → no implementation needed (reference material).
- §2 goals/non-goals → no implementation needed.
- §3 decision log → no implementation needed.
- §3a.1 PRs: grammar → Phase 1 Tasks 1.3, 1.4, 1.5 (migration); Phase 3 Task 3.4 (parser).
- §3a.2 completion matrix → Phase 3 Task 3.5 (computeStatusFromPRs covers all 6 rows).
- §3a.3 NS-23 amendment → Phase 1 Tasks 1.1, 1.2, 1.6.
- §3a.4 file-reference extraction heuristic → Phase 3 Task 3.6 (extractFileReferences with all 6 heuristic rules incl. brace-expansion + filesystem resolution + scoping note).
- §3a.5 why structured PRs beats prose → no implementation (rationale).
- §4.1 architectural decisions → embodied in Phase 3 (script does verification not derivation) + Phase 4 (subagent does semantic).
- §4.2 new role → Phase 4 Task 4.1 (subagent file) + Task 4.5 (SKILL.md role count update).
- §4.3 orchestrator candidate-lookup → Phase 4 Task 4.4 (SKILL.md Phase E rewrite) + Task 4.6 (state-recovery.md appendix).
- §5.1 script — invocation + steps 0-8 (--candidate-ns) + 1'-4' (--auto-create) → Phase 3 Tasks 3.7-3.19.
- §5.2 subagent definition → Phase 4 Task 4.1.
- §5.3 manifest schema → Phase 3 Task 3.15 (emit) + Phase 4 Task 4.3 (validate).
- §5.4 AUTO-CREATE contract → Phase 3 Tasks 3.16, 3.17 (script side) + Phase 4 Task 4.1 subagent body (subagent side per spec §5.4 allocation rules).
- §5.5 17-row verification table → Phase 3 fixture authoring (Tasks 3.20-3.31 cover the orthogonal axes per spec §5.5.1 plus the two NEW fixtures `11-tier-range-audit` (Task 3.30) and `12-auto-create` (Task 3.31) added per Plan §Decisions-Locked D-7; the explicit §5.5-row → fixture mapping lives in the D-7 table at Plan line 162).
- §6 data flow → no implementation (it's the integration view across script + subagent + orchestrator).
- §6.1 Progress Log ordering → Phase 4 Task 4.4 (SKILL.md Phase E rewrite reorders Progress Log).
- §6.2 happy-path narrative → no implementation (it's the user-facing observable).
- §7.1-7.4 failure handling → Phase 3 Tasks 3.7 (arg validation crash) + 3.8-3.10 (verification halts) + 3.15 (exit-code-aware manifest emission) + Phase 4 Task 4.1 subagent body's "Hard rules" section + Task 4.7 failure-modes.md row.
- §7.5 manifest hand-edit boundary → Phase 4 Task 4.4 (SKILL.md Phase E section's "Validate manifest" steps note the trust boundary).
- §8.1 Layer 1 fixture tests → Phase 3 Tasks 3.20-3.31 (10 spec-listed fixtures + 2 NEW fixtures from D-7 mapping).
- §8.2 Layer 2 prompt + manifest validation tests → Phase 4 Task 4.3.
- §8.3 Layer 3 manual E2E → out of plan scope (manual; spec §8.3 explicitly NOT in CI).
- §8.4 Layer 4 live-PR validation → out of plan scope (post-PR-4 observation window).
- §8.5 explicit non-tests → no implementation.
- §8.6 test infrastructure summary → covered by Tasks 3.20-3.31 (Layer 1 fixtures) + 4.3 + 4.8 (Layer 2 helpers + D-7-row regression) + 3.32 (CI wiring).
- §9.1 new files → all created across Phases 3 + 4 per file structure table above.
- §9.2 moved files → Phase 2 Task 2.1.
- §9.3 modified files → all phases per file structure table above.
- §10.1 build-and-ship sequence → Phases 1, 2, 3, 4 mirror PRs 1, 2, 3, 4.
- §10.2 bootstrap → no implementation (post-PR-4 observation).
- §10.3 validation window → out of plan scope (post-PR-4).
- §10.4 CI wiring → Phase 3 Task 3.32 per recommendation (a) GitHub Actions step.
- §10.5 lefthook .agents/tmp/ cleanup → out of plan scope per spec recommendation (skip for V1).
- §11 open questions → Q11.4, Q11.6, Q11.7 RESOLVED at plan-write time via Plan §Decisions-Locked D-1, D-2, D-3 (canonical prompt template at `.claude/skills/plan-execution/references/post-merge-housekeeper-contract.md`; subagent reads only `cross-plan-dependencies.md` §6 prose for set-quantifier reverification; Phase E ticks ALL Phase boxes). Q11.1, Q11.2, Q11.3, Q11.5 either resolved by spec body or out-of-plan-scope (release-time / post-V1 observation). No §11 questions remain gating.

**Placeholder scan:** No "TBD" / "implement later" / "fill in details" strings remain. Where the plan refers to spec sections (e.g., "per spec §3a.2 matrix"), the spec section itself contains the concrete content.

**Type consistency:** Function signatures referenced in later tasks (e.g., `runHousekeeper`, `parseSubFields`, `computeStatusFromPRs`) match their definition tasks. Manifest field names (`mechanical_edits`, `semantic_work_pending`, `affected_files`, `auto_create.reserved_ns_nn`) match spec §5.3 verbatim across all tasks.

**Spec gaps surfaced during plan authoring:**

- The spec doesn't fully specify the `concerns[].addressing` field shape used by `validateManifestSubagentStage` to reconcile pending items. The plan's Task 4.3 implementation introduces `addressing: <pending_item_name>` as a convention; if the subagent prompt template needs updating to mirror this, it gets incorporated into Task 4.1 subagent body (the "Hard rules" section). Flagging here for the implementer to confirm or refine.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-03-plan-execution-housekeeper-implementation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task; review between tasks; fast iteration. Best for Phase 3 (TDD-heavy with many small tasks) and Phase 4 (subagent body authoring + helpers + SKILL.md edits).

**2. Inline Execution** — Execute tasks in this session using executing-plans skill; batch with checkpoints. Best for Phase 1 (doc-only, low risk) and Phase 2 (mechanical file move + 5 path edits).

Hybrid is also valid: Phase 1 + 2 inline, Phase 3 + 4 subagent-driven.

**Which approach?**
