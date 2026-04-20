# Spec-020: Observability And Failure Recovery

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `020` |
| **Slug** | `observability-and-failure-recovery` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md), [Observability Architecture](../architecture/observability-architecture.md), [Data Architecture](../architecture/data-architecture.md) |
| **Implementation Plan** | [Plan-020: Observability And Failure Recovery](../plans/020-observability-and-failure-recovery.md) |

## Purpose

Define the operator- and user-facing contract for detecting failures, diagnosing them, and recovering from degraded runtime conditions.

## Scope

This spec covers failure categories, health signals, stuck-run detection, replay-health visibility, and degraded-mode behavior.

## Non-Goals

- Full incident response procedures
- Specific dashboards or vendor tooling
- Business analytics

## Domain Dependencies

- [Run State Machine](../domain/run-state-machine.md)
- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Architectural Dependencies

- [Observability Architecture](../architecture/observability-architecture.md)
- [Data Architecture](../architecture/data-architecture.md)
- [ADR-003: Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)
- [ADR-004: SQLite Local State And Postgres Control Plane](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)
- [ADR-005: Provider Drivers Use A Normalized Interface](../decisions/005-provider-drivers-use-a-normalized-interface.md)

## Required Behavior

- The system must expose health and failure signals for local daemon, provider drivers, replay state, queue state, control-plane connectivity, and run latency and run duration distributions.
- The system must detect and surface `stuck-suspected` runs, projection lag, failed recovery attempts, and provider-session recovery failures.
- Operators and users must be able to distinguish:
  - transport failure
  - provider failure
  - local persistence failure
  - projection failure
  - policy or approval blockage
- Operators and users must be able to distinguish canonical `RunState` from derived health signals, failure categories, and recovery conditions.
- Degraded modes must be explicit and must preserve as much read visibility as possible.
- Non-canonical observability payloads such as driver raw events, raw command output, high-volume tool traces, and policy-permitted detailed reasoning payloads must use explicit bounded retention separate from canonical event and failure-detail retention.

## Default Behavior

- Local runtime health defaults to visible status categories `healthy`, `degraded`, and `blocked`.
- A run is considered `stuck-suspected` after 60 seconds without new progress events, and auto-escalates to a health signal after 5 minutes.
- Replay health defaults to visible status when the daemon is rebuilding projections or recovering bindings after restart.
- Canonical health and failure-detail projections remain durable even after bounded raw diagnostic payloads are compacted or removed.

## Fallback Behavior

- If remote telemetry export is unavailable, local logs, traces, and canonical event replay remain sufficient for diagnosis.
- If projection rebuild fails, the system enters degraded read-only mode instead of accepting unsafe new mutable work.
- If provider recovery fails, the affected run remains visible in canonical state `failed` with `provider failure` detail and `recovery-needed` condition rather than disappearing.
- If bounded diagnostic payload retention has expired, diagnosis must fall back to canonical events, health projections, failure detail, and any retained summaries rather than failing closed.

## Interfaces And Contracts

- `HealthStatusRead` must expose daemon, control-plane, provider, and replay health.
- `FailureDetailRead` must expose machine-readable failure category, recovery condition where applicable, and human-readable summary.
- `StuckRunInspect` must expose the last known progress point, last event time, blocking reason if any, and whether the run is currently `stuck-suspected`.
- `RecoveryActionRequest` must support safe operator-triggered retry where allowed.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Failure and recovery signals must be derived from canonical state and observability pipelines.
- Health projections must remain queryable even when full timeline UIs are not open.
- Recovery actions and outcomes must be auditable.
- Raw diagnostic payloads are non-canonical observability records with bounded retention and must not become the only source for audit or recovery truth.

## PII in Diagnostics

Diagnostic pipelines (driver raw events, raw command output, tool traces, detailed reasoning payloads, OpenTelemetry spans/logs, error-tracker events) carry PII-carrying content by default of their purpose — they capture the full model prompt, the full command arguments, the full tool-call result — so the baseline question is not *"does this carry PII"* but *"what is the redaction and retention discipline that keeps diagnostics from becoming an Article-17 escape hatch."* This section establishes that discipline as a required-behavior policy; Spec-022 owns the storage-and-shred side.

### Required Behavior (policy)

