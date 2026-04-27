# AGENTS.md

Cross-tool conventions for AI coding agents working in this repository (Claude Code, Codex CLI, Cursor, Aider, etc.). Tool-specific behavior lives in per-tool instruction files; conventions that must hold _across_ tools live here.

## Per-Tool Instruction Files

- `CLAUDE.md` (Claude Code) — checked into git at the project root; team-shared instructions for the Claude Code CLI
- Per-tool instruction files for other agents follow the file's home convention (e.g. `.codex/`, `.cursor/`)

When tool-specific guidance conflicts with this file, this file wins for _cross-tool conventions_ (the items below). Per-tool files own everything else.

## Research-Artifact Convention

Subagents conducting research (current-state checks, primary-source verification, version surveys, API-shape investigations) MUST write findings to:

```text
.agents/tmp/research/<topic>/<axis>.md
```

- `<topic>` — the consuming ADR / spec / plan / backlog item the research informs (e.g. `adr-023-ci-cd`, `bl-097-workflow-engine`)
- `<axis>` — one file per parallel-fan-out subagent (each axis owns its own file to avoid Read-modify-write races on shared files when subagents run concurrently)

`.agents/tmp/research/` is **gitignored** at repo root. The location is provider-neutral, outside the docs corpus, and never committed.

### Surface-Forward-Then-Delete Pattern

Research artifacts are transient drafting locations, not authoritative state.

1. **Draft** — subagents write findings (citations + extracted claims) under `.agents/tmp/research/<topic>/<axis>.md`
2. **Surface forward** — the parent agent extracts citations into the consuming ADR/spec/plan References section per the doc-type's citation pattern:
   - **ADRs**: `### Research Conducted` table — `Source | Type | Key Finding | URL/Location`
   - **Specs**: inline citations in body prose + per-section `### References` blocks
   - **Plans**: flat `## References` list at end of file
   - **Architecture / schema docs**: inline citation pattern matching neighboring docs
3. **Delete** — the research file is deleted before the consuming-doc commit lands

### Why This Pattern

Tracked-but-transient research has empirically failed in this repo (two prior revisions). When research files persist, they accumulate inbound citations that split authoritative truth between the research file and the consuming doc. The 2026-04-25 audit found ~140+ inbound citations into `docs/research/` files that paralleled approved corpus docs.

The fix: research files live entirely outside the docs corpus (gitignored, provider-neutral location), and authority lives only in the consuming doc once citations are surfaced forward.

### Verification Before Deletion

Before deleting a research file, verify:

- (a) Zero inbound citations to `.agents/tmp/research/<file>` from anywhere in the docs corpus (trivially true by construction — gitignored top-level dirs cannot be linked from canonical docs)
- (b) Embed-log claims in the consuming doc match the actual subagent findings (anti-hallucination check — the extracted claim must be supported by the cited primary source the subagent surfaced)

## Citation Standard

Every non-trivial claim in a spec, ADR, plan, or architecture doc must cite a primary source — official documentation, upstream issue, original benchmark, RFC, vendor announcement, NIST/IETF/W3C publication.

A hostile reviewer should be able to follow every citation to a primary source that confirms the claim. If a citation cannot survive that test, tighten the wording or remove the claim.

When claims depend on recent data (post-knowledge-cutoff or fast-moving libraries), spawn the most capable model available as a research subagent and verify with `WebSearch` / `WebFetch` against current-year primary sources before recommendations land.

## Subagent Dispatch Convention

When dispatching parallel research subagents, ensure file targets are disjoint to avoid Read-modify-write race conditions on shared files (e.g., `docs/backlog.md`). When multiple tasks must touch the same file, dispatch serially.

## Plan Execution

Implementation plans (`docs/plans/NNN-*.md`) are executed PR-by-PR per [ADR-024](docs/decisions/024-agentic-plan-execution-methodology.md). The methodology principles transfer across tools; the executor is per-tool. The Claude Code executable form is [`.claude/skills/plan-execution/`](.claude/skills/plan-execution/SKILL.md); other agents (Codex, Cursor, Aider) implement the same loop with their own tooling.

## Doc-First Discipline

Code execution is gated on the governing doc surface (specs, ADRs, plans, backlog items) being complete. Before a code-execution plan ships its first PR, every cross-referenced spec/ADR/plan must be `approved` and every blocking backlog item must be `completed` (or explicitly deferred with a named gate).

The full doc-first ordering for V1 lives in `docs/architecture/cross-plan-dependencies.md` (tier graph) and the per-plan Preconditions sections.
