# Plan-{NNN}: {Title}

<!--
  Implementation Plan Template

  Purpose:
  - Defines how an approved spec will be implemented
  - Must be executable by an implementation agent without inventing missing behavior

  Preconditions:
  - The paired spec must already be approved
  - Required ADRs must already exist or be explicitly called out as blockers

  Writing rules:
  - Be concrete about files, modules, migrations, tests, and rollout order
  - Do not restate the entire spec; reference it and translate it into execution
-->

| Field               | Value                                                                     |
| ------------------- | ------------------------------------------------------------------------- |
| **Status**          | `draft` · `review` · `approved` · `completed`                             |
| **NNN**             | `{NNN}`                                                                   |
| **Slug**            | `{kebab-case-slug}`                                                       |
| **Date**            | `YYYY-MM-DD`                                                              |
| **Author(s)**       | `{name(s)}`                                                               |
| **Spec**            | `{link to specs/NNN-...}`                                                 |
| **Required ADRs**   | `{link(s)}`                                                               |
| **Dependencies**    | `{Plan-NNN (reason), or None}`                                            |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

{What this implementation phase will deliver.}

## Scope

{What this plan covers.}

## Non-Goals

- {What this plan intentionally excludes}

<!--
  Invariants section (required for plans with a listener-bind, process-spawn,
  schema-migration, or cross-plan-dep surface; omit otherwise).

  - Each invariant gets a stable I-NNN-N identifier (NNN = this plan's number)
    so other plans and this plan's PRs can cite it by name.
  - Each entry: short header sentence, why-load-bearing paragraph, and a
    Verification line naming the test or PR that proves it.
  - Invariants buried in narrative are review-invisible (the Plan-007 cyclic-dep
    defect class). Promote MUSTs out of prose into this section.
-->

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-NNN PRs and downstream extensions. Any change that would weaken or remove an invariant requires a coordinated cross-plan amendment (see [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md)).

### I-NNN-1 — {Short headline sentence}

{Statement of the invariant.}

**Why load-bearing.** {What breaks if this is violated, and which plans depend on it.}

**Verification.** {Test, PR, or migration check that proves the invariant holds.}

<!--
  Cross-Plan Obligations section (required when this plan declares an obligation
  on another plan, or inherits one from another plan; omit otherwise).

  - Bidirectional citation: if Plan-A obliges Plan-B, both plans MUST surface
    the obligation. Asymmetric forward-deps were the Plan-007 cyclic-dep
    defect class.
  - Each entry gets a stable CP-NNN-N identifier and follows the shape:
    one-sentence header, obligation paragraph, **Resolution.** paragraph naming
    where/when the consuming plan satisfies it. Optionally include a
    **Why surfaced here.** paragraph for non-obvious cases.
-->

## Cross-Plan Obligations

Plan-NNN declares the following obligations on adjacent plans (or inherits obligations declared by them). Implementation cannot proceed (or must defer specific surfaces) without these being satisfied or explicitly staged.

### CP-NNN-1 — {Short headline sentence}

{Statement of the obligation, citing the source plan + section anchor.}

**Resolution.** {Where and when the consuming plan satisfies it; cite the PR or step.}

## Preconditions

- [ ] Paired spec is approved
- [x] Required ADRs are accepted
- [ ] Blocking open questions are resolved or explicitly deferred
- [ ] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)**

<!-- Cite durable forms per AGENTS.md §Durable-Cite Rule: `path#exportedSymbol` for code,
     `Spec-NNN §Heading` for specs/plans/ADRs; raw :NNN only for frozen/archive content. -->

## Target Areas

- {Target service/module/file area}
- {Target service/module/file area}

## Data And Storage Changes

- {Schema or persistence change}

## API And Transport Changes

- {IPC, HTTP, WebSocket, event, or protocol change}

## Implementation Steps

1. {Step}
2. {Step}
3. {Step}

## Parallelization Notes

- {What can run in parallel}
- {What must remain sequential}

## Test And Verification Plan

- {Unit tests}
- {Integration tests}
- {Manual verification}
<!--
  The two bullets below were added 2026-05-22 (BL-127) and apply to plans
  authored after this template revision. Existing Plans 001-027 are not
  retroactively required to amend their § Test And Verification Plan.