- **Default-deny on outbound telemetry.** Free-text fields that may contain user input (OTel span attributes like `gen_ai.prompt` / `gen_ai.completion`, OTel log `body`, error-tracker `request`/`extra`) MUST be redacted at the exporter before any network egress to a third-party sink. "Redacted" means either replaced by a shape-preserving placeholder or dropped entirely; partial masking (last-4-characters, asterisks over substrings) is NOT acceptable because partial PII is still PII.
- **Opt-in for raw content.** Operators may enable raw-content capture on a per-deployment, per-sink basis with a durable configuration record. The opt-in MUST name the sink, the field set, and the operator who authorized it. Enabling raw capture flips no default; each captured event carries a flag so downstream consumers can distinguish raw-opt-in events from default-redacted events.
- **Bounded local retention.** Local diagnostic buckets (`driver_raw_events`, `command_output`, `tool_traces`, `reasoning_detail` per [Spec-022 §PII Data Map](022-data-retention-and-gdpr.md#pii-data-map) bounded-retention tier) MUST apply a ≤ 7-day TTL by default. The daemon MAY expose a per-deployment override but MUST emit a `retention_policy_override` warning metric if the override exceeds 30 days.
- **Shred fan-out coverage.** Every diagnostic bucket that stores PII MUST be included in the crypto-shred fan-out per [Spec-022 §Shred Fan-Out](022-data-retention-and-gdpr.md#shred-fan-out) Path 3. A diagnostic pipeline that emits PII-carrying records to a sink outside the shred fan-out's reach is a spec violation; either the pipeline must be redacted or a per-participant scoped-flush mechanism must be added to the sink.
- **Summary-only retention.** Where detailed reasoning or high-volume tool traces are compacted, the summary form MUST be constructed from non-PII signals (counts, categories, durations) by construction. A summary derived by truncation of free-text input is NOT compliant because truncated PII is still PII.

### Industry Precedent

**OpenTelemetry Generative AI semantic conventions.** [OTel GenAI semconv v1.36.0](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (accessed 2026-04-19) defines attributes `gen_ai.prompt`, `gen_ai.completion`, `gen_ai.system`. The spec states verbatim regarding these attributes: *"Instrumentations SHOULD NOT capture them by default"* — a baseline opt-in posture this spec mirrors for outbound telemetry.

**Datadog Sensitive Data Scanner.** [Datadog Sensitive Data Scanner documentation](https://docs.datadoghq.com/sensitive_data_scanner/) (accessed 2026-04-19) publishes a managed-rule library of default scanners (email addresses, US/EU national IDs, credit cards, API tokens, private IPs) that redact matching substrings at ingest. Our default-deny-on-outbound policy is stricter than Datadog's default-allow-with-redaction posture because we redact the entire field when PII-risk is suspected rather than attempting substring identification — consistent with the "partial PII is still PII" invariant.

**Sentry server-side scrubbing.** [Sentry data scrubbing documentation](https://docs.sentry.io/product/data-management-settings/scrubbing/server-side-scrubbing/) (accessed 2026-04-19) publishes a default keyname list (`password`, `secret`, `passwd`, `api_key`, `apikey`, `auth`, `credentials`, `mysql_pwd`, `privatekey`, `private_key`, `token`) scrubbed at ingest before persistence. Our operator opt-in record mirrors Sentry's "advanced data scrubbing" pattern where operators can declare custom rules but the defaults remain default-deny.

### Cross-Reference To Spec-022

- [Spec-022 §PII Data Map — bounded-retention tier](022-data-retention-and-gdpr.md#pii-data-map) — owns the durability-and-retention side of the four diagnostic buckets
- [Spec-022 §Shred Fan-Out — Path 3](022-data-retention-and-gdpr.md#shred-fan-out) — owns the crypto-shred fan-out for the bounded-retention diagnostic tier
- [Spec-006 §Event Maintenance](006-session-event-taxonomy-and-audit-log.md#event-maintenance-event_maintenance) — `event.shredded` records the shred operation

## Example Flows

- `Example: A provider session stops emitting events without reaching a terminal state. The run is marked stuck-suspected, the health projection turns degraded, and an operator can inspect the last known progress point. If resume later fails, the run moves to failed with provider failure detail and recovery-needed condition.`
- `Example: Replay rebuild fails on startup. The daemon enters blocked read-only mode, surfaces a recovery error, and refuses new mutable work until repaired.`

## Implementation Notes

- Observability is not separate from recovery; it is the mechanism that makes recovery safe to reason about.
- Failure categories should be enumerable and stable for automation and operations docs.
- Degraded read-only mode is preferable to silent partial mutation during uncertain recovery state.
- Operational handling for policy and approval blockage is covered by approval-UX surfaces in Spec-012 and is not a separate runbook in V1.

## Pitfalls To Avoid

- Treating all failures as generic provider errors
- Accepting new mutable work during uncertain replay state
- Hiding recovery failures behind silent retries only

## Acceptance Criteria

- [ ] Users and operators can distinguish blocked, degraded, and healthy runtime conditions.
- [ ] Stuck-run suspicion and replay-health state are visible without opening raw logs.
- [ ] Recovery failures remain visible and auditable until resolved.

## ADR Triggers

- If the system changes how replay or health truth is derived, update `../decisions/004-sqlite-local-state-and-postgres-control-plane.md` or create a new observability ADR.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: automated recovery retries use one product-defined bounded policy across providers in v1. Drivers may mark failures non-retryable, but they do not define independent retry budgets.
- V1 decision: raw diagnostic payload retention is bounded and non-canonical in v1. The product does not standardize one global duration, but every implementation must apply explicit retention policy for driver raw events, raw command output, high-volume tool traces, and any policy-permitted detailed reasoning payloads.

## References

- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)
- [Observability Architecture](../architecture/observability-architecture.md)
- [Data Architecture](../architecture/data-architecture.md)
