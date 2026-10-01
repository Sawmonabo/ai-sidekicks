# Plan-018: Observability And Failure Recovery

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `018` |
| **Slug** | `observability-and-failure-recovery` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-018: Observability And Failure Recovery](../specs/018-observability-and-failure-recovery.md) |
| **Required ADRs** | [ADR-003](../decisions/003-daemon-backed-queue-and-interventions.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-005](../decisions/005-provider-drivers-use-a-normalized-interface.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md) |
| **Dependencies** | [Plan-013](./013-persistence-recovery-and-replay.md) (persistence layer) |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |

## Goal

Implement the daemon's diagnostic signals: bounded retention on this machine for its diagnostic buckets. No client reads a `health.*` method; Settings › Runtime reads the service's status from `daemon.status.read`.

## Scope

This plan covers the diagnostic buckets `driver_raw_events`, `command_output` and `tool_traces` (their tables, TTL retention and summary construction), and `workflow_engine_events`, the file bucket the workflow engine's always-on event record writes to — nothing in any of them leaves the machine. The retry rules of [Spec-018 §Required Behavior](../specs/018-observability-and-failure-recovery.md#required-behavior) are built where their mechanisms live: the Codex service restart bound with the Codex service's lifecycle, the pane-read retry with the pane reads.

## Non-Goals

- External dashboard or vendor-tool rollout
- Full incident-management workflow
- Business analytics

