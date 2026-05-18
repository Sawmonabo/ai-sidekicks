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

### Gate 2 — Audit-complete checkbox (top-level lenient + per-phase strict)

Two-layer gate. The top-level `gateAuditCheckbox(planSource, planFile)` runs once before phase resolution and passes when EITHER (a) the plan body has the ticked `^- \[x\] \*\*Plan-readiness audit complete` row OR (b) any phase in the plan declares a `type: audit_status` precondition entry (the substrate-vs-namespace carve-out path). The strict per-phase enforcement runs inside `_checkPhase` via `gatePhaseAuditCheckbox(planSource, phaseSection, planFile, phaseNumber)`, which requires the resolved target phase specifically to carry either the plan-level checkbox OR its own `type: audit_status` declaration.

The two-layer split exists because plans like Plan-023 ship Tier 1 phases under substrate carve-outs while Tier 8 remainder phases haven't been authored. A purely plan-scoped check would force every yet-to-be-authored phase to carry the YAML up-front; a purely lenient check would let those un-authored phases dispatch through the carve-out path. The lenient top-level + strict per-phase combination is what admits Plan-023 Phase 1 today without preauthorizing future Phase 2+ dispatches.

Failure references the audit runbook path, the Status Promotion Gate concept, and the runbook §Per-Phase Audit Semantics section.

### Gate 3 — Phase un-shipped

Reads the plan file in two passes:

1. **Declared tasks.** Extract the phase's `#### Tasks` block via `extractDeclaredTaskIds(phaseSection)`. Both audit-Tasks-block layouts are accepted: sub-header form (`##### T1.1 — title` — Plan-001 style) and bullet+bold inline form (`- **T-007p-1-1** (Files: …) — …` — Plan-007 partial style). Returns a sorted unique array of task ids.
2. **Shipped tasks for this phase.** Extract via `parseManifestBlock(planSource)` from `lib/manifest.mjs`, then `shippedTaskIdsForPhase(manifest, phaseNumber)` which collects entries where `entry.phase === phaseNumber`, flattens the `task` field across both string and array forms (legacy multi-task PRs predate NS-02), and returns a `Set`.

