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

## Model Policy

Model selection resolves through a cascade; each layer stays silent unless it expresses a deliberate deviation:

1. **Explicit override** — a `model:` parameter on a single dispatch, or a user directive for the session. Reserved for deliberate deviations.
2. **Agent definition** — `.claude/agents/*.md` declare `model: inherit`.
3. **Session model** — whatever the user selected for the running session.
4. **Harness default** — the vendor-curated frontier model, which updates automatically as new models ship.

In practice:

- **Omit `model` on dispatch.** Subagents inherit the session model for every role (research, audit, implementation, review). Pass `model:` only to deliberately deviate, and record why.
- **Default working model: the latest Opus at 1M context** (Opus 4.8 today) — the project's standing choice for substantive work. This names the _line_, never a pinned _version_: "the latest Opus" tracks each release (4.7 → 4.8 → …) and never rots, so it refines the no-model-by-name rule below (which bars a frozen `Opus 4.8` as a hard requirement) instead of contradicting it. It is a default, not a gate — an explicit `model:` override still wins for a deliberate per-role deviation (e.g., a cheaper tier for codebase search or other mechanical work).
- **No committed file may require a model by name.** Where calibrated work needs a quality floor, express it as a tier class ("refuse if you identify as a small/fast-tier model"), never as a name — a name freezes the then-current frontier and rots at the next model ship.
- **Attribution strings** (`Co-Authored-By:` trailers) derive from the running model's harness-provided identity. Dated examples are fine; hardcoded requirements are not.

Historical records (ADR decision logs, plan author rows, archived session narratives) keep the model names they were written with — they record provenance, not policy. Likewise, a separate tool's own root config (e.g. `.codex/config.toml`) may pin an operational model directly — there the `model` field is an optional override, so naming one is a deliberate per-tool choice, not one of this project's calibrated-work quality floors. Such operational tool config sits outside this rule's scope.

## Doc-First Discipline

Code execution is gated on the governing doc surface (specs, ADRs, plans, backlog items) being complete. Before a code-execution plan ships its first PR, every cross-referenced spec, ADR, and plan must have completed the status promotion its type's status lifecycle requires, and every blocking backlog item must be `completed` (or explicitly deferred with a named gate).

This discipline binds plan-task shipment: the plan's first PR as above, and every PR that ships or modifies manifest-tracked tasks. Post-completion enhancements to shipped code (changes within the approved spec envelope) and repo tooling/infra work take the lighter lanes defined in `CONTRIBUTING.md` §How Code Lands: Work Classification. A change that would alter a plan invariant or a spec Required Behavior / Acceptance Criteria row is not an enhancement — the spec or plan amends first.

The full doc-first ordering for V1 lives in `docs/architecture/cross-plan-dependencies.md` (tier graph) and the per-plan Preconditions sections.