## Preconditions

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/runtime-daemon/src/observability/diagnostic-redaction-policy.ts` (PII redaction gate on every diagnostic bucket)
- `packages/runtime-daemon/src/observability/diagnostic-buckets/` (TTL-bucket implementations for `driver_raw_events`, `command_output`, `tool_traces` and `workflow_engine_events`)

## PII in Diagnostics

Plan-018 is the implementation surface for [Spec-018 §PII in Diagnostics](../specs/018-observability-and-failure-recovery.md#pii-in-diagnostics) and must honor the [Spec-020 §PII Data Map](../specs/020-data-retention-and-gdpr.md#pii-data-map) classification of diagnostic data. The bounded-retention diagnostic buckets — `driver_raw_events`, `command_output`, `tool_traces` and `workflow_engine_events` — are runtime-local stores that may transit raw user content and therefore require TTL-bounded local retention and never leave the machine.

- Default TTL: ≤ 7 days per [Spec-018 §PII in Diagnostics](../specs/018-observability-and-failure-recovery.md#pii-in-diagnostics). `Keep diagnostic logs for` sets it and takes any period.
- Nothing leaves the machine: the daemon runs no telemetry exporter and sends no diagnostic bucket content to any sink. A compacted summary carries only signals derived by construction from non-PII inputs (counts, categories, latencies).
- Bound and erase: each bucket drops its rows past `Keep diagnostic logs for` ([Spec-020 §Erasure Paths](../specs/020-data-retention-and-gdpr.md#erasure-paths) Path 3), and `Erase all data` deletes them with the data folder. There is no per-person flush.

**Redaction-decision locality (no wire contract).** The redaction _decision logic_ — which fields a compacted summary keeps and which it drops — is daemon-local code in `diagnostic-redaction-policy.ts`. It is deliberately **not** published as a typed payload in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md), because no cross-package consumer evaluates redaction: the daemon is the only principal that sees diagnostic content, and none of it leaves the machine. The policy _state_ does not cross a contract boundary either. The retention period is the `Keep diagnostic logs for` setting on Settings › Runtime, carried by the daemon's configuration reads and writes ([Plan-006 §Phase R1 — Namespace Handlers](./006-local-ipc-and-daemon-control.md#phase-r1--namespace-handlers)). A consumer that needs to _evaluate_ redaction or _read_ policy state reads a typed contract published for it; otherwise changing a redaction rule is a code change with no cross-plan contract ripple.

## Data And Storage Changes

- Add the diagnostic-bucket tables (`driver_raw_events`, `command_output`, `tool_traces`) to Local Runtime Daemon SQLite with TTL-purge indices per [Local SQLite Schema §Diagnostic Bucket Tables](../architecture/schemas/local-sqlite-schema.md#diagnostic-bucket-tables-plan-018). These are runtime-local; they have no shared-Postgres counterpart per [ADR-017](../decisions/017-shared-event-sourcing-scope.md).
- Add bounded-retention handling for raw diagnostic payload classes so compaction never removes the failure detail a run event carries.
- Diagnostic bucket column definitions live in the Local SQLite schema because raw diagnostics never leave the machine. This plan adds no shared-Postgres table.

## API And Transport Changes

- No `health.*` read is added for any client, and no `health.*` method string is registered. Settings › Runtime's service status comes from the supervisor through `daemon.status.read` ([Plan-006 §Phase R1 — Namespace Handlers](./006-local-ipc-and-daemon-control.md#phase-r1--namespace-handlers)).
- The diagnostic redaction policy is daemon-local state, not a contract: the TTL from `Keep diagnostic logs for`. The default TTL is ≤ 7 days.

## Invariants

Load-bearing constraints every Plan-018 PR — and every downstream extension — must preserve. Each entry names the governing clause it grounds in, or declares itself plan-owned.

- **I-018-3 — Diagnostic-bucket retention is TTL-bounded by `Keep diagnostic logs for`, ≤ 7 days by default.** All the buckets (`driver_raw_events`, `command_output`, `tool_traces`, `workflow_engine_events`) drop their rows past `Keep diagnostic logs for`, ≤ 7 days by default; the person may set any period. **Grounds in.** [Spec-018 §PII in Diagnostics](../specs/018-observability-and-failure-recovery.md#pii-in-diagnostics) ("Bounded local retention"), with the storage side owned by [Spec-020 §PII Data Map](../specs/020-data-retention-and-gdpr.md#pii-data-map)'s bounded-retention tier. **Why load-bearing.** The buckets capture full prompts, full command arguments, and full tool results by the nature of their purpose; without the bound, content the person deleted from a session would persist indefinitely beside it in the diagnostics. **Verification.** T2.7, T2.9.
- **I-018-4 — Diagnostics never leave the machine, and a compacted summary carries no free text.** The daemon runs no telemetry exporter and sends no diagnostic-bucket row to any sink. Where high-volume tool traces are compacted, the summary is built from counts, categories and durations, never truncated from free text. **Grounds in.** [Spec-018 §PII in Diagnostics](../specs/018-observability-and-failure-recovery.md#pii-in-diagnostics) ("Nothing leaves the machine", "Summary-only retention"). **Why load-bearing.** A summary cut from a prompt keeps part of the prompt past the TTL that bounds the raw row, and truncated personal data is still personal data. **Verification.** T2.8.

## Cross-Plan Obligations

Each entry is an obligation shared with the plan it names. See Cross-Plan Dependency Graph for the graph-level view.

### CP-018-2 — The diagnostic buckets are bounded by `Keep diagnostic logs for` (⇄ Plan-020 CP-020-7)

**Obligation.** Plan-018's diagnostic buckets drop their rows past `Keep diagnostic logs for` on the service's one scheduler ([Plan-006 §Phase R1 — Namespace Handlers](./006-local-ipc-and-daemon-control.md#phase-r1--namespace-handlers)); `Erase all data` deletes them with the data folder. There is no per-person flush.

**Resolution.** Plan-018's half is I-018-3, implemented by T2.7. Plan-020 places the bound in its retention tiers as Path 3. A new diagnostic bucket added by either side joins the same bound.

### CP-018-3 — The workflow engine's diagnostic bucket (⇄ Plan-015 CP-015-9)

**Obligation.** Plan-018 creates `workflow_engine_events`, the bucket the always-on engine event record of [Spec-015 §Engine event record (SA-43)](../specs/015-workflow-authoring-and-execution.md#engine-event-record-sa-43) lands on, with its TTL and its Path-3 membership; Plan-015 writes records into it and authors none of that.

**Resolution.** T2.9 builds the bucket; Plan-015 T5.13 is its writer and waits on it.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define the diagnostic redaction policy state, daemon-local.
2. Implement bounded-retention policy handling for raw diagnostics without weakening canonical diagnosis. Build compacted summaries from counts, categories and durations for every diagnostic bucket, with no exporter and no sink off the machine.

## Implementation Phase Sequence

Each phase builds one of the §Implementation Steps above: Phase 1 Step 1, Phase 2 Step 2. Phase 1 has no unsatisfied upstream code dependency; Phase 2 serializes behind it.

### Phase 1 — Diagnostic policy state

**Precondition:** none. Implementation Step 1; gates Phase 2, whose retention and summary code read this state.

#### Tasks

- **T1.3 — Diagnostic redaction policy state (daemon-local).**
  - **Files:** `packages/runtime-daemon/src/observability/diagnostic-redaction-policy.ts` (CREATE — the policy-state type and its resolution; T2.8 adds the summary builder to the same file)
  - The policy _state_ the retention and summary code reads: the TTL per bucket, resolved from the `Keep diagnostic logs for` setting in daemon configuration. The default TTL is ≤ 7 days. Neither the state nor the redaction _decision logic_ is a wire contract — see §PII in Diagnostics above.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/diagnostic-redaction-policy.test.ts` (CREATE) — the default TTL is ≤ 7 days; a configured TTL resolves per bucket; a configuration naming a bucket that does not exist is refused at load.
  - **Acceptance:** the retention and summary code read one resolved policy state, and no client can read or override it over the wire.
  - **Spec coverage:** Spec-018 §PII in Diagnostics
  - **Verifies invariant:** none (I-018-3 and I-018-4 are enforced by T2.7 and T2.8)
  - **Consumes:** the bucket names ← [Spec-020 §PII Data Map](../specs/020-data-retention-and-gdpr.md#pii-data-map) bounded-retention tier (doc contract); the `Keep diagnostic logs for` key ← daemon configuration ([Plan-006 §Phase R1 — Namespace Handlers](./006-local-ipc-and-daemon-control.md#phase-r1--namespace-handlers))

### Phase 2 — Diagnostic-bucket retention

**Precondition:** Phase 1 merged. Implementation Step 2.

#### Tasks

- **T2.1 — Diagnostic-bucket tables.**
  - **Files:** the daemon's one schema (EXTEND — the bucket tables), `docs/architecture/schemas/local-sqlite-schema.md` (EXTEND — doc mirror)
  - CREATE the bucket tables `driver_raw_events`, `command_output` and `tool_traces` with TTL-purge indices, matching the column definitions the Local SQLite schema already documents. Runtime-local only — no shared-Postgres counterpart, per ADR-017.
  - **Tests:** the schema's test (EXTEND) — every bucket table exists in the daemon's one schema; each carries a TTL index; no bucket table appears in the control plane's one schema.
  - **Acceptance:** the TTL purge is indexed rather than table-scanned on every bucket — the storage precondition I-018-3 needs.
  - **Spec coverage:** Spec-018 §State And Data Implications
  - **Verifies invariant:** none (schema task; I-018-3 is verified by T2.7)
  - **Consumes:** the daemon's one schema ← Plan-001 (shipped)

- **T2.7 — Diagnostic-bucket TTL retention.**
  - **Files:** `packages/runtime-daemon/src/observability/diagnostic-buckets/` (CREATE — one TTL-bucket implementation per bucket plus the shared purge driver)
  - Apply the TTL `Keep diagnostic logs for` sets, ≤ 7 days by default and any period the person chooses, to every bucket. Compaction of raw diagnostics never removes the failure detail a run event carries.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/diagnostic-buckets.test.ts` (CREATE) — each bucket expires rows at or before the configured TTL; compaction leaves the run event's failure detail intact.
  - **Acceptance:** no bucket retains rows past its TTL.
  - **Spec coverage:** Spec-018 §PII in Diagnostics, Spec-018 §Fallback Behavior
  - **Verifies invariant:** I-018-3
  - **Consumes:** bucket tables ← T2.1; policy-state shape ← T1.3

- **T2.8 — Diagnostic summaries; nothing leaves the machine.**
  - **Files:** `packages/runtime-daemon/src/observability/diagnostic-redaction-policy.ts` (EXTEND — T1.3 creates it)
  - Where high-volume tool traces are compacted (T2.7), build the summary from counts, categories and durations, never by truncating free text. The daemon registers no telemetry exporter and sends no bucket row to any sink: nothing it records for diagnosis leaves the machine. Redaction decision logic stays code-local with no wire contract per §PII in Diagnostics.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/diagnostic-redaction-policy.test.ts` (EXTEND) — a compacted summary carries counts, categories and durations and none of the free-text fixture's words.
  - **Acceptance:** a compacted summary keeps no part of a prompt, a command or a tool result.
  - **Spec coverage:** Spec-018 §PII in Diagnostics
  - **Verifies invariant:** I-018-4
  - **Consumes:** policy-state shape ← T1.3; bucket implementations ← T2.7

- **T2.9 — The workflow engine's diagnostic bucket.**
  - **Files:** `packages/runtime-daemon/src/observability/diagnostic-buckets/` (EXTEND — the `workflow_engine_events` bucket)
  - The bucket the workflow engine's always-on event record writes to ([Spec-015 §Engine event record (SA-43)](../specs/015-workflow-authoring-and-execution.md#engine-event-record-sa-43)): newline-delimited JSON files in the daemon's data folder, one file per day, never a SQLite table and never a canonical event. It takes one record per append call, and Plan-015's `engine-event-log.ts` (T5.13) is its one writer. A day's file is deleted once its day is past `Keep diagnostic logs for`, by T2.7's purge driver, so the TTL and `Erase all data` reach it as they reach the tables. Nothing reads it for replay, projection rebuild, verification or audit.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/diagnostic-buckets.test.ts` (EXTEND) — a day's file past the configured TTL is deleted and the current day's is kept.
  - **Acceptance:** the engine record lives only in this bucket, under the same bound and erase as every other bucket.
  - **Spec coverage:** Spec-018 §PII in Diagnostics; [Spec-015 §Engine event record (SA-43)](../specs/015-workflow-authoring-and-execution.md#engine-event-record-sa-43)
  - **Verifies invariant:** I-018-3
  - **Consumes:** the purge driver ← T2.7; policy-state shape ← T1.3
  - **Provides:** the bucket [Plan-015](./015-workflow-authoring-and-execution.md) T5.13 writes into (CP-018-3)

## Parallelization Notes

- T2.1's tables can proceed in parallel with T1.3.

## Test And Verification Plan

- Retention tests proving compaction of raw diagnostics does not erase canonical failure detail or recovery visibility
- Summary construction (I-018-4): a compacted summary carries counts, categories and durations and none of the free-text fixture's words
- TTL-bucket-purge-coverage (I-018-3): each bucket expires rows at or before the configured TTL

## Rollout Order

1. Ship the diagnostic buckets with their TTL and summary builder

## Rollback Or Fallback

- The diagnostic buckets' bound has no off switch: they always drop rows past `Keep diagnostic logs for`, which the person may set to any period.

## Risks And Blockers

- Bounded-retention implementation can become misleading if raw diagnostic expiry is not clearly distinguished from canonical observability truth

## Done Checklist

- Diagnostic-bucket discipline verified across every bucket: rows dropped past `Keep diagnostic logs for`, ≤ 7 days by default (I-018-3), and compacted summaries built from counts, categories and durations only, with nothing leaving the machine (I-018-4)