Halt if `declared ⊆ shipped` — every declared task for the phase appears in the manifest. NS-02 partial ships (e.g., Plan-001 Phase 5 Lane A T5.1 alone, with T5.5/T5.6 still declared and un-shipped) leave the gate open. Phases whose tasks block contains zero ids fall through to Gate 4 (the audit's G4 traceability gate catches missing Tasks-block content).

When phase is auto-selected, the tool just skips already-shipped phases; the explicit halt message fires only on explicit-phase overrides for already-shipped phases.

**Why manifest set-comparison, not gh search.** The pre-Commit-3 mechanism inferred shipment from PR title/body via `gh pr list --search "Plan-NNN in:title,body"` plus three regex matchers (`Plan-NNN PR #N`, `Plan-NNN Phase N`, phase-title substring) and a code-prefix filter. The history is documented in [BL-110](../../../../docs/backlog.md) and the Plan-001 cozy-crafting-hummingbird shipment-manifest refactor: PR-body conventions vary across plans (Plan-001 uses `Plan-NNN PR #N`, Plan-007 partial uses `T-NNNp-N-N`, post-NS-02 uses task ids in titles), every regex pattern bought one false-match class while introducing another, and the 1000-PR fetch ceiling forced a sentinel halt. The structured manifest moves shipment state out of free-form prose and into a `### Shipment Manifest` YAML block per plan; Gate 3 becomes a set-comparison against an explicit data structure. Less code (~30 lines vs ~145), no network call, no fetch ceiling, and the partial-ship class (NS-02 lane carve-outs) falls out of the set-comparison naturally rather than requiring an asymmetric-pattern-reach hack.

**Strict halt on parse failure.** Gate 3 halts (exit 1) when `parseManifestBlock` returns `!ok` — including the `no_section` case (no `### Shipment Manifest` heading), `no_yaml_fence` (heading exists but the ```yaml fenced block is missing or truncated), `missing_schema_version`(fence parsed but the top-level`manifest_schema_version`key is absent), and`missing_shipped`(schema-version present but the`shipped:`top-level key is absent — plan author must add`shipped: []`for an empty manifest or list entries under it). Pre-round-7 the gate fail-opened on parse failure; in auto-walk mode this could re-dispatch already-shipped phases after any manifest formatting error (Codex P1 finding on PR #35 round 7). The`missing_shipped`case was added in round 10: pre-round-10 the parser returned`{ ok: true, version, shipped: [] }`when only the version line was present, which silently zeroed out the shipped-tasks set and re-opened Gate 3 for already-shipped phases (Codex P1 finding on PR #35 round 10). Plans created before Commit 1's template change must add the`### Shipment Manifest`section per`docs/plans/000-plan-template.md` before preflight resolves them.

**Strict halt on entry-schema failure.** Even when the YAML structure parses, every `shipped[]` entry runs through `validateEntry` from `lib/manifest.mjs`. Type or shape errors (e.g. `phase: "5"` as a string instead of an integer, missing `task`, unknown field names) trigger the `manifest_invalid_entries` classifier kind and halt with a per-entry error list. Pre-round-8 the classifier read entry fields directly without schema validation, so type-mismatched entries silently produced an incomplete shipped-tasks set and re-opened Gate 3 for already-shipped phases (Codex P2 finding on PR #35 round 8).

**Auto-walk surfaces strict halts.** `_checkPhase` propagates the classifier kind on every Gate 3 failure (`reason: ship.kind`), and the auto-walk loop in `runPreflight` only silent-skips `reason: "fully_shipped"`. Both `manifest_unparseable` and `manifest_invalid_entries` short-circuit the loop with `{ exit: 1, stdout: r.halt }`, so the strict halts above fire in auto-walk mode the same way they fire in explicit-phase mode. Pre-round-9 `_checkPhase` collapsed every failure to `reason: "shipped"`, so the loop silenced manifest corruption and emitted "no eligible un-shipped phase" with the halt buried in the per-phase `skipped[]` text (Codex P1 finding on PR #35 round 9). The explicit allow-list — not a default — guarantees future strict-halt classifications also surface unless they are explicitly added as silent-skip.

**Schema-version forward compat (only intentional fail-open).** `parseManifestBlock` returns `{ ok: true, version, shipped }` for any version >= 1. Gate 3 treats unknown future versions (`manifest.version > MANIFEST_SCHEMA_VERSION`) as opaque — fail open, do not block dispatch on a partial migration. The policy lives in `lib/manifest.mjs`'s header. This is the only case where Gate 3 silently passes; every other parse outcome (failure or full-shipped) halts loudly.

**Why phase-walk, not title-count.** Plans with substrate/namespace or partial/remainder carve-outs ship phases non-contiguously across tiers. Plan-007 ships Phases 1-3 in Tier 1 (substrate partial carve-out) and Phases 4+ in Tier 4 (remainder). Counting merged `Plan-007` PRs after the third merge returns next M=4, which silently maps to Tier-4 work whose preconditions (Plan-001 + others) may not be met. The phase-walk gates each phase on its declared Precondition (Gate 5), so the auto-selected phase is always the lowest-numbered phase whose preconditions all pass — substrate-carved or otherwise.

### Gate 4 — Tasks-block G4 cites

Extracts the selected phase's section (between `### Phase N —` and the next `### Phase` header). Counts `Spec coverage` and `Verifies invariant` substring matches. Each must be ≥ 1. Failure means the audit's G4 traceability gate did not produce content; user must re-run the audit.

### Gate 5 — Phase preconditions

Parses the phase's `preconditions:` YAML block (see plan template § Implementation Phase Sequence). For each entry:

- `{type: pr_merged, ref: <N>}` → `gh pr view <N> --json state` returns `MERGED`.
- `{type: adr_accepted, ref: <NNN>}` → `docs/decisions/<NNN>-*.md` Status field equals `accepted`.
- `{type: plan_phase, plan: <NNN>, phase: <N>, status: merged}` → that plan's `### Shipment Manifest` block fully ships every declared task for Phase `<N>` (declared ⊆ shipped, the same set-comparison Gate 3 runs on the local plan). Pre-round-7 the resolver matched any phase entry (`some(e.phase === entry.phase)`); after manifest entries became task-level under NS-02, that became a partial-ship false-positive — Plan-001's T5.1 entry would unblock a downstream Plan-001 Phase 5 dependency even though T5.5/T5.6 were unshipped (Codex P2 finding on PR #35 round 7). Halt outcomes: `partially_shipped` (lists missing tasks), `manifest_unparseable` (mirrors Gate 3's strict halt on parse failure), `no_phase_section` (upstream plan lacks the requested phase). Fail-open outcomes: `fully_shipped` (precondition satisfied), `manifest_future_schema` (mirrors Gate 3's schema-version-future fail-open), `no_declared_tasks` with a phase-presence match (legacy fallback for plans whose `#### Tasks` block lacks task ids — phase-presence in the manifest is treated as evidence of completion). (Pre-Commit-6 the resolver matched on `## Progress Log` prose for `Phase N` or `PR #N` substrings; the new mechanism reads the structured manifest the same way Gate 3 does.)
- `{type: cross_plan_carve_out, ref: <id>}` → entry exists in `docs/architecture/cross-plan-dependencies.md` §5. The membership check is scoped to §5 only via the shared `extractSection5` helper — pre-fix it used `source.includes(ref)` over the whole file, which passed when the ref appeared in §3 prose or §6 NS-rows even when §5 had no entry. Tool only verifies §5 presence, not semantic correctness; the substantive shape check (substrate-vs-namespace structure) is covered by the `audit_status: substrate_exempt` criterion (3) below.
- `{type: audit_status, status: complete, evidence_pr: <PR#>, baseline_tag: <git tag>}` → the act of declaring `complete` is the load-bearing assertion (matches the existing Gate 2 behavior of trusting the human-set checkbox). `evidence_pr` + `baseline_tag` are documentary; preflight does not mechanically verify them — see runbook §Per-Phase Audit Semantics.
- `{type: audit_status, status: substrate_exempt, carve_out_ref: <§5-heading-text>}` → three criteria. (1)+(2) human-judged at audit time per Plan-007 §Execution Windows. (3) is mechanically verified: (a) `carve_out_ref` MUST appear inside §5 of cross-plan-dependencies.md via the shared `extractSection5` helper; (b) phase body MUST contain one of the canonical empty-coverage sentinels (`covers no Spec-NNN acceptance criteria`, `covers NO Spec-NNN AC`, `substrate is pre-behavior plumbing`); (c) the `#### Tasks` block MUST NOT cite Spec coverage in bracket-form (`Spec coverage: [Spec-NNN row M]`) — prose-form mentions are tolerated because they describe coverage absence. A phase that declares `substrate_exempt` ALSO causes Gate 4 (Tasks-block G4 cites) to be skipped — by criterion (3) the phase ships zero Spec AC, so Gate 4's "Spec coverage" substring requirement would halt it by design.

If the phase has no `preconditions:` YAML block (legacy plan), fall back to regex parsing of the prose `**Precondition:**` line using the same pattern set ("PR #X merged", "ADR-NNN accepted", "Plan-MMM Phase K merged"). The `audit_status` and `cross_plan_carve_out` types are YAML-only — they have no prose-line analog. Both schema and regex failures escalate to exit code 2 if the precondition is wholly unparseable.

## Stability

This tool is the single point of mechanical-gate truth. New gates land here, not in SKILL.md prose. The contract above is versioned by git history; no version stamp in the file.
