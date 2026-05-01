# Plan-020: Observability And Failure Recovery

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `020` |
| **Slug** | `observability-and-failure-recovery` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-020: Observability And Failure Recovery](../specs/020-observability-and-failure-recovery.md) |
| **Required ADRs** | [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-005](../decisions/005-provider-drivers-use-a-normalized-interface.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | [Plan-015](./015-persistence-recovery-and-replay.md) (persistence layer) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |
| **Owned Spec-027 Rows** | 9 — Prometheus `/metrics` exposition (daemon endpoint + six metric families + bind/auth secure-default contract); see [Spec-027 row 9](../specs/027-self-host-secure-defaults.md#required-behavior). Plan-025 mounts the equivalent relay-side surface. |

## Goal

Implement the health, failure-detail, stuck-run, and recovery-action surfaces needed for safe diagnosis and operator response.

## Scope

This plan covers runtime health projections, failure-category reads, stuck-run inspection, recovery-action requests, and degraded-mode visibility across daemon and control-plane dependencies.

## Non-Goals

- External dashboard or vendor-tool rollout
- Full incident-management workflow
- Business analytics

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/health/`
- `packages/runtime-daemon/src/observability/health-status-service.ts`
- `packages/runtime-daemon/src/observability/failure-detail-service.ts`
- `packages/runtime-daemon/src/observability/stuck-run-inspector.ts`
- `packages/runtime-daemon/src/observability/diagnostic-redaction-policy.ts` (PII redaction gate on all 4 diagnostic buckets)
- `packages/runtime-daemon/src/observability/diagnostic-buckets/` (TTL-bucket implementations for `driver_raw_events`, `command_output`, `tool_traces`, `reasoning_detail`)
- `packages/runtime-daemon/src/observability/metrics-exposition.ts` — Prometheus `/metrics` endpoint (Spec-027 row 9 daemon scope)
- `packages/runtime-daemon/src/observability/metrics-registry.ts` — allow-listed metric families with bounded label sets; PII-free by construction
- `packages/runtime-daemon/src/observability/metrics-auth.ts` — bearer-token / mTLS gate for non-loopback `METRICS_BIND`
- `packages/control-plane/src/health/`
- `packages/client-sdk/src/healthClient.ts`
- `apps/desktop/src/renderer/src/health-and-recovery/`

## PII in Diagnostics

Plan-020 is the implementation surface for [Spec-020 §PII in Diagnostics](../specs/020-observability-and-failure-recovery.md) and must honor the [Spec-022 §PII Data Map](../specs/022-data-retention-and-gdpr.md) classification of diagnostic data. The 4 bounded-retention diagnostic buckets — `driver_raw_events`, `command_output`, `tool_traces`, `reasoning_detail` — are runtime-local stores that may transit raw user content and therefore require TTL-bounded local retention, default-deny outbound telemetry, and opt-in raw-content capture.

- Default TTL: ≤ 7 days per Spec-020 §PII in Diagnostics. Operator-configured overrides > 30 days MUST emit the `retention_policy_override` warning metric on every daemon startup and on each policy read.
- Default-deny outbound: no diagnostic bucket content MAY leave the daemon host by default. Outbound telemetry carries summary-only signals derived by construction from non-PII inputs (counts, categories, latencies). Raw content transmission is opt-in per bucket.
- Shred fan-out coverage: each bucket's TTL purge path participates in the crypto-shred fan-out per [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md) Path 3 (bounded-retention purge) so a participant-purge request triggers purge of any bucket rows authored by the purged participant before the TTL would otherwise expire them.

## Prometheus `/metrics` Exposition (Spec-027 row 9)

Plan-020 owns the daemon-side `/metrics` endpoint required by [Spec-027 row 9](../specs/027-self-host-secure-defaults.md#required-behavior). The endpoint is an externally reachable security boundary, not a harmless diagnostic surface; it is designed to fail closed on insecure bind/auth configurations.

**Endpoint contract.**

- Path: `GET /metrics`
- Wire format: Prometheus v0.0.4 exposition (text/plain; version=0.0.4; charset=utf-8). OpenMetrics is accepted where clients request it via `Accept:` negotiation.
- Default bind: `METRICS_BIND=127.0.0.1:<port>` (loopback only). The daemon MUST reject a non-loopback `METRICS_BIND` at config-parse time unless auth is configured (bearer-token OR mTLS client cert).
- Non-loopback opt-in: when `METRICS_BIND` is non-loopback, the daemon MUST require either (a) `METRICS_AUTH=bearer` with a rotated token file or (b) `METRICS_AUTH=mtls` with an operator-provided client-cert allow-list. Missing auth on non-loopback bind is a parse-time error.
- Disable: `METRICS_BIND=off` disables the endpoint entirely. Disabling MUST emit a banner + `security.default.override=metrics_disabled` log event per [Spec-027 §Fallback Behavior](../specs/027-self-host-secure-defaults.md#fallback-behavior).

**Metric families (daemon scope — Plan-025 mounts the equivalent relay-side set).** Only the six Spec-027 row 9 families are exposed; any additional metric family requires a Plan-020 amendment.

| Family | Type | Labels (bounded) | Source |
| --- | --- | --- | --- |
| `token_auth_failure_total` | counter | `reason: "expired"\|"invalid"\|"dpop_mismatch"\|"principal_mismatch"\|"scope_denied"` (5 bounded values) | Auth middleware |
| `rate_limit_trip_total` | counter | `bucket: "session"\|"run"\|"invite"\|"relay_group"\|"resource"` (5 bounded values) | Rate-limit enforcer |
| `cedar_deny_total` | counter | `policy_family: "session"\|"membership"\|"runtime_node"\|"artifact"\|"admin"` (bounded; owned by ADR-012) | Cedar authorization layer |
| `relay_connection_churn_total` | counter | `phase: "connect"\|"disconnect"\|"reconnect"\|"rejected"` (4 bounded values) | Relay client (mount via Plan-025 relay-side equivalent) |
| `backup_success_total` | counter | `kind: "event_end"\|"nightly"\|"manual"` (3 bounded values) | Backup job (Plan-001/BL-063) |
| `auto_update_check_status` | gauge | none | Update-notify poller (Plan-007 row 7a) — values: `0=ok`, `1=behind`, `2=poll_failed` |

**PII-free-by-construction invariants.**

- Labels MUST NEVER carry: raw participant IDs, session IDs, invite codes, command text, file paths, URLs, tokens, or any free-form content.
- Labels MUST be enumerable at compile time — no dynamic label values. Tests assert the full label cardinality per family is bounded by the documented allow-list.
- Any attempt to emit a label value outside the allow-list MUST throw at emission time, not silently coerce. Emission-time enforcement prevents accidental PII bleed when a new code path adds a metric observation.

**Cardinality ceiling.** Total emitted series across all six families MUST stay below 200 per daemon instance. Series-count assertion runs in integration tests; exceeding the ceiling is a Plan-020 invariant violation (not a warning), blocking merge until the allow-list tightens.

## Data And Storage Changes

- Add daemon-owned health projections and failure-detail records derived from canonical events, replay state, and provider diagnostics.
- Add recovery-action audit records and surfaced health snapshots needed for operators and user-facing projections.
- Add the 4 diagnostic-bucket tables (`driver_raw_events`, `command_output`, `tool_traces`, `reasoning_detail`) to Local Runtime Daemon SQLite with TTL-purge and participant-scoped purge indices per [Local SQLite Schema §Diagnostic Bucket Tables](../architecture/schemas/local-sqlite-schema.md#diagnostic-bucket-tables-plan-020). These are runtime-local; they have no shared-Postgres counterpart per [ADR-017](../decisions/017-shared-event-sourcing-scope.md).
- Add bounded-retention handling for raw diagnostic payload classes so compaction never removes canonical health or failure truth.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for the shared `health_snapshots` column definitions; diagnostic bucket column definitions live in the Local SQLite schema because raw diagnostics never leave the daemon by default.

## API And Transport Changes

- Add `HealthStatusRead`, `FailureDetailRead`, `StuckRunInspect`, and `RecoveryActionRequest` to the typed client SDK and daemon contracts.
- Add `DiagnosticRedactionPolicy` contract: operator-readable current policy, opt-in toggles per bucket, and `retention_policy_override` warning surface. Default state is deny-outbound, ≤ 7-day TTL, no raw-content capture.
- Expose control-plane dependency health in a form that can be merged with daemon-owned observability projections.
- Add Prometheus `/metrics` endpoint (Spec-027 row 9) on the daemon with the bind/auth secure-default contract documented in §Prometheus `/metrics` Exposition above. Plan-025 mounts an equivalent relay-side `/metrics` endpoint using the same auth gate and metric-family allow-list shape.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define health-status, failure-category, recovery-condition, stuck-run inspection, and `DiagnosticRedactionPolicy` contracts.
2. Implement daemon-owned health and failure-detail projections derived from canonical state and provider diagnostics.
3. Implement safe recovery-action request handling and audit recording.
4. Implement bounded-retention policy handling for raw diagnostics without weakening canonical diagnosis surfaces. Wire default-deny outbound telemetry for all 4 diagnostic buckets; expose per-bucket opt-in raw-content capture with explicit operator acknowledgement; emit `retention_policy_override` warning metric when TTL override > 30 days.
5. Implement Prometheus `/metrics` endpoint with the six allow-listed metric families, bounded label sets, bearer/mTLS auth gate for non-loopback `METRICS_BIND`, and emission-time label enforcement (`metrics-exposition.ts`, `metrics-registry.ts`, `metrics-auth.ts`).
6. Add desktop recovery and health surfaces that distinguish runtime state, failure categories, and degraded modes without requiring raw logs.

## Parallelization Notes

- Contract work and daemon projection work can proceed in parallel once recovery vocabulary is fixed.
- Desktop health surfaces should wait for stable machine-readable payloads and actionability rules.

## Test And Verification Plan

- Health-projection tests for healthy, degraded, and blocked runtime conditions
- Stuck-run detection tests covering thresholds, blocking-state exemptions, and false-positive suppression
- Recovery-action audit and safety tests for provider, replay, and persistence failure scenarios
- Retention tests proving compaction of raw diagnostics does not erase canonical failure detail or recovery visibility
- Outbound-telemetry-default-deny: no diagnostic-bucket row content appears in any outbound payload unless the corresponding per-bucket opt-in is explicitly enabled
- Raw-content-opt-in-explicit-only: opt-in toggle requires operator acknowledgement and is audited; a flipped toggle does not retroactively release previously-captured data
- TTL-bucket-purge-coverage: each of the 4 buckets expires rows at or before the configured TTL; participant-purge requests trigger immediate purge of that participant's rows ahead of TTL per [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md) Path 3
- `retention_policy_override` warning emission: any policy read observing TTL > 30 days emits the warning metric on daemon startup and on each policy read
- **/metrics endpoint secure-default tests (Spec-027 row 9):**
  - Default bind is `127.0.0.1`; a non-loopback `METRICS_BIND` without auth fails at config-parse time with actionable error.
  - `METRICS_AUTH=bearer` on non-loopback bind rejects requests without the bearer token and with a wrong bearer token; rotating the token file invalidates old tokens on the next request.
  - `METRICS_AUTH=mtls` on non-loopback bind rejects requests from clients whose cert is not on the operator-provided allow-list.
  - `METRICS_BIND=off` disables the endpoint, emits the loud banner, and emits `security.default.override=metrics_disabled` log event exactly once per startup.
  - Cardinality ceiling: integration test asserts total emitted series across the six families stays below 200 per daemon instance; exceeding ceiling blocks merge.
  - PII-free label enforcement: attempting to emit a label value outside the documented allow-list throws at emission time (unit test per family).
  - Exposition format conforms to Prometheus v0.0.4 (parse-round-trip verified against a reference parser).

## Rollout Order

1. Ship health and failure-detail projections
2. Enable stuck-run inspection and degraded-mode UI visibility
3. Enable operator-triggered recovery actions where policy allows

## Rollback Or Fallback

- Disable operator-triggered recovery actions and keep read-only observability surfaces if action handling regresses.

## Risks And Blockers

- Automated retry policy remains unresolved across drivers (deferral tracked in parent [Spec-020](../specs/020-observability-and-failure-recovery.md))
- Health projections can become misleading if replay and provider diagnostics are not merged from authoritative sources
- Bounded-retention implementation can become misleading if raw diagnostic expiry is not clearly distinguished from canonical observability truth

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
- [ ] Prometheus `/metrics` endpoint lands with the six allow-listed metric families, bounded label sets, bearer-token / mTLS auth gate for non-loopback bind, and emission-time label enforcement verified by negative tests
- [ ] Cardinality ceiling (< 200 series per daemon instance) asserted in integration tests and wired into CI
