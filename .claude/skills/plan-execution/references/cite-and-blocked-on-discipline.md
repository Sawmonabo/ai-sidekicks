# Cite-and-Blocked-On Discipline

Reference for plan-execution subagents (implementer, contract-author, spec-reviewer, code-reviewer, code-quality-reviewer). Load on demand when a task's `spec_coverage`, `verifies_invariant`, or `blocked_on` fields are non-empty.

The disciplines below come from two governance sources:

- The plan-readiness audit runbook ([`docs/operations/plan-implementation-readiness-audit-runbook.md`](../../../../docs/operations/plan-implementation-readiness-audit-runbook.md)) — specifically the G4 traceability gate that emits cite fields.
- The cross-plan dependency map ([`docs/architecture/cross-plan-dependencies.md`](../../../../docs/architecture/cross-plan-dependencies.md)) §5, which defines carve-out semantics for `BLOCKED-ON-C*` markers.

Subagent prompts cite this doc instead of inlining the full justification. When in doubt, read the cited source-of-truth doc.

## 1. Audit-cite testing discipline

The audit emits two cite fields alongside each `#### Tasks` row, which the plan-analyst maps 1:1 into DAG fields:

- `spec_coverage` — Spec-NNN rows the task implements.
- `verifies_invariant` — I-NNN-M plan invariants the task preserves.

These cites are the **authoritative coverage contract** for the task. Plan acceptance criteria (ACs) are operational checkpoints — what advances the task. Cites are the load-bearing test contract — what spec-review verifies per row. ACs are a subset; cites are the authoritative whole.

### Implementer / contract-author obligation

For each `spec_coverage` row, write at least one test that exercises that Spec-NNN row's behavior. Read the row to know what "exercises" means — assertions on observable behavior, not just import-resolution sanity.

For each `verifies_invariant` cite, write at least one test that asserts the invariant's load-bearing property. Read the I-NNN-M entry in the plan's `## Invariants` section to know what's load-bearing (invariants are stated with a "Why load-bearing" paragraph and a "Verification" line that names the test class).

### Shape-only artifacts (contract-author specifically)

Contracts encode _shape_ (TypeScript types, Zod schemas, SQL DDL) — not behavior. A behavioral cite like _"SessionCreate returns stable session id"_ cannot be exercised at the contract layer; downstream consumer tasks exercise it.

Contract-author exercises only **shape-checkable cites**: field types, enum exhaustiveness, required-vs-optional, type-narrowness, foreign-key constraints, NOT-NULL constraints. Flag behavioral cites in your report ("cite X is behavioral — exercised by downstream task T-N") but do NOT block on them.

### Spec-reviewer obligation

For each `spec_coverage` cite, verify the diff implements that Spec row's behavior. Under-implementation is ACTIONABLE. Cite the row in findings.

For each `verifies_invariant` cite, verify the diff preserves the invariant. A diff that satisfies ACs but violates the invariant is ACTIONABLE — invariants outrank ACs. Cite the I-NNN-M ID in findings.

### Why load-bearing

Under-tested cites surface as ACTIONABLE spec-review findings. The G4 gate exists specifically so spec-review has per-row evidence to verify; tests scoped only to ACs leave cites unverified, masking spec drift.

## 2. Blocked-on conservative-shape discipline

Tasks-block rows can carry `BLOCKED-ON-C*` markers. The plan-analyst maps these into the DAG's `blocked_on` field. They mean the named cross-cutting concern (C-N) is unresolved in another plan/PR and will resolve there per cross-plan-dependencies.md §5.

### Implementer / contract-author obligation on blocked-on surfaces

Use conservative inline shapes only:

- No new abstractions.
- No premature interfaces.
- No exported helper types.
- No shared symbols introduced specifically to deduplicate the blocked-on surface.

Inline duplication on these surfaces is intentional and load-bearing for boundary stability. The later PR resolving C-N may rework the boundary; abstraction here pre-commits the shape.

Contracts are especially exposed: a premature interface published in a contract pre-commits every downstream task that imports it. Prefer inline structural types or per-task local types until C-N resolves.

### Reviewer obligations

- **Spec-reviewer:** premature abstraction on blocked-on surfaces is ACTIONABLE — it's spec drift (pre-commits a shape the audit deliberately deferred).
- **Code-reviewer:** do NOT raise ACTIONABLE asking the implementer to factor blocked-on surfaces into helpers, abstractions, or shared types. Correctness findings (bugs, races, null-handling, security boundary violations) on blocked-on surfaces remain fully in your lane.
- **Code-quality-reviewer:** do NOT raise findings (even OBSERVATION) asking to extract / dedupe / rule-of-three blocked-on surfaces. The inline duplication is load-bearing. Quality findings on non-blocked surfaces remain in your lane.

### Why load-bearing

Cross-cutting concerns are deferred during carve-outs precisely because their final shape is contested across plans. Concretizing them here pre-commits a boundary the resolving plan may need to rework — costing that PR rework or forcing it to ship a shape that doesn't match its spec. The inline duplication is the carve-out's price.
