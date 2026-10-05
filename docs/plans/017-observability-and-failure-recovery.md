# Plan-017: Observability And Failure Recovery

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `017` |
| **Slug** | `observability-and-failure-recovery` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-018: Observability And Failure Recovery](../specs/018-observability-and-failure-recovery.md) |
| **Required ADRs** | [ADR-003](../decisions/003-daemon-backed-queue-and-interventions.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-005](../decisions/005-provider-drivers-use-a-normalized-interface.md), [ADR-014](../decisions/014-v1-feature-scope-definition.md), [ADR-016](../decisions/016-shared-event-sourcing-scope.md) |
| **Dependencies** | [Plan-012](./012-persistence-and-recovery.md) (persistence layer) |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |

## Goal

Implement the daemon's diagnostic signals: bounded retention on this machine for its diagnostic buckets. No client reads a `health.*` method; Settings › Runtime reads the service's status from `daemon.status.read`.

## Scope

This plan covers the diagnostic buckets `driver_raw_events`, `command_output` and `tool_traces`, `workflow_engine_events`, the bucket the workflow engine's always-on event record writes to, and the service log the daemon writes about itself (`logs/service-<start time>.log`, written by [Plan-005](./005-local-ipc-and-daemon-control.md) T-005r-1-18): log files in the daemon's data folder, never tables, and their expiry, which deletes a whole file once it is past `Keep diagnostic logs for`, and the two diagnostic switches on Settings › Runtime, `Record traces` and `Record raw provider messages`, which turn real recording on and off. Nothing in any of them leaves the machine. The retry rules of [Spec-018 §Required Behavior](../specs/018-observability-and-failure-recovery.md#required-behavior) are built where their mechanisms live: the Codex service restart bound with the Codex service's lifecycle, the pane-read retry with the pane reads.

## Non-Goals

- External dashboard or vendor-tool rollout
- Full incident-management workflow
- Business analytics

## Preconditions

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/runtime-daemon/src/observability/diagnostic-retention-policy.ts` (the policy state the expiry reads: each bucket's TTL)
- `packages/runtime-daemon/src/observability/diagnostic-buckets/` (the log-file buckets and their expiry for `driver_raw_events`, `command_output`, `tool_traces` and `workflow_engine_events`)

## PII in Diagnostics

Plan-017 is the implementation surface for [Spec-018 §PII in Diagnostics](../specs/018-observability-and-failure-recovery.md#pii-in-diagnostics) and must honor the [Spec-020 §PII Data Map](../specs/020-data-retention-and-gdpr.md#pii-data-map) classification of diagnostic data. The bounded-retention diagnostic buckets — `driver_raw_events`, `command_output`, `tool_traces` and `workflow_engine_events` — are runtime-local stores that may transit raw user content and therefore require TTL-bounded local retention and never leave the machine.

- Default TTL: 7 days per [Spec-018 §PII in Diagnostics](../specs/018-observability-and-failure-recovery.md#pii-in-diagnostics). `Keep diagnostic logs for` sets it and takes any period.
- Nothing leaves the machine: the daemon runs no telemetry exporter and sends no diagnostic bucket content to any sink.
- Bound and erase: each bucket deletes a whole file once it is past `Keep diagnostic logs for` ([Spec-020 §Erasure Paths](../specs/020-data-retention-and-gdpr.md#erasure-paths) Path 3), and `Erase all data` deletes them with the data folder. There is no per-person flush.

**Policy locality (no wire contract).** The diagnostic policy _state_ — each bucket's TTL — is daemon-local code in `diagnostic-retention-policy.ts`. It is deliberately **not** published as a typed payload in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md): the daemon is the only principal that sees diagnostic content, and none of it leaves the machine. The retention period is the `Keep diagnostic logs for` setting on Settings › Runtime, carried by the daemon's configuration reads and writes ([Plan-005 §Phase R1 — Namespace Handlers](./005-local-ipc-and-daemon-control.md#phase-r1--namespace-handlers)).

## Data And Storage Changes

- The diagnostic buckets are log files in the daemon's data folder, never SQLite tables. They are runtime-local and have no shared-Postgres counterpart per [ADR-016](../decisions/016-shared-event-sourcing-scope.md).
- Deleting a diagnostic log never removes the failure detail a run event carries: that detail lives on the run event.
- This plan adds no table to either schema.

## API And Transport Changes

- No `health.*` read is added for any client, and no `health.*` method string is registered. Settings › Runtime's service status comes from the supervisor through `daemon.status.read` ([Plan-005 §Phase R1 — Namespace Handlers](./005-local-ipc-and-daemon-control.md#phase-r1--namespace-handlers)).
- The diagnostic policy is daemon-local state, not a contract: the TTL from `Keep diagnostic logs for`. The default TTL is 7 days.

## Invariants

Load-bearing constraints every Plan-017 PR — and every downstream extension — must preserve. Each entry names the governing clause it grounds in, or declares itself plan-owned.

- **I-017-1 — Diagnostic-bucket retention is TTL-bounded by `Keep diagnostic logs for`, 7 days by default.** All the buckets (`driver_raw_events`, `command_output`, `tool_traces`, `workflow_engine_events`) and the service log delete each file once it is past `Keep diagnostic logs for`, 7 days by default; the person may set any period. **Grounds in.** [Spec-018 §PII in Diagnostics](../specs/018-observability-and-failure-recovery.md#pii-in-diagnostics) ("Bounded local retention"), with the storage side owned by [Spec-020 §PII Data Map](../specs/020-data-retention-and-gdpr.md#pii-data-map)'s bounded-retention tier. **Why load-bearing.** The buckets capture full prompts, full command arguments, and full tool results by the nature of their purpose; without the bound, content the person deleted from a session would persist indefinitely beside it in the diagnostics. **Verification.** T2.1, T2.2.
- **I-017-2 — Diagnostics never leave the machine.** The daemon runs no telemetry exporter and sends no diagnostic-bucket content to any sink. **Grounds in.** [Spec-018 §PII in Diagnostics](../specs/018-observability-and-failure-recovery.md#pii-in-diagnostics) ("Nothing leaves the machine"). **Why load-bearing.** The buckets hold full prompts, command output and tool results; a copy sent off the machine would outlive the bound that deletes them here. **Verification.** T2.1.

## Cross-Plan Obligations

Each entry is an obligation shared with the plan it names. See Cross-Plan Dependency Graph for the graph-level view.

### CP-017-1 — The diagnostic buckets are bounded by `Keep diagnostic logs for` (⇄ Plan-019 CP-019-4)

**Obligation.** Plan-017's diagnostic buckets delete each file past `Keep diagnostic logs for` on the service's one scheduler ([Plan-005 §Phase R1 — Namespace Handlers](./005-local-ipc-and-daemon-control.md#phase-r1--namespace-handlers)); `Erase all data` deletes them with the data folder. There is no per-person flush.

**Resolution.** Plan-017's half is I-017-1, implemented by T2.1. Plan-019 places the bound in its retention tiers as Path 3. A new diagnostic bucket added by either side joins the same bound.

### CP-017-2 — The workflow engine's diagnostic bucket (⇄ Plan-014 CP-014-9)

**Obligation.** Plan-017 creates `workflow_engine_events`, the bucket the always-on engine event record of [Spec-015 §Engine event record (SA-41)](../specs/015-workflow-authoring-and-execution.md#engine-event-record-sa-41) lands on, with its TTL and its Path-3 membership; Plan-014 writes records into it and authors none of that.

**Resolution.** T2.2 builds the bucket; Plan-014 T5.24 is its writer and waits on it.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define the diagnostic retention policy state, daemon-local: each bucket's TTL.
2. Implement the expiry of the diagnostic logs, which deletes a whole file past its bound, without weakening canonical diagnosis, with no exporter and no sink off the machine.

## Implementation Phase Sequence

Each phase builds one of the §Implementation Steps above: Phase 1 Step 1, Phase 2 Step 2. Phase 1 has no unsatisfied upstream code dependency; Phase 2 serializes behind it.

### Phase 1 — Diagnostic policy state

**Precondition:** none. Implementation Step 1; gates Phase 2, whose expiry reads this state.

#### Tasks

- **T1.1 — Diagnostic retention policy state (daemon-local).**
  - **Files:** `packages/runtime-daemon/src/observability/diagnostic-retention-policy.ts` (CREATE — the policy-state type and its resolution)
  - The policy _state_ the expiry reads: the TTL per bucket, resolved from the `Keep diagnostic logs for` setting in daemon configuration. The default TTL is 7 days. Neither the state nor the expiry that reads it is a wire contract — see §PII in Diagnostics above.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/diagnostic-retention-policy.test.ts` (CREATE) — the default TTL is 7 days; a configured TTL resolves per bucket; a configuration naming a bucket that does not exist is refused at load.
  - **Acceptance:** the expiry reads one resolved policy state, and no client can read or override it over the wire.
  - **Spec coverage:** Spec-018 §PII in Diagnostics
  - **Verifies invariant:** none (I-017-1 and I-017-2 are enforced by T2.1)
  - **Consumes:** the bucket names ← [Spec-020 §PII Data Map](../specs/020-data-retention-and-gdpr.md#pii-data-map) bounded-retention tier (doc contract); the `Keep diagnostic logs for` key ← daemon configuration ([Plan-005 §Phase R1 — Namespace Handlers](./005-local-ipc-and-daemon-control.md#phase-r1--namespace-handlers))

### Phase 2 — Diagnostic-bucket retention

**Precondition:** Phase 1 merged. Implementation Step 2.

#### Tasks

- **T2.1 — Diagnostic-bucket TTL retention.**
  - **Files:** `packages/runtime-daemon/src/observability/diagnostic-buckets/` (CREATE — one log-file bucket per bucket plus the shared purge driver)
  - Each bucket writes log files in the daemon's data folder, never a table. The shared purge driver deletes a whole file, the service log's `logs/service-<start time>.log` files included, once it is past the TTL `Keep diagnostic logs for` sets, 7 days by default and any period the person chooses. The buckets write nowhere off the machine, and the daemon registers no telemetry exporter. Deleting a log never removes the failure detail a run event carries.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/diagnostic-buckets.test.ts` (CREATE) — a bucket's file, and a service log file, past the configured TTL is deleted whole and a newer one is kept; a run event's failure detail is intact after its logs are deleted.
  - **Acceptance:** no bucket keeps a file past its TTL.
  - **Spec coverage:** Spec-018 §PII in Diagnostics, Spec-018 §Fallback Behavior
  - **Verifies invariant:** I-017-1, I-017-2
  - **Consumes:** policy-state shape ← T1.1

- **T2.2 — The workflow engine's diagnostic bucket.**
  - **Files:** `packages/runtime-daemon/src/observability/diagnostic-buckets/` (EXTEND — the `workflow_engine_events` bucket)
  - The bucket the workflow engine's always-on event record writes to ([Spec-015 §Engine event record (SA-41)](../specs/015-workflow-authoring-and-execution.md#engine-event-record-sa-41)): newline-delimited JSON files in the daemon's data folder, one file per day, never a SQLite table and never a canonical event. It takes one record per append call, and Plan-014's `engine-event-log.ts` (T5.24) is its one writer. A day's file is deleted once its day is past `Keep diagnostic logs for`, by T2.1's purge driver, so the TTL and `Erase all data` reach it as they reach every bucket. Nothing reads it for projection rebuild, verification or audit.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/diagnostic-buckets.test.ts` (EXTEND) — a day's file past the configured TTL is deleted and the current day's is kept.
  - **Acceptance:** the engine record lives only in this bucket, under the same bound and erase as every other bucket.
  - **Spec coverage:** Spec-018 §PII in Diagnostics; [Spec-015 §Engine event record (SA-41)](../specs/015-workflow-authoring-and-execution.md#engine-event-record-sa-41)
  - **Verifies invariant:** I-017-1
  - **Consumes:** the purge driver ← T2.1; policy-state shape ← T1.1
  - **Provides:** the bucket [Plan-014](./014-workflow-authoring-and-execution.md) T5.24 writes into (CP-017-2)

- **T2.3 — The two diagnostic switches.**
  - **Files:** `packages/runtime-daemon/src/observability/diagnostic-buckets/` (EXTEND — the `tool_traces` switch and the `driver_raw_events` switch)
  - `Record traces` (`recordTraces`) and `Record raw provider messages` (`recordProviderMessages`), both off by default, are read from the daemon's configuration ([Plan-005](./005-local-ipc-and-daemon-control.md) T-005r-1-10) and take effect from the change on. The `tool_traces` bucket is written only while `Record traces` is on. While `Record raw provider messages` is on, `driver_raw_events` writes every message Claude Code or Codex sends the daemon, word for word, into the folder at `providerMessagesPath`, which the Runtime page names, so a turn the daemon translated wrongly can be debugged; while it is off nothing is written to `driver_raw_events`. Both are diagnostic logs: deleted whole past `Keep diagnostic logs for` by T2.1's purge driver, deleted with the data folder by `Erase all data`, and never sent off the machine.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/diagnostic-buckets.test.ts` (EXTEND) — with each switch off a run writes nothing to its file; turned on, the next event lands in it; turned off again, nothing more is written.
  - **Acceptance:** nothing is traced or logged for diagnosis while its switch is off.
  - **Spec coverage:** Spec-018 §PII in Diagnostics
  - **Verifies invariant:** I-017-1, I-017-2
  - **Consumes:** the purge driver ← T2.1; the two switches ← [Plan-005](./005-local-ipc-and-daemon-control.md) T-005r-1-10

## Parallelization Notes

- Phase 2 serializes behind T1.1's policy state, and T2.2 and T2.3 build on T2.1's purge driver.

## Test And Verification Plan

- Retention tests proving the deletion of diagnostic logs does not erase canonical failure detail or recovery visibility
- TTL-bucket-purge-coverage (I-017-1): each bucket deletes a file once it is past the configured TTL
- Switch coverage: a diagnostic switch that is off records nothing

## Rollout Order

1. Ship the diagnostic buckets with their TTL

## Rollback Or Fallback

- The diagnostic buckets' bound has no off switch: they always delete files past `Keep diagnostic logs for`, which the person may set to any period.

## Risks And Blockers

- Bounded-retention implementation can become misleading if raw diagnostic expiry is not clearly distinguished from canonical observability truth

## Done Checklist

- Diagnostic-bucket discipline verified across every bucket: files deleted whole past `Keep diagnostic logs for`, 7 days by default (I-017-1), with nothing leaving the machine (I-017-2), and nothing recorded by a diagnostic switch that is off (T2.3)
