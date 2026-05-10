# Preflight Tool Contract

The orchestrator invokes this tool at Phase 0 of plan-execution. It is the authoritative source for all mechanical gates that block dispatch.

## Invocation

    node .claude/skills/plan-execution/scripts/preflight.mjs <plan-file> [phase]

When `phase` is omitted, the tool walks the plan's Implementation Phase Sequence and resolves to the first un-shipped phase whose preconditions all pass. When provided, it validates the specified phase explicitly (used when the user override-supplies a phase number).

The tool MUST be run from the repo root (Gate 5 `pr_merged` and `adr_accepted` resolvers shell out to `gh pr view` / read `docs/decisions/`, which expect the cwd's git remote and repo layout).

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

Reads the plan file in two passes:

1. **Declared tasks.** Extract the phase's `#### Tasks` block via `extractDeclaredTaskIds(phaseSection)`. Both audit-Tasks-block layouts are accepted: sub-header form (`##### T1.1 — title` — Plan-001 style) and bullet+bold inline form (`- **T-007p-1-1** (Files: …) — …` — Plan-007 partial style). Returns a sorted unique array of task ids.
2. **Shipped tasks for this phase.** Extract via `parseManifestBlock(planSource)` from `lib/manifest.mjs`, then `shippedTaskIdsForPhase(manifest, phaseNumber)` which collects entries where `entry.phase === phaseNumber`, flattens the `task` field across both string and array forms (legacy multi-task PRs predate NS-02), and returns a `Set`.

Halt if `declared ⊆ shipped` — every declared task for the phase appears in the manifest. NS-02 partial ships (e.g., Plan-001 Phase 5 Lane A T5.1 alone, with T5.5/T5.6 still declared and un-shipped) leave the gate open. Phases whose tasks block contains zero ids fall through to Gate 4 (the audit's G4 traceability gate catches missing Tasks-block content).

When phase is auto-selected, the tool just skips already-shipped phases; the explicit halt message fires only on explicit-phase overrides for already-shipped phases.

**Why manifest set-comparison, not gh search.** The pre-Commit-3 mechanism inferred shipment from PR title/body via `gh pr list --search "Plan-NNN in:title,body"` plus three regex matchers (`Plan-NNN PR #N`, `Plan-NNN Phase N`, phase-title substring) and a code-prefix filter. The history is documented in [BL-110](../../../../docs/backlog.md) and the Plan-001 cozy-crafting-hummingbird shipment-manifest refactor: PR-body conventions vary across plans (Plan-001 uses `Plan-NNN PR #N`, Plan-007 partial uses `T-NNNp-N-N`, post-NS-02 uses task ids in titles), every regex pattern bought one false-match class while introducing another, and the 1000-PR fetch ceiling forced a sentinel halt. The structured manifest moves shipment state out of free-form prose and into a `### Shipment Manifest` YAML block per plan; Gate 3 becomes a set-comparison against an explicit data structure. Less code (~30 lines vs ~145), no network call, no fetch ceiling, and the partial-ship class (NS-02 lane carve-outs) falls out of the set-comparison naturally rather than requiring an asymmetric-pattern-reach hack.

**Schema-version forward compat.** `parseManifestBlock` returns `{ ok: true, version, shipped }` for any version >= 1. Gate 3 treats unknown future versions (`manifest.version > MANIFEST_SCHEMA_VERSION`) as opaque — fail open, do not block dispatch on a partial migration. The policy lives in `lib/manifest.mjs`'s header.

**Why phase-walk, not title-count.** Plans with substrate/namespace or partial/remainder carve-outs ship phases non-contiguously across tiers. Plan-007 ships Phases 1-3 in Tier 1 (substrate partial carve-out) and Phases 4+ in Tier 4 (remainder). Counting merged `Plan-007` PRs after the third merge returns next M=4, which silently maps to Tier-4 work whose preconditions (Plan-001 + others) may not be met. The phase-walk gates each phase on its declared Precondition (Gate 5), so the auto-selected phase is always the lowest-numbered phase whose preconditions all pass — substrate-carved or otherwise.

### Gate 4 — Tasks-block G4 cites

Extracts the selected phase's section (between `### Phase N —` and the next `### Phase` header). Counts `Spec coverage` and `Verifies invariant` substring matches. Each must be ≥ 1. Failure means the audit's G4 traceability gate did not produce content; user must re-run the audit.

### Gate 5 — Phase preconditions

Parses the phase's `preconditions:` YAML block (see plan template § Implementation Phase Sequence). For each entry:

- `{type: pr_merged, ref: <N>}` → `gh pr view <N> --json state` returns `MERGED`.
- `{type: adr_accepted, ref: <NNN>}` → `docs/decisions/<NNN>-*.md` Status field equals `accepted`.
- `{type: plan_phase, plan: <NNN>, phase: <N>, status: merged}` → that plan's `### Shipment Manifest` block contains an entry whose `phase` field matches `<N>`. (Pre-Commit-6 the resolver matched on `## Progress Log` prose for `Phase N` or `PR #N` substrings; the new mechanism reads the structured manifest the same way Gate 3 does.)
- `{type: cross_plan_carve_out, ref: <id>}` → entry exists in `docs/architecture/cross-plan-dependencies.md` §5; tool only verifies presence, not semantic correctness.

If the phase has no `preconditions:` YAML block (legacy plan), fall back to regex parsing of the prose `**Precondition:**` line using the same pattern set ("PR #X merged", "ADR-NNN accepted", "Plan-MMM Phase K merged"). Both schema and regex failures escalate to exit code 2 if the precondition is wholly unparseable.

## Stability

This tool is the single point of mechanical-gate truth. New gates land here, not in SKILL.md prose. The contract above is versioned by git history; no version stamp in the file.
