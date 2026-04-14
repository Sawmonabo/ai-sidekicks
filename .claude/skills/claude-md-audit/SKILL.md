---
name: claude-md-audit
description: Audit all CLAUDE.md, .claude/rules/*.md, and @-included files (e.g., AGENTS.md) in a repository for redundancy caused by progressive context loading. Use when the user wants to analyze CLAUDE.md quality, find duplicate or overlapping instructions across files, optimize context token budget, or understand how their instruction files interact during progressive disclosure. Supports @AGENTS.md includes and other @file.md references. Trigger on "audit CLAUDE.md", "CLAUDE.md redundancy", "context overlap", "duplicate instructions", "optimize CLAUDE.md", "instruction file review", "AGENTS.md overlap", or any mention of reducing repetition across CLAUDE.md files.
---

# CLAUDE.md Progressive Loading Redundancy Audit

Perform an exhaustive redundancy analysis of all instruction files that Claude Code loads into context. The goal: identify every instance where a later-loaded file restates information the agent already has from an earlier-loaded file.

## Why This Matters

Claude Code loads instruction files progressively — root CLAUDE.md first, then rules files, then subdirectory CLAUDE.md files as the agent enters directories. Every redundant restatement in a later file causes harm:

| Impact | Mechanism |
|--------|-----------|
| Token waste | The agent already knows this; repeating it shrinks the budget for actual work |
| Drift risk | The "same" rule phrased differently in 3 files will eventually diverge when one gets updated and the others don't |
| Signal buried | When 40% of a subdirectory CLAUDE.md restates root content, the genuinely new layer-specific guidance gets obscured |

## Phase 1: Discovery and Loading Order

Run the discovery script to find all instruction files and determine their loading order. Detect the available Python runtime — the user may have `python3`, `python`, or only `uv`:

```bash
PYTHON=$(command -v python3 || command -v python || echo "uv run python") && \
$PYTHON .claude/skills/claude-md-audit/scripts/discover.py
```

The script outputs a JSON manifest with files grouped by loading phase. If the script fails or no Python runtime is available, discover manually:

1. Find files: `find . -name "CLAUDE.md" -o -name ".claude.md" -o -name ".claude.local.md" 2>/dev/null` and `find .claude/rules -name "*.md" 2>/dev/null`
2. For each rules file, read the first 5 lines. If YAML frontmatter contains `paths:`, it's **path-scoped** (loads only when agent works in matching directories). Otherwise it's **always-loaded**.
3. Sort subdirectory CLAUDE.md by directory depth (shallowest first).

Loading phases:

| Phase | What Loads | When |
|-------|-----------|------|
| 1 | Root `./CLAUDE.md` | Always, every conversation |
| 2 | `.claude/rules/*.md` without `paths:` frontmatter | Always, every conversation |
| 3 | `.claude/rules/*.md` with `paths:` frontmatter | When agent works in matching paths |
| 4 | Subdirectory `CLAUDE.md` files (sorted by depth) | When agent enters that directory |

## Include Resolution (@-References)

The discovery script also detects `@file.md` references in CLAUDE.md files (e.g., `@AGENTS.md`). These are files whose content enters the agent's context as part of the including CLAUDE.md's load.

IF the manifest contains `includes` entries, THEN:

| Include Status | Meaning | Action |
|---------------|---------|--------|
| `resolved: true` | File exists, will be loaded | Read it after its including CLAUDE.md |
| `resolved: false` (in `unresolved_references`) | Reference found but file missing | Report as broken reference in Section 1 |
| Entry in `circular_references` | File A includes B which includes A | Report in Section 1, do not re-read |

IF the manifest has NO `includes` entries (all empty), THEN skip all include-related analysis. The audit proceeds identically to a repo with no @-references.

An included file inherits the phase of the CLAUDE.md that includes it. It is NOT a new phase. IF root CLAUDE.md includes `@AGENTS.md`, THEN AGENTS.md is Phase 1 content. IF `src/api/CLAUDE.md` includes `@AGENTS.md`, THEN that AGENTS.md is Phase 4 content.

## Phase 2: Read Everything

1. Read every discovered file completely. Do not skip files, sample, or read partially. The accuracy of this audit depends on having ALL content in context simultaneously — this is the advantage of LLM-based analysis over programmatic approaches.
2. Read files in loading order. As you read each file, treat everything from previously-read files as "what the agent already knows."
3. IF a file has `includes` in the manifest, THEN read the including CLAUDE.md first (its own content), then read each included file in the order listed. The included file's concepts are attributed to the included file, NOT to the including CLAUDE.md.

## Phase 3: Concept Extraction and Tracking

Break each file into discrete **concepts** — the atomic units of information the file communicates.

A concept is one of:
- A bullet point or list item stating a rule, constraint, or fact
- A table row (excluding header rows) conveying a specific instruction
- A paragraph that communicates a single idea
- A CRITICAL/MUST/NEVER statement
- An IF/THEN conditional rule
- A code example demonstrating a required pattern

For each concept, record: file path, line number, section header, and the key identifiers it mentions (function names in backticks, module paths, technical terms).

### Tracking Method

Maintain a running **concept registry** as you read files in loading order:

1. **File 1 (root CLAUDE.md):** Every concept is new. Add all to registry.

2. **File 2 and beyond:** For each concept in the new file, scan the registry. If a match exists, classify the redundancy. If no match, add to registry as new.

3. **Self-duplication pass (required, every file):** After completing the per-file breakdown, verify every summary section ("When in Doubt", "Quick Reference", "Top 10", utility tables, navigation indexes) against the detailed sections earlier in the SAME file. These sections almost always restate earlier content. Mark matches as self-duplication in the per-file table.

### Self-Duplication Patterns to Watch For

| Pattern | What It Looks Like | Why It's Easy to Miss |
|---------|-------------------|----------------------|
| Mirror tables | A "Safety Constraints" table and a "Never" table in the same file expressing the same rules from opposite angles (what to do vs what not to do) | Different table headers make them look like different content |
| Priority lists under different headers | The same N items ranked in similar order appearing twice — once as "loading order" and again as "trust hierarchy" or "source-of-truth hierarchy." Different column metadata does not make the core ranking new | Different section titles and column names disguise the shared item list |
| Invariant restated as prose then table | A CRITICAL/MUST statement at the top of a file, then the same constraint in a table body later in the same file | The prose version and table version feel like different "formats" but convey the same rule |
| Conditional rules echoing table content | An IF/THEN rule in a "Conditional Rules" section that restates an action rule already present in a table row earlier in the same file | The IF/THEN framing makes it look like new behavioral instruction |
| Link indexes under different headers | Two sections listing file paths or doc references. Extract the target paths from each and compare sets — if >50% overlap, flag as self-duplication regardless of format | One may be a table, the other a categorized list — compare targets, not presentation |

### Peer-Level Comparison

After processing all files through the registry, compare files at the same directory depth. IF two peer files share >60% structural overlap (same section headings, same content in corresponding sections), THEN flag as `Peer duplication` in Section 3. Neither file owns the shared content — attribute to a missing shared template in the parent.

### Included File (@-Reference) Concepts

IF a file was loaded via @include (manifest field `loading: "included"`), THEN:

| Scenario | Ownership Rule |
|----------|---------------|
| Concept appears ONLY in included file (e.g., AGENTS.md) | Owned by the included file, at the phase of its including CLAUDE.md |
| Concept in both including CLAUDE.md AND its @included file | CLAUDE.md owns it (read first). The included file's copy is redundant |
| Same file @included by two different CLAUDE.md files | First inclusion (earlier phase) owns concepts. Second inclusion adds 100% redundancy for that content |
| Concept in @included file AND in a rules file | Whichever loads first per the loading order owns it |

The included file gets its own row in the saturation tracker, its own per-file breakdown, and its own entry in the cumulative table. Do NOT merge its concepts with the including CLAUDE.md.

## Phase 4: Redundancy Classification

When a concept in a later file matches one already in the registry, classify it:

| Type | Definition | Is Redundant? |
|------|-----------|:-------------:|
| **Exact** | Same words, same meaning, same specificity | Yes |
| **Paraphrased** | Different wording, same constraint or rule | Yes |
| **Subset** | Later file states part of a broader rule from earlier file | Yes |
| **Elaboration** | Later file adds specificity, examples, or mechanisms to a general rule from an earlier file | Partially — the general rule is redundant, the new detail is not |
| **Reference-only** | Later file names an earlier concept but adds NEW behavioral instruction (when/how to verify, what to check) | No — the reference is a pointer, the instruction is new |

The distinction between **paraphrased** and **reference-only** is critical:

| Statement in later file | Classification | Reasoning |
|------------------------|---------------|-----------|
| "All imports must be top-level" (in rules file) | Paraphrased — **Redundant** | Root already states this; no new behavioral guidance added |
| "IF modifying session.py, THEN verify apply_tenant_context() still sets all 5 GUCs" | Reference-only — **Not redundant** | References RLS concept but adds a path-to-action verification trigger the agent didn't have |

IF in doubt about a classification, THEN apply this test: "If I deleted this statement from the later file, would the agent lose any behavioral guidance it doesn't already have?" If no → redundant. If yes → not redundant.

## Phase 5: Report

Generate the report with these exact sections. Include every finding — do not summarize or abbreviate.

### Section 1: Loading Sequence

```
PHASE 1 — ALWAYS LOADED (every conversation)
  path/to/CLAUDE.md                     N lines
    ↳ @AGENTS.md                        N lines (included)
  .claude/rules/always-loaded.md        N lines
  ...
  Subtotal: N lines (N direct + N included)

PHASE 2 — PATH-SCOPED (conditional)
  .claude/rules/scoped.md              N lines
    triggers on: path/pattern/**
  ...

PHASE 3 — SUBDIRECTORY (on-demand, when agent enters directory)
  path/to/subdir/CLAUDE.md             N lines
    ↳ @AGENTS.md                        N lines (included)
  ...

TOTAL: N lines across M files (N direct + N included)
```

IF the manifest contains `unresolved_references` or `circular_references`, THEN add after the loading sequence:

```
UNRESOLVED @-REFERENCES:
  CLAUDE.md:5 → @AGENTS.md — file not found
  ...

CIRCULAR @-REFERENCES:
  AGENTS.md — circular reference
  ...
```

IF no includes exist, THEN omit the `↳` lines and the `(N direct + N included)` suffixes. The output is identical to a repo with no @-references.

### Section 2: Concept Saturation Tracker

Table showing every concept that appears in 2+ files. One row per concept, one column per file, cells show count of statements conveying that concept. Bold the first occurrence (the "owner").

| Concept | Root | rules/a.md | rules/b.md | subdir/CLAUDE.md | ... | Total |
|---------|:----:|:----------:|:----------:|:----------------:|:---:|:-----:|

### Section 3: Per-File Redundancy Breakdown

For each file (in loading order), break down by section:

**File: `path/to/file.md` (N lines)**

| Section | Lines | New | Redundant | Redundancy Type | Redundant With |
|---------|:-----:|:---:|:---------:|-----------------|----------------|

Bottom line: "X of Y content lines are redundant (Z%). Unique value: [summary of what only this file provides]"

### Section 4: Cumulative Redundancy by Loading Phase

Show how redundancy accumulates as the agent loads more files:

| After loading... | Total lines in context | Redundant lines added | Cumulative redundant | % of total context |
|---|:-:|:-:|:-:|:-:|

### Section 5: Structural Hotspots

The 3-5 worst redundancy chains — concepts restated across the most files. For each, show the full chain:

```
"[concept name]" — stated N times across M files:
  1st: path/file.md:LINE  (owner — original statement)
  2nd: path/file.md:LINE  (exact/paraphrased/subset)
  3rd: path/file.md:LINE  (exact/paraphrased/subset)
  ...
```

### Section 6: Unique Value Per File

For each file, after stripping all redundancy, what remains that NO other file provides? This answers: "if we deduplicated perfectly, what would each file contain?"

| File | Unique Contributions |
|------|---------------------|

## Accuracy Principles

These principles separate a thorough audit from a superficial one:

| # | Principle | Why It Matters | How to Apply |
|---|-----------|---------------|-------------|
| 1 | Paraphrasing detection matters most | Exact-match duplication is obvious. The hard cases are when the same constraint is worded differently — "Services accept domain models only" vs "Never pass Pydantic schemas to services" vs "API schemas never enter the service layer." All three say the same thing. | IF two statements from different files constrain the same behavior, THEN they are redundant regardless of wording. Catch all phrasings. |
| 2 | Loading order determines ownership | The first file to state a concept OWNS it. All later restatements are the redundant copies, regardless of which file states it "better." | Root CLAUDE.md is never redundant — it is always loaded first. Attribute redundancy to the LATER file, not the earlier one. |
| 3 | Self-duplication counts | A file that states the same rule in its safety anchors AND its "Never" table AND its process rules is internally redundant — the agent absorbs 3 copies from a single file. | Check WITHIN each file, not just across files. |
| 4 | Tables are dense | A single table row is one concept. A 5-row table restated across 3 files is 10 redundant lines, not 1. | Count table rows individually when computing redundancy, not whole tables as single units. |
| 5 | Meta-files duplicate heavily | Files that describe "how to load context" often restate the same source priority list that root CLAUDE.md already provides. | IF a file's purpose is to describe context loading, THEN check it against root's context loading section with extra scrutiny. |
| 6 | Same-file section duplication is hardest to catch | A file with a "Progressive Context Acquisition" table AND a "Source-of-Truth Hierarchy" table may list the same N items in similar order under two different headings. Different column metadata does not make the core ranking new. | Compare the ITEMS in ordered lists/tables across sections within the same file, not just the section titles. IF two sections list the same ranked items with different column metadata, THEN that is self-duplication. |
| 7 | Included files are separate entities | An @included file (e.g., AGENTS.md) is NOT part of the including file's content. It is a separate file that happens to load at the same phase. Merging it with the including CLAUDE.md produces wrong redundancy percentages for both files. | IF AGENTS.md is included by CLAUDE.md via @AGENTS.md, THEN AGENTS.md gets its own row in the saturation tracker, its own per-file breakdown, and its own entry in the cumulative table. Do NOT merge its content with CLAUDE.md. IF no @includes exist in the manifest, THEN this principle does not apply. |