-->
- {Adversarial-Tampering Boundary — enumerate per-substrate threat classes the verification suite exercises: canonicalization round-trip; intake validation parity with library-level asserts; mutation-isolation symmetry (clone-in / clone-out); empty-segment / trailing-separator rejection at every parser boundary. Anchored example: [Plan-025 §Decision Log](./025-self-hostable-node-relay.md#decision-log) — 8 Codex findings across 3 review passes on PR #92.}
- {CI-Pinned Tool Versions — verification commands name CI-pinned tool versions explicitly (e.g., `gitleaks v8.30.1` per [ADR-023 §Axis 4](../decisions/023-v1-ci-cd-and-release-automation.md)) so local-version drift surfaces at plan-authoring time, not at PR push.}

<!--
  Implementation Phase Sequence section (recommended for plans of ≥3 PRs;
  mandatory for any Tier 1 plan; omit only for single-PR plans).

  - Each PR carries an explicit **Precondition:** line so the merge order
    is reviewer-checkable and so cross-plan obligations have an enforceable
    merge gate (the Plan-024 §Implementation Phase Sequence shape).
  - Each PR cites which §Invariants and §Cross-Plan Obligations entries it
    satisfies. This is what turns a structural promotion into an enforceable
    merge gate (per Plan-001 / Plan-007 / Plan-024 precedent).
-->

## Implementation Phase Sequence

Plan-NNN implementation lands as a sequence of small PRs. Each PR exercises one slice of the plan's vertical and carries a `**Precondition:**` line so the merge order is reviewer-checkable.

### Phase 1 — {Short PR title}

**Precondition:** {What must be merged or accepted before this PR can start.}

<!--
  Machine-readable preconditions (consumed by plan-execution preflight tool).
  Supported types: pr_merged, adr_accepted, plan_phase, cross_plan_carve_out,
  audit_status. Required for plans authored from 2026-04-30 onward; legacy
  plans use prose fallback parsing of the `**Precondition:**` line above.

  Prose-parseable forms (case-insensitive, regex-matched on the single
  `**Precondition:**` line):
    - `PR #N merged`            → {type: pr_merged, ref: N}
    - `ADR-NNN accepted`        → {type: adr_accepted, ref: NNN}
    - `Plan-NNN Phase K merged` → {type: plan_phase, plan: NNN, phase: K, ...}
    - `Phase K merged` (bare)   → {type: plan_phase, plan: <local plan>, phase: K, ...}
      The bare form resolves to the plan the precondition lives in
      (convention across Plan-001/003/007/024). A negative lookbehind in
      the regex prevents double-counting the bare-form segment inside an
      already-matched `Plan-NNN Phase K merged`.

  YAML-only (no prose analog — declare in the block below):
    - cross_plan_carve_out
    - audit_status: complete | substrate_exempt
    - Any dependency whose prose form interpolates link-text or other
      tokens between `Phase K` and `merged` (e.g.,
      `[Plan-NNN Tier K Partial](...) merged`,
      `Plan-001 Phase 5 CP-001-2 cwd-translator merged`) — neither the
      explicit-prefix nor bare-form regex matches these shapes, so the
      dependency drops to "unparseable prose; legacy free-form silent
      pass" and is NOT machine-enforced. Express it as a YAML
      `cross_plan_carve_out` + `pr_merged` pair so the gate enforces.
-->

```yaml
preconditions:
  - { type: pr_merged, ref: 19 }
  - { type: adr_accepted, ref: 23 }
  - { type: plan_phase, plan: 1, phase: 5, status: merged }
```

For plans that ship across tiers via the substrate-vs-namespace decomposition pattern (Plan-007 / Plan-008 / Plan-023 carve-outs), use the `audit_status` precondition type. Two values are permitted (see [audit runbook §Per-Phase Audit Semantics](../operations/plan-implementation-readiness-audit-runbook.md)). The YAML examples below are wrapped in `<!-- prettier-ignore -->` so each list item stays on a single line — `parsePreconditionsBlock` parses flow-form entries one line at a time, so a Prettier-wrapped multi-line `{ ... }` mapping silently fails to parse.

<!-- prettier-ignore -->
```yaml
# Phase already covered by the tier audit at its tier's place in the build order
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 15, baseline_tag: "plan-readiness-audit-tier-1" }
```

<!-- prettier-ignore -->
```yaml
# Phase is a substrate slice of a §5 carve-out; ships before its tier-level audit
preconditions:
  - { type: cross_plan_carve_out, ref: "Plan-NNN Substrate-vs-Namespace Carve-Out" }
  - { type: audit_status, status: substrate_exempt, carve_out_ref: "Plan-NNN Substrate-vs-Namespace Carve-Out" }
```

**Goal:** {What tests go green; what behavior is delivered.}

- {Scope item}
- {Scope item}

## Rollout Order

1. {Rollout step}
2. {Rollout step}

## Rollback Or Fallback

- {Rollback or containment path}

## Risks And Blockers

- {Risk}
- {Blocker}

<!--
  Progress Log section (required for plans whose PRs ship through the
  /plan-execution Phase E housekeeper; omit for one-shot plans that ship
  outside that path).

  - The `### Shipment Manifest` subsection is machine-readable. The
    plan-execution orchestrator appends one entry per merged PR; the
    preflight tool reads this block to decide which phases / tasks are
    already shipped.
  - The `### Notes` subsection is per-PR human commentary (round-trips,
    learnings, partial-ship details). Append-only.
  - Schema authority for the manifest YAML lives in
    .claude/skills/plan-execution/scripts/lib/manifest.mjs — the snippet
    below is illustrative.
-->

## Progress Log

### Shipment Manifest

```yaml
manifest_schema_version: 1
shipped: []
# Entry shape (illustrative — authoritative schema in lib/manifest.mjs):
# - phase: 5
#   task: T5.1               # single string default; array allowed for legacy multi-task PRs
#   pr: 30
#   sha: 7e4ae47
#   merged_at: 2026-05-05
#   files:
#     - packages/client-sdk/src/sessionClient.ts
#   verifies_invariant: [I-NNN-1]      # mirrors audit Tasks-block field name
#   spec_coverage: [Spec-NNN row 4]    # mirrors audit Tasks-block field name
#   notes: |
#     Optional free-form context (round-trips, lane, learnings).
```

### Notes

<!-- Per-PR human-readable commentary appended by the orchestrator at Phase E. -->

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
