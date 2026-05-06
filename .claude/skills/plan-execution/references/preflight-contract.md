# Preflight Tool Contract

The orchestrator invokes this tool at Phase 0 of plan-execution. It is the authoritative source for all mechanical gates that block dispatch.

## Invocation

    node .claude/skills/plan-execution/scripts/preflight.mjs <plan-file> [phase]

When `phase` is omitted, the tool walks the plan's Implementation Phase Sequence and resolves to the first un-shipped phase whose preconditions all pass. When provided, it validates the specified phase explicitly (used when the user override-supplies a phase number).

The tool MUST be run from the repo root (it shells out to `gh pr list`, which uses the cwd's git remote).

## Exit codes

- `0` — all gates pass. `stdout` contains the resolved phase number on a single line (e.g., `4`).
- `1` — a gate failed. `stdout` contains a self-contained halt message the orchestrator surfaces verbatim (failure type, file paths, remediation hint). `stderr` empty.
- `2` — internal error (malformed plan markdown, malformed YAML preconditions, missing tool deps). `stderr` describes the error; `stdout` empty. Orchestrator escalates to user; not a normal halt.

## Gates

Each gate runs in order; halt on first failure. The tool MUST NOT proceed past a failed gate (no aggregated multi-gate output).

### Gate 1 — Project-locality

Reads `requires_files:` from the skill's own frontmatter (`.claude/skills/plan-execution/SKILL.md`). Asserts `fs.existsSync` for each entry, resolved against the repo root. Failure message names the missing files and tells the user this skill is shaped for the ai-sidekicks-style repo surface.

### Gate 2 — Audit-complete checkbox

Greps the plan body's `## Preconditions` section for the regex `^- \[x\] \*\*Plan-readiness audit complete`. Failure references the audit runbook path and the Status Promotion Gate concept.

### Gate 3 — Phase un-shipped

Runs `gh pr list --state merged --search "Plan-NNN in:title" --json title` and asserts that no merged PR with a code-type Conventional Commit prefix carries the selected phase's title or "Plan-NNN PR #N" / "Plan-NNN Phase N" form. When phase is auto-selected, the tool just skips already-shipped phases; this gate fires only on explicit-phase overrides for already-shipped phases.

**Code-type prefix filter.** Only `feat:`, `fix:`, `refactor:`, `perf:` (with optional scope `(...)` and breaking-change `!`) count as a phase shipment. Doc / chore / test / build / ci / style PRs may reference a phase in their title without shipping it — for example, a `docs(repo): ...` governance amendment that rewrites the phase's Precondition section, or a `chore: ...` scaffolding tweak that mentions the phase title in passing. Without this filter, those PRs would false-match the `Plan-NNN.*Phase N` pattern and block dispatch on a phase that was never actually shipped.

**Why phase-walk, not title-count.** Plans with substrate/namespace or partial/remainder carve-outs ship phases non-contiguously across tiers. Plan-007 ships Phases 1-3 in Tier 1 (substrate partial carve-out) and Phases 4+ in Tier 4 (remainder). Counting merged `Plan-007 in:title` PRs after the third merge returns next M=4, which silently maps to Tier-4 work whose preconditions (Plan-001 + others) may not be met. The phase-walk gates each phase on its declared Precondition (Gate 5), so the auto-selected phase is always the lowest-numbered phase whose preconditions all pass — substrate-carved or otherwise.

### Gate 4 — Tasks-block G4 cites

Extracts the selected phase's section (between `### Phase N —` and the next `### Phase` header). Counts `Spec coverage` and `Verifies invariant` substring matches. Each must be ≥ 1. Failure means the audit's G4 traceability gate did not produce content; user must re-run the audit.

### Gate 5 — Phase preconditions

Parses the phase's `preconditions:` YAML block (see plan template § Implementation Phase Sequence). For each entry:

- `{type: pr_merged, ref: <N>}` → `gh pr view <N> --json state` returns `MERGED`.
- `{type: adr_accepted, ref: <NNN>}` → `docs/decisions/<NNN>-*.md` Status field equals `accepted`.
- `{type: plan_phase, plan: <NNN>, phase: <N>, status: merged}` → that plan's `## Progress Log` contains an entry for the phase.
- `{type: cross_plan_carve_out, ref: <id>}` → entry exists in `docs/architecture/cross-plan-dependencies.md` §5; tool only verifies presence, not semantic correctness.

If the phase has no `preconditions:` YAML block (legacy plan), fall back to regex parsing of the prose `**Precondition:**` line using the same pattern set ("PR #X merged", "ADR-NNN accepted", "Plan-MMM Phase K merged"). Both schema and regex failures escalate to exit code 2 if the precondition is wholly unparseable.

## Stability

This tool is the single point of mechanical-gate truth. New gates land here, not in SKILL.md prose. The contract above is versioned by git history; no version stamp in the file.
