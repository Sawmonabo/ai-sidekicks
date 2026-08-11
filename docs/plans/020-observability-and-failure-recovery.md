# Plan-020: Observability And Failure Recovery

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `020` |
| **Slug** | `observability-and-failure-recovery` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-020: Observability And Failure Recovery](../specs/020-observability-and-failure-recovery.md) |
| **Required ADRs** | [ADR-003](../decisions/003-daemon-backed-queue-and-interventions.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-005](../decisions/005-provider-drivers-use-a-normalized-interface.md), [ADR-012](../decisions/012-cedar-approval-policy-engine.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md) |
| **Dependencies** | [Plan-015](./015-persistence-recovery-and-replay.md) (persistence layer) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |
| **Owned Spec-027 Rows** | 9 — Prometheus `/metrics` exposition (daemon endpoint + five daemon metric families (row 9a) + the bind/auth secure-default contract, which is shared: the same `METRICS_BIND` / `METRICS_AUTH` contract governs row 9b's relay endpoint); see [Spec-027 row 9](../specs/027-self-host-secure-defaults.md#required-behavior). Plan-025 mounts the equivalent relay-side surface, owning row 9b's relay metric families and endpoint wiring while consuming this plan's bind/auth contract (CP-020-4). |

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
- [x] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier-8 audit (2026-08-10, PR #318): backfilled §Implementation Phase Sequence (4 phases), §Invariants (I-020-1..5), and §Cross-Plan Obligations (CP-020-1..4) by transcribing this plan's already-committed body and the four counterparties' already-committed obligation text; extended §Required ADRs; and reconciled the stale six-family metric count in Spec-027 and the self-host runbook against the ratified 2026-06-10 D-021-8 pass. Backfill only — no new design — so Plan-020 stays `approved` per the NS-19 backfill precedent. The PR's review round added the four reconciliations the §Notes 2026-08-10 entry's review-round addendum records; each records or names a mechanism ratified text already mandates — none invents behavior — so the same precedent holds.

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/health/`
- `packages/runtime-daemon/src/observability/health-status-service.ts`
- `packages/runtime-daemon/src/observability/failure-detail-service.ts`
- `packages/runtime-daemon/src/observability/stuck-run-inspector.ts`
- `packages/runtime-daemon/src/observability/diagnostic-redaction-policy.ts` (PII redaction gate on all 4 diagnostic buckets)
- `packages/runtime-daemon/src/observability/diagnostic-buckets/` (TTL-bucket implementations for `driver_raw_events`, `command_output`, `tool_traces`, `reasoning_detail`)
- `packages/runtime-daemon/src/observability/health-method-handlers.ts` — `health.*` JSON-RPC method registration + handler wiring (T2.10; strings per the Health Method-Name Registry)
- `packages/runtime-daemon/src/observability/metrics-exposition.ts` — Prometheus `/metrics` endpoint (Spec-027 row 9 daemon scope)
- `packages/runtime-daemon/src/observability/metrics-registry.ts` — allow-listed metric families with bounded label sets; PII-free by construction
- `packages/runtime-daemon/src/observability/metrics-auth.ts` — bearer-token / mTLS gate for non-loopback `METRICS_BIND`
- `packages/control-plane/src/health/`
- `packages/client-sdk/src/healthClient.ts`
- `apps/desktop/src/renderer/src/health-and-recovery/`

## PII in Diagnostics

Plan-020 is the implementation surface for [Spec-020 §PII in Diagnostics](../specs/020-observability-and-failure-recovery.md#pii-in-diagnostics) and must honor the [Spec-022 §PII Data Map](../specs/022-data-retention-and-gdpr.md#pii-data-map) classification of diagnostic data. The 4 bounded-retention diagnostic buckets — `driver_raw_events`, `command_output`, `tool_traces`, `reasoning_detail` — are runtime-local stores that may transit raw user content and therefore require TTL-bounded local retention, default-deny outbound telemetry, and opt-in raw-content capture.

- Default TTL: ≤ 7 days per `Spec-020 §PII in Diagnostics`. Operator-configured overrides > 30 days MUST emit the `retention_policy_override` warning metric on every daemon startup and on each policy read.
- Default-deny outbound: no diagnostic bucket content MAY leave the daemon host by default. Outbound telemetry carries summary-only signals derived by construction from non-PII inputs (counts, categories, latencies). Raw content transmission is opt-in per bucket.
- Shred fan-out coverage: each bucket's TTL purge path participates in the crypto-shred fan-out per [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md#shred-fan-out) Path 3 (bounded-retention purge) so a participant-purge request triggers purge of any bucket rows authored by the purged participant before the TTL would otherwise expire them.

**Redaction-decision locality (no wire contract).** The redaction and default-deny _decision logic_ — which fields are denied, which placeholder shape replaces them, which sink an opt-in covers — is daemon-local code in `diagnostic-redaction-policy.ts`. It is deliberately **not** published as a typed payload in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md), because no cross-package consumer evaluates redaction: the daemon is the only principal that sees unredacted diagnostic content, and it redacts before egress rather than handing rules to a caller. What does cross a contract boundary is the operator-readable policy _state_ — the `DiagnosticRedactionPolicy` read named in §API And Transport Changes below (current TTL, per-bucket opt-in toggles, `retention_policy_override` warning surface). A future consumer that needs to _evaluate_ redaction rather than _read_ policy state requires a Plan-020 amendment publishing the rule set as a typed contract first; until then, changing a redaction rule is a code change with no cross-plan contract ripple.

## Prometheus `/metrics` Exposition (Spec-027 row 9)

Plan-020 owns the daemon-side `/metrics` endpoint required by [Spec-027 row 9](../specs/027-self-host-secure-defaults.md#required-behavior). The endpoint is an externally reachable security boundary, not a harmless diagnostic surface; it is designed to fail closed on insecure bind/auth configurations.

**Endpoint contract.**

- Path: `GET /metrics`
- Wire format: Prometheus v0.0.4 exposition (text/plain; version=0.0.4; charset=utf-8). OpenMetrics is accepted where clients request it via `Accept:` negotiation.
- Default bind: `METRICS_BIND=127.0.0.1:<port>` (loopback only). The daemon MUST reject a non-loopback `METRICS_BIND` at config-parse time unless auth is configured (bearer-token OR mTLS client cert).
- Non-loopback opt-in: when `METRICS_BIND` is non-loopback, the daemon MUST require either (a) `METRICS_AUTH=bearer` with a rotated token file or (b) `METRICS_AUTH=mtls` with an operator-provided client-cert allow-list. Missing auth on non-loopback bind is a parse-time error.
- Credential inputs (the concrete-variable layer of this contract; Plan-025's relay config loader parses the identical set per CP-020-4): credential material is supplied by file-path env vars, never inline env values. `METRICS_AUTH=bearer` requires `METRICS_AUTH_TOKEN_FILE` — the path to the bearer-token file; the entire trimmed file body is the token. `METRICS_AUTH=mtls` requires `METRICS_TLS_CLIENT_CA_FILE` — the PEM CA bundle presented client certificates must chain to — and `METRICS_TLS_CLIENT_ALLOWLIST_FILE` — the operator-provided allow-list, one SPKI-SHA256 client-certificate fingerprint per line (the fingerprint form Spec-027 row 1 persists at `./data/trust/fingerprint.txt`), `#`-prefixed comment lines ignored; a client certificate is accepted only when it both verifies against the CA bundle and matches an allow-list entry. Any non-loopback `METRICS_BIND` additionally requires the listener keypair `METRICS_TLS_CERT_FILE` + `METRICS_TLS_KEY_FILE` (server certificate + private key) in **both** auth modes — Spec-027 row 2 refuses unencrypted non-loopback listeners independently of the auth gate, so a plaintext bearer scrape is never servable.
- Credential validation (fail closed): at config-parse time, a required credential file that is missing, unreadable, empty, or malformed — including a cert/key pair that does not match, a CA bundle containing no usable certificate, and an allow-list with zero entries — is a parse-time error naming the offending variable, never a warn-and-serve. Credential material that becomes invalid after startup (token file deleted or emptied, allow-list emptied) causes every scrape to be rejected with an actionable log line rather than the endpoint serving unauthenticated.
- Credential rotation/reload: `METRICS_AUTH_TOKEN_FILE` and `METRICS_TLS_CLIENT_ALLOWLIST_FILE` are change-detected and re-read on the authorization path, so replacing file contents rotates the credential without a daemon restart; a rotated-away token or de-listed fingerprint is rejected from the next request onward with no accept-both grace window (the behavior T3.3's rotation test pins). `METRICS_TLS_CERT_FILE` / `METRICS_TLS_KEY_FILE` / `METRICS_TLS_CLIENT_CA_FILE` take effect on daemon restart.
- Disable: `METRICS_BIND=off` disables the endpoint entirely. Disabling MUST emit a banner + `security.default.override=metrics_disabled` log event per [Spec-027 §Fallback Behavior](../specs/027-self-host-secure-defaults.md#fallback-behavior).

**Metric families (daemon scope — Plan-025 mounts the equivalent relay-side set).** The daemon registry exposes exactly six families: the five Spec-027 row 9a families (the set D-021-8 ratified — that count does not move) plus the plan-owned `retention_policy_override` warning gauge mandated by [Spec-020 §PII in Diagnostics](../specs/020-observability-and-failure-recovery.md#pii-in-diagnostics) and required by I-020-3 / T2.7. The gauge is daemon-only — it reports diagnostic-bucket retention state, which has no relay-side equivalent — and sits outside the row-9a security set, so Spec-027's row-9a enumeration is unchanged. Any further daemon metric family requires a Plan-020 amendment.

| Family | Type | Labels (bounded) | Source |
| --- | --- | --- | --- |
| `token_auth_failure_total` | counter | `reason: "expired"\|"invalid"\|"dpop_mismatch"\|"principal_mismatch"\|"scope_denied"` (5 bounded values) | Auth middleware |
| `cedar_deny_total` | counter | `policy_family: "session"\|"membership"\|"runtime_node"\|"artifact"\|"admin"` (bounded; owned by ADR-012) | Cedar authorization layer |
| `relay_connection_churn_total` | counter | `phase: "connect"\|"disconnect"\|"reconnect"\|"rejected"` (4 bounded values) | Relay client (mount via Plan-025 relay-side equivalent) |
| `backup_success_total` | counter | `kind: "event_end"\|"nightly"\|"manual"` (3 bounded values) | Backup job (Plan-001/BL-063) |
| `auto_update_check_status` | gauge | none | Update-notify poller (Plan-007 row 7a) — values: `0=ok`, `1=behind`, `2=poll_failed` |
| `retention_policy_override` | gauge | none | Diagnostic-bucket retention policy (T2.7) — values: `0` = no TTL override beyond 30 days, `1` = an override > 30 days is active; re-asserted on every daemon startup and on every policy read (I-020-3). Plan-owned per [Spec-020 §PII in Diagnostics](../specs/020-observability-and-failure-recovery.md#pii-in-diagnostics); outside the row-9a set |

**Rate-limit families are control-plane-side, not daemon-side (Tier-6 audit, Plan-021 D-021-8).** The daemon has no rate-limit enforcer — [Spec-021 §Scope](../specs/021-rate-limiting-policy.md#scope) excludes the local IPC path, and its AC-8 asserts the daemon path is never rate-limited — so the former daemon-side `rate_limit_trip_total{bucket}` family is removed from this table. The canonical rate-limit family set (`rate_limit_trip_total{endpoint,tier}`, `rate_limit_block_total{window_size}`, `rate_limit_backend_error_total{backend}`, `rate_limit_failclosed_total{backend}`, `admin_ban_total{action}`) is owned by [Plan-021](./021-rate-limiting-policy.md#ratified-design-decisions-tier-6-audit), registered + emitted control-plane-side under this section's label invariants (Plan-021 CP-021-4), and exposed on the self-host relay `GET /metrics` by Plan-025 (Spec-027 row 9b); hosted exposition is an explicit V1 gap (Plan-021 D-021-15).

**PII-free-by-construction invariants (I-020-2).**

- Labels MUST NEVER carry: raw participant IDs, session IDs, invite codes, command text, file paths, URLs, tokens, or any free-form content.
- Labels MUST be enumerable at compile time — no dynamic label values. Tests assert the full label cardinality per family is bounded by the documented allow-list.
- Any attempt to emit a label value outside the allow-list MUST throw at emission time, not silently coerce. Emission-time enforcement prevents accidental PII bleed when a new code path adds a metric observation.

**Cardinality ceiling (I-020-1).** Total emitted series across all six registered families MUST stay below 200 per daemon instance (the label-less `retention_policy_override` gauge contributes exactly one series). Series-count assertion runs in integration tests; exceeding the ceiling is a violation of I-020-1 (not a warning), blocking merge until the allow-list tightens.

## Data And Storage Changes

- Add daemon-owned health projections and failure-detail records derived from canonical events, replay state, and provider diagnostics.
- Add recovery-action audit records and surfaced health snapshots needed for operators and user-facing projections.
- Add the 4 diagnostic-bucket tables (`driver_raw_events`, `command_output`, `tool_traces`, `reasoning_detail`) to Local Runtime Daemon SQLite with TTL-purge and participant-scoped purge indices per [Local SQLite Schema §Diagnostic Bucket Tables](../architecture/schemas/local-sqlite-schema.md#diagnostic-bucket-tables-plan-020). These are runtime-local; they have no shared-Postgres counterpart per [ADR-017](../decisions/017-shared-event-sourcing-scope.md).
- Add bounded-retention handling for raw diagnostic payload classes so compaction never removes canonical health or failure truth.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for the shared `health_snapshots` column definitions; diagnostic bucket column definitions live in the Local SQLite schema because raw diagnostics never leave the daemon by default.

## API And Transport Changes

- Add `HealthStatusRead`, `FailureDetailRead`, `StuckRunInspect`, and `RecoveryActionRequest` to the typed client SDK and daemon contracts. Each operation — these four plus the `DiagnosticRedactionPolicy` policy-state read below — is callable over exactly one registered wire method: the five `health.*` dotted-camelCase strings recorded in the [Health Method-Name Registry](../architecture/contracts/api-payload-contracts.md#health-method-name-registry-tier-8-plan-020-t14) (`health.statusRead`, `health.failureDetailRead`, `health.stuckRunInspect`, `health.recoveryActionRequest`, `health.redactionPolicyRead`), exported as contracts constants by T1.4 and registered against the Plan-007-partial daemon `MethodRegistry` with handler wiring by T2.10. Daemon JSON-RPC transport only — no tRPC sibling; the control-plane dependency-health read is merged daemon-side (T2.3).
- **`RunFailureCategory` is a closed four-arm union — Plan-020 consumes it, never extends it.** The arms are exactly `"provider failure"`, `"transport failure"`, `"local persistence failure"`, and `"projection failure"`, defined in [API Payload Contracts §Shared Enums](../architecture/contracts/api-payload-contracts.md#shared-enums), described in [Run State Machine](../domain/run-state-machine.md), consumed as a closed set by [Plan-015](./015-persistence-recovery-and-replay.md) (Tier-7 audit, A-015-4 pinned the category → recovery-state mapping), and embedded in the Spec-006 `run.*` state-transition payload as `failureCategory?`. `FailureDetailRead.failureCategory` imports that enum under the same `failureCategory` carrier name the Spec-006 payload and `RecoveryStatusReadResponse` already use. Adding a fifth arm is therefore a cross-plan contract change touching the contracts mirror, Spec-006's payload shape, and Plan-015's mapping — never a Plan-020-local edit.
- **Policy or approval blockage is not a failure category.** [Spec-020 §Required Behavior](../specs/020-observability-and-failure-recovery.md#required-behavior) lists it fifth among the conditions operators must distinguish, but a policy-blocked run has not failed, so it is surfaced as a blocking reason on the stuck-run surface — `StuckRunInspectResponse.blockingReason` in the contracts mirror — rather than as a fifth `RunFailureCategory` arm. Its operational handling belongs to the Spec-012 approval-UX surfaces per [Spec-020 §Implementation Notes](../specs/020-observability-and-failure-recovery.md#implementation-notes), so Plan-020 renders the blockage and links out rather than owning a blockage runbook. The count asymmetry (five distinguishable conditions, four failure categories) is intended and must not be "fixed" by widening the enum.
- Add `DiagnosticRedactionPolicy` contract: operator-readable current policy, opt-in toggles per bucket, and `retention_policy_override` warning surface. Default state is deny-outbound, ≤ 7-day TTL, no raw-content capture.
- Expose control-plane dependency health in a form that can be merged with daemon-owned observability projections.
- Add Prometheus `/metrics` endpoint (Spec-027 row 9) on the daemon with the bind/auth secure-default contract documented in §Prometheus `/metrics` Exposition above. Plan-025 mounts an equivalent relay-side `/metrics` endpoint using the same auth gate and metric-family allow-list shape.

## Invariants

Load-bearing constraints every Plan-020 PR — and every downstream extension — must preserve. Weakening or removing one is a coordinated cross-plan amendment, not a local edit. Each entry names the governing clause it grounds in, or declares itself plan-owned.

- **I-020-1 — The daemon `/metrics` cardinality ceiling is a merge gate, not a warning.** Total emitted series across the six registered daemon families — the five row-9a families plus the `retention_policy_override` warning gauge — stays below 200 per daemon instance. An integration test asserts the live series count; exceeding the ceiling blocks merge until the label allow-list tightens, rather than emitting a warning and shipping. **Grounds in.** [Spec-027 §Required Behavior](../specs/027-self-host-secure-defaults.md#required-behavior) row 9a states the ceiling ("cardinality ceiling < 200 series per daemon instance"). The merge-blocking enforcement posture layered on top of it is **plan-owned**: the spec states the ceiling but no enforcement mechanism for it. **Why load-bearing.** A metrics endpoint that degrades gracefully past its ceiling degrades silently — series growth is monotonic in practice, so a warning is observed once and then ignored while scrape cost and daemon memory grow unbounded on operator hardware nobody is watching. **Verification.** T3.4.
- **I-020-2 — Metric labels are PII-free by construction, enforced at emission time.** Label values come from a closed, compile-time-enumerable allow-list per family; no label value derives from participant IDs, session IDs, invite codes, command text, file paths, URLs, tokens, or any free-form content; an out-of-allow-list value throws at emission time rather than being silently coerced or truncated. **Grounds in.** [Spec-027 §Required Behavior](../specs/027-self-host-secure-defaults.md#required-behavior) row 9a ("Labels MUST be bounded and PII-free"), serving the default-deny posture of [Spec-020 §PII in Diagnostics](../specs/020-observability-and-failure-recovery.md#pii-in-diagnostics). The closed allow-list plus emission-time throw is the **plan-owned** enforcement mechanism for that MUST — the spec states the property, not how it is detected. **Why load-bearing.** `/metrics` is scraped by systems outside the daemon's trust boundary; a single dynamic label value leaks PII to every scraper and every retained scrape sample simultaneously, and truncating or masking it does not help because partial PII is still PII per Spec-020. Throwing at emission converts a silent leak into a loud test failure at the moment a new code path adds an observation. **Verification.** T3.1.
- **I-020-3 — Diagnostic-bucket retention is TTL-bounded at ≤ 7 days by default, and any longer override announces itself.** All four buckets (`driver_raw_events`, `command_output`, `tool_traces`, `reasoning_detail`) default to a ≤ 7-day TTL; an operator override beyond 30 days emits the `retention_policy_override` warning metric on every daemon startup and on every policy read. **Grounds in.** [Spec-020 §PII in Diagnostics](../specs/020-observability-and-failure-recovery.md#pii-in-diagnostics) ("Bounded local retention"), with the storage-and-shred side owned by [Spec-022 §PII Data Map](../specs/022-data-retention-and-gdpr.md#pii-data-map)'s bounded-retention tier. **Why load-bearing.** The buckets capture full prompts, full command arguments, and full tool results by the nature of their purpose; unbounded retention turns diagnostics into an Article-17 escape hatch where erasure obligations are satisfied on canonical stores while the same content persists indefinitely beside them. Repeating the warning on every policy read (not once at startup) is what keeps a long override visible to the operator who inherits the deployment. **Verification.** T2.7.
- **I-020-4 — Diagnostics are default-deny outbound; raw content leaves only on explicit per-bucket opt-in.** No diagnostic-bucket row content leaves the daemon host unless that bucket's raw-content opt-in is explicitly enabled with a durable authorization record; otherwise outbound telemetry carries summary-only signals (counts, categories, durations) constructed from non-PII inputs rather than truncated from free text. Enabling the opt-in is never retroactive: previously captured data is not released by flipping the toggle. **Grounds in.** [Spec-020 §PII in Diagnostics](../specs/020-observability-and-failure-recovery.md#pii-in-diagnostics) ("Default-deny on outbound telemetry", "Opt-in for raw content", "Summary-only retention"). **Why load-bearing.** Egress is the irreversible step — once a prompt reaches a third-party sink, neither TTL purge nor crypto-shred can reach it, so the default must be deny and the exception must be a recorded operator decision rather than a config default nobody chose. **Verification.** T2.8.
- **I-020-5 — A Path-3 participant-scoped flush reaches all four diagnostic buckets.** A participant-purge request triggers immediate purge of that participant's rows in every one of the four buckets, ahead of the TTL that would otherwise expire them; no bucket is exempt, and adding a fifth diagnostic bucket without a Path-3 flush path is a violation. **Grounds in.** [Spec-020 §PII in Diagnostics](../specs/020-observability-and-failure-recovery.md#pii-in-diagnostics) ("Shred fan-out coverage") and [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md#shred-fan-out) Path 3. **Why load-bearing.** Coverage is all-or-nothing: one bucket outside the fan-out's reach makes the erasure guarantee false for every participant, and the gap is invisible from the shred side because the fan-out reports success over the buckets it knows about. This invariant is the Plan-020 half of CP-020-2. **Verification.** T2.9.

## Cross-Plan Obligations

Each entry transcribes an obligation already committed in the named counterparty's text; none is authored here. See [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) for the graph-level view.

### CP-020-1 — Metric-family label invariants are a doc contract Plan-021 registers against (⇄ Plan-021 CP-021-4)

**Obligation.** Plan-021 registers its canonical control-plane `rate_limit_*` metric families against this plan's §Prometheus `/metrics` Exposition label invariants — bounded, compile-time-enumerable label values, PII-free by construction, emission-time enforcement (I-020-2). Plan-021 records the relationship as `consumes ←` and scopes it explicitly: a **doc contract only, with no Plan-020 code consumed and therefore no tier inversion** despite Plan-021 sitting at Tier 6 and Plan-020 at Tier 8.

**Resolution.** Live and reciprocal. Plan-021's side is CP-021-4; the reciprocal recorded there is that Plan-021's canonical family set supersedes the former daemon-side `rate_limit_trip_total{bucket}` registry row (D-021-8, Tier-6 audit) — the supersession this plan's §Prometheus `/metrics` Exposition already carries and its 2026-06-10 Notes entry records. Plan-020 owes Plan-021 a stable label-invariant contract, not code; a change to the invariants is a cross-plan amendment because Plan-021's registrations are validated against them.

### CP-020-2 — The four diagnostic buckets are Path-3 shred targets (⇄ Plan-022 CP-022-7)

**Obligation.** Plan-020's four diagnostic buckets accept per-participant scoped flush as Path-3 targets of the crypto-shred fan-out. Plan-022 records the reciprocal as **live** (Spec-020 bounded-retention) and verifies it on its own side at code time.

**Resolution.** Live and reciprocal. Plan-020's half is I-020-5, implemented by T2.9 — every bucket exposes a participant-scoped purge path with the index support added in T2.1. Plan-022 owns the fan-out driver and the Path-3 enumeration; Plan-020 owns each bucket's flush entry point. A new diagnostic bucket added by either side requires both halves to move together.

### CP-020-3 — Audit-integrity events feed the audit-health surface (⇄ Plan-006 CP-006-10)

**Obligation.** Plan-006 forward-declared that Plan-020 SHOULD consume three audit-integrity events — `audit_integrity_verified`, `audit_integrity_failed`, `key_reuse_detected` — for an audit-health dashboard, and stated that the obligation is **binding when Plan-020 is authored**. Plan-020 is authored, so the condition has fired and the obligation is binding.

**Resolution.** Binding; consumption mechanism **not yet designed**. This entry records the obligation and the three event names only. Plan-020 does not here declare which surface consumes them, whether they map to a metric family (they are not among the five row-9a families, so a new family would require the amendment §Prometheus `/metrics` Exposition already demands), or what the dashboard shape is — that design is owed by a future Plan-020 amendment and must not be inferred from this entry. Plan-006 owns event emission and naming; Plan-020 owes the consuming surface.

### CP-020-4 — Plan-025 wires the relay `/metrics` endpoint to this plan's bind/auth contract (⇄ Plan-025, Spec-027 row 9b)

**Obligation.** Spec-027 row 9b is a split case, recorded in Plan-025's own ownership list: **Plan-020 owns the bind/auth contract plus the counter-family schema; Plan-025 owns the relay endpoint wiring.** Plan-025 consumes this plan's §Prometheus `/metrics` Exposition contract for the relay endpoint — loopback default, parse-time refusal of a non-loopback `METRICS_BIND` without auth, the `METRICS_AUTH=bearer` / `METRICS_AUTH=mtls` gate, the `METRICS_BIND=off` disable path with its banner and `security.default.override=metrics_disabled` event, and PII-free label enforcement — and parses `METRICS_BIND` / `METRICS_AUTH` in its own config loader against that contract.

**Resolution.** Live and reciprocal; contract-shape consumption, not code reuse. Row 9a (daemon endpoint) is wholly Plan-020's, and Plan-025's ownership list names it as explicitly not-Plan-025. Plan-020 therefore keeps the bind/auth posture in one place so both surfaces present one auditable secure default — the rationale Spec-027 row 9b itself records. A change to the bind/auth contract is a cross-plan amendment because Plan-025's relay endpoint and config loader both validate against it.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define health-status, failure-category, recovery-condition, stuck-run inspection, and `DiagnosticRedactionPolicy` contracts.
2. Implement daemon-owned health and failure-detail projections derived from canonical state and provider diagnostics.
3. Implement safe recovery-action request handling and audit recording.
4. Implement bounded-retention policy handling for raw diagnostics without weakening canonical diagnosis surfaces. Wire default-deny outbound telemetry for all 4 diagnostic buckets; expose per-bucket opt-in raw-content capture with explicit operator acknowledgement; emit `retention_policy_override` warning metric when TTL override > 30 days.
5. Implement Prometheus `/metrics` endpoint with the six registered daemon metric families (the five row-9a families plus the `retention_policy_override` warning gauge), bounded label sets, bearer/mTLS auth gate for non-loopback `METRICS_BIND`, and emission-time label enforcement (`metrics-exposition.ts`, `metrics-registry.ts`, `metrics-auth.ts`).
6. Add desktop recovery and health surfaces that distinguish runtime state, failure categories, and degraded modes without requiring raw logs.

## Implementation Phase Sequence

Four phases decompose the six §Implementation Steps above; nothing here is new design. Phase 1 covers Step 1; Phase 2 covers Steps 2-4; Phase 3 covers Step 5; Phase 4 covers Step 6. Phase 1 has no unsatisfied upstream code dependency beyond the Tier-8 audit; Phases 2-4 serialize behind their predecessors. Migration ordinals are written `0NNN` and resolve to the next free number in the target migration directory at implementation time, per the shared-numbering convention.

### Phase 1 — Health, failure, and recovery contracts

**Precondition:** Tier-8 plan-readiness audit complete. Implementation Step 1; gates every later phase, which all type against these shapes.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 318, baseline_tag: "plan-readiness-audit-tier-8" }
```

#### Tasks

- **T1.1 — `HealthStatusRead` + `FailureDetailRead` contracts.**
  - **Files:** `packages/contracts/src/health/health.ts` (CREATE), `packages/contracts/src/index.ts` (EXTEND — barrel re-export per the existing convention)
  - Zod schemas + inferred types for `HealthStatusRead` (daemon / control-plane / provider / replay health over the `healthy` / `degraded` / `blocked` status categories) and `FailureDetailRead` (machine-readable failure category, optional recovery condition, human-readable summary). `FailureDetailRead.failureCategory` **imports** `RunFailureCategory` from the canonical contracts mirror; it never redefines the union, and the four arms are closed per §API And Transport Changes above — a fifth arm is a cross-plan contract change, not a Plan-020 edit. Policy or approval blockage is deliberately not an arm; it surfaces as `blockingReason` on T1.2's stuck-run shape.
  - **Tests:** `packages/contracts/src/__tests__/health.test.ts` (CREATE) — parse-accept one fixture per shape; parse-reject a status outside the three categories; parse-reject a `failureCategory` outside the four `RunFailureCategory` arms (the closure regression); assert the package-root barrel resolves both schemas.
  - **Acceptance:** canonical `RunState` is representable independently of health status and failure category; no shape lets a caller conflate them.
  - **Spec coverage:** Spec-020 §Interfaces And Contracts, Spec-020 §Default Behavior
  - **Verifies invariant:** none (contract-shape task; the metric and retention invariants bind in Phases 2-3)
  - **Consumes:** `RunFailureCategory` ← [API Payload Contracts §Shared Enums](../architecture/contracts/api-payload-contracts.md#shared-enums) (closed four-arm union; import only)

- **T1.2 — `StuckRunInspect` + `RecoveryActionRequest` contracts.**
  - **Files:** `packages/contracts/src/health/health.ts` (EXTEND — same file as T1.1)
  - Zod schemas + inferred types for the stuck-run inspection request/response (last known progress point, last event time, optional `blockingReason`, and whether the run is currently `stuck-suspected`) and for `RecoveryActionRequest` (operator-triggered retry where policy allows). `blockingReason` is the surface a policy- or approval-blocked run renders through; it stays optional so a non-blocked stuck run omits it rather than carrying a sentinel.
  - **Tests:** `packages/contracts/src/__tests__/health.test.ts` (EXTEND) — parse-accept a stuck-suspected fixture with and without `blockingReason`; parse-reject a response missing the last-progress point; assert `RecoveryActionRequest` cannot be constructed without naming its target run.
  - **Acceptance:** the 60-second stuck-suspected threshold and its 5-minute health escalation are both representable without a new run state.
  - **Spec coverage:** Spec-020 §Interfaces And Contracts, Spec-020 §Default Behavior
  - **Verifies invariant:** none (contract-shape task; recovery-action enforcement binds on T2.6)
  - **Consumes:** `HealthStatusRead` / `FailureDetailRead` ← T1.1 (same phase)

- **T1.3 — `DiagnosticRedactionPolicy` policy-state read contract.**
  - **Files:** `packages/contracts/src/health/health.ts` (EXTEND — same file as T1.1)
  - Operator-readable policy _state_ only: current TTL per bucket, per-bucket opt-in toggle state, and the `retention_policy_override` warning surface. Default state is deny-outbound with a ≤ 7-day TTL and no raw-content capture. The redaction _decision logic_ is deliberately not published as a contract — see §PII in Diagnostics above.
  - **Tests:** `packages/contracts/src/__tests__/health.test.ts` (EXTEND) — parse-accept the default policy state; assert the default fixture is deny-outbound with TTL ≤ 7 days; parse-reject a policy state naming a bucket outside the four.
  - **Acceptance:** an operator can read the effective policy without the contract exposing any redaction rule a caller could evaluate or override.
  - **Spec coverage:** Spec-020 §PII in Diagnostics
  - **Verifies invariant:** none (surfaces policy state; I-020-3 and I-020-4 are enforced by T2.7 and T2.8)
  - **Consumes:** the four bucket names ← [Spec-022 §PII Data Map](../specs/022-data-retention-and-gdpr.md#pii-data-map) bounded-retention tier (doc contract)

- **T1.4 — `health.*` wire method-name registration.**
  - **Files:** `packages/contracts/src/health/health.ts` (EXTEND — same file as T1.1)
  - Export the five `health.*` method-name constants — `health.statusRead`, `health.failureDetailRead`, `health.stuckRunInspect`, `health.recoveryActionRequest`, `health.redactionPolicyRead` — matching the [Health Method-Name Registry](../architecture/contracts/api-payload-contracts.md#health-method-name-registry-tier-8-plan-020-t14) one-to-one, so every Plan-020 operation resolves a registered wire method string rather than merely a schema name. Daemon JSON-RPC transport only — no tRPC sibling exists; the control-plane dependency-health read is merged daemon-side by T2.3.
  - **Tests:** `packages/contracts/src/__tests__/health.test.ts` (EXTEND) — each constant matches the Tier-1 `METHOD_NAME_FORMAT` regex imported from `packages/contracts/src/jsonrpc-registry.ts` (never a re-declared copy); the five strings are pairwise distinct and cover the five operations one-to-one.
  - **Acceptance:** a client can name every health operation by wire method string from the contracts package alone — no daemon import, no string literal at call sites.
  - **Spec coverage:** Spec-020 §Interfaces And Contracts
  - **Verifies invariant:** none (naming task; daemon registration and handler wiring land in T2.10)
  - **Consumes:** `METHOD_NAME_FORMAT` ← `packages/contracts/src/jsonrpc-registry.ts` (BL-142 single source); the `health` namespace-root admission ← [API Payload Contracts §JSON-RPC Method-Name Registry (Tier 1 Ratified)](../architecture/contracts/api-payload-contracts.md#json-rpc-method-name-registry-tier-1-ratified)

### Phase 2 — Daemon health projections, recovery actions, and diagnostic-bucket retention

**Precondition:** Phase 1 merged. Implementation Steps 2-4.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 318, baseline_tag: "plan-readiness-audit-tier-8" }
  - { type: plan_phase, plan: 020, phase: 1, status: merged }
```

#### Tasks

- **T2.1 — Diagnostic-bucket tables migration.**
  - **Files:** `packages/runtime-daemon/src/migrations/0NNN-diagnostic-buckets.ts` (CREATE), `docs/architecture/schemas/local-sqlite-schema.md` (EXTEND — doc mirror)
  - CREATE the four bucket tables `driver_raw_events`, `command_output`, `tool_traces`, `reasoning_detail` with TTL-purge indices and participant-scoped purge indices, matching the column definitions the Local SQLite schema already documents. Runtime-local only — no shared-Postgres counterpart, per ADR-017.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/migration-shape.test.ts` (CREATE) — all four tables exist after migration; each carries both a TTL index and a participant-scoped index; no bucket table appears in the control-plane migration chain.
  - **Acceptance:** a participant-scoped purge can be indexed rather than table-scanned on every bucket — the storage precondition I-020-5 needs.
  - **Spec coverage:** Spec-020 §State And Data Implications
  - **Verifies invariant:** none (schema task; I-020-5 is verified by T2.9)
  - **Consumes:** the daemon migration runner ← Plan-001 (shipped Tier 1)

- **T2.2 — `health_snapshots` shared-Postgres columns.**
  - **Files:** `packages/control-plane/src/migrations/0NNN-health-snapshots.ts` (CREATE), `docs/architecture/schemas/shared-postgres-schema.md` (EXTEND — doc mirror)
  - Add the shared `health_snapshots` columns the schema doc defines, so surfaced health is queryable when no timeline UI is open. Raw diagnostics stay daemon-local and are not mirrored here.
  - **Tests:** `packages/control-plane/src/migrations/__tests__/migration-shape.test.ts` (EXTEND) — `health_snapshots` matches the documented column set; no diagnostic-bucket table is created control-plane-side.
  - **Acceptance:** health remains queryable without opening a timeline; no raw diagnostic payload reaches shared Postgres.
  - **Spec coverage:** Spec-020 §State And Data Implications
  - **Verifies invariant:** none (schema task)
  - **Consumes:** the control-plane migration runner ← Plan-001 (shipped Tier 1)

- **T2.3 — Health-status projection service.**
  - **Files:** `packages/runtime-daemon/src/observability/health-status-service.ts` (CREATE), `packages/control-plane/src/health/` (CREATE — control-plane dependency-health read)
  - Derive `HealthStatusRead` from canonical events, replay state, queue state, and provider diagnostics; expose control-plane dependency health in a form mergeable with the daemon-owned projection. Replay-rebuild state surfaces as `blocked` read-only rather than as a silent partial-mutation window.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/health-status-service.test.ts` (CREATE) — healthy / degraded / blocked fixtures; a failed projection rebuild yields `blocked` read-only and refuses new mutable work; control-plane unavailability degrades without erasing daemon-local health.
  - **Acceptance:** health is derived from canonical state only — never from a raw diagnostic bucket, which may already have expired.
  - **Spec coverage:** Spec-020 §Required Behavior, Spec-020 §Fallback Behavior
  - **Verifies invariant:** none (projection task)
  - **Consumes:** `HealthStatusRead` ← T1.1; replay + projection state ← [Plan-015](./015-persistence-recovery-and-replay.md)

- **T2.4 — Failure-detail projection service.**
  - **Files:** `packages/runtime-daemon/src/observability/failure-detail-service.ts` (CREATE)
  - Derive `FailureDetailRead` from canonical state and provider diagnostics, mapping each failure onto exactly one of the four closed `RunFailureCategory` arms with an optional recovery condition. A failed provider recovery stays visible as canonical `failed` with `provider failure` detail and a `recovery-needed` condition rather than disappearing.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/failure-detail-service.test.ts` (CREATE) — one fixture per category; a provider-recovery failure remains visible with the recovery condition set; no code path emits a category string outside the four arms.
  - **Acceptance:** every surfaced failure carries a machine-readable category; no failure is flattened into a generic provider error.
  - **Spec coverage:** Spec-020 §Required Behavior, Spec-020 §Fallback Behavior
  - **Verifies invariant:** none (projection task)
  - **Consumes:** `FailureDetailRead` ← T1.1; `RunFailureCategory` ← [API Payload Contracts §Shared Enums](../architecture/contracts/api-payload-contracts.md#shared-enums)

- **T2.5 — Stuck-run inspector.**
  - **Files:** `packages/runtime-daemon/src/observability/stuck-run-inspector.ts` (CREATE)
  - Mark a run `stuck-suspected` after 60 seconds without new progress events and escalate to a health signal after 5 minutes. A policy- or approval-blocked run populates `blockingReason` and is exempt from false-positive escalation — it is blocked, not stuck, and its operational handling belongs to the Spec-012 approval surfaces.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/stuck-run-inspector.test.ts` (CREATE) — threshold and escalation timing; a blocked run reports `blockingReason` and does not escalate as stuck; a run emitting progress never trips.
  - **Acceptance:** stuck suspicion is visible without opening raw logs, and blocked runs are not misreported as stuck.
  - **Spec coverage:** Spec-020 §Default Behavior, Spec-020 §Required Behavior
  - **Verifies invariant:** none (projection task)
  - **Consumes:** the stuck-run inspection shape ← T1.2

- **T2.6 — Recovery-action handling and audit records.**
  - **Files:** `packages/runtime-daemon/src/observability/recovery-action-service.ts` (CREATE)
  - Handle `RecoveryActionRequest` for the safe operator-triggered retry path and write a durable audit record for every action and outcome. Retry uses the single product-defined bounded policy — drivers may mark a failure non-retryable but do not define independent retry budgets.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/recovery-action-service.test.ts` (CREATE) — provider, replay, and persistence failure scenarios; a driver-marked non-retryable failure is refused rather than retried; every action and outcome produces an audit record; recovery failures stay visible until resolved.
  - **Acceptance:** recovery actions are auditable and bounded; a failed recovery never resolves itself silently.
  - **Spec coverage:** Spec-020 §State And Data Implications, Spec-020 §Fallback Behavior
  - **Verifies invariant:** none (the retry-policy bound is a Spec-020 resolved-question decision; enforcement is local to this task)
  - **Consumes:** `RecoveryActionRequest` ← T1.2; failure categories ← T2.4

- **T2.7 — Diagnostic-bucket TTL retention and `retention_policy_override`.**
  - **Files:** `packages/runtime-daemon/src/observability/diagnostic-buckets/` (CREATE — one TTL-bucket implementation per bucket plus the shared purge driver)
  - Apply the ≤ 7-day default TTL to all four buckets; support a per-deployment override; emit the `retention_policy_override` warning metric on every daemon startup and on every policy read when the override exceeds 30 days. Compaction of raw diagnostics never removes canonical health or failure truth.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/diagnostic-buckets.test.ts` (CREATE) — each bucket expires rows at or before the configured TTL; an override > 30 days emits the warning on startup and on each policy read (not once); compaction leaves canonical failure detail and recovery visibility intact.
  - **Acceptance:** no bucket retains rows past its TTL, and a long override is impossible to hold quietly.
  - **Spec coverage:** Spec-020 §PII in Diagnostics, Spec-020 §Fallback Behavior
  - **Verifies invariant:** I-020-3
  - **Consumes:** bucket tables ← T2.1; policy-state shape ← T1.3

- **T2.8 — Default-deny outbound gate and per-bucket raw-content opt-in.**
  - **Files:** `packages/runtime-daemon/src/observability/diagnostic-redaction-policy.ts` (CREATE)
  - Gate all four buckets on default-deny outbound: bucket row content leaves the host only when that bucket's opt-in is explicitly enabled with a durable authorization record naming sink, field set, and authorizing operator. Otherwise outbound telemetry carries summary-only signals constructed from non-PII inputs. Flipping the toggle is never retroactive. Redaction decision logic stays code-local with no wire contract per §PII in Diagnostics.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/diagnostic-redaction-policy.test.ts` (CREATE) — no bucket row content appears in any outbound payload without the matching opt-in; the opt-in requires operator acknowledgement and is audited; a flipped toggle does not release previously captured data; summary fields are constructed rather than truncated from free text.
  - **Acceptance:** the deny path is the default in every code path that can egress, not a configuration an operator must remember to set.
  - **Spec coverage:** Spec-020 §PII in Diagnostics
  - **Verifies invariant:** I-020-4
  - **Consumes:** policy-state shape ← T1.3; bucket implementations ← T2.7

- **T2.9 — Path-3 participant-scoped flush across all four buckets.**
  - **Files:** `packages/runtime-daemon/src/observability/diagnostic-buckets/` (EXTEND — participant-scoped flush entry point per bucket)
  - Each bucket exposes a participant-scoped flush that the crypto-shred fan-out calls as a Path-3 target, purging that participant's rows ahead of TTL. This is the Plan-020 half of CP-020-2; Plan-022 owns the fan-out driver.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/diagnostic-buckets.test.ts` (EXTEND) — a participant-purge request purges that participant's rows in every one of the four buckets ahead of TTL; a bucket without a registered flush entry point fails the coverage assertion rather than being skipped silently.
  - **Acceptance:** Path-3 coverage is asserted over the bucket set, so adding a fifth bucket without a flush path fails the test rather than shipping a silent erasure gap.
  - **Spec coverage:** Spec-020 §PII in Diagnostics
  - **Verifies invariant:** I-020-5
  - **Consumes:** bucket implementations ← T2.7; the Path-3 fan-out contract ← [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md#shred-fan-out) (CP-020-2)

- **T2.10 — `health.*` daemon JSON-RPC handlers.**
  - **Files:** `packages/runtime-daemon/src/observability/health-method-handlers.ts` (CREATE)
  - Register the five T1.4 method strings against the Plan-007-partial daemon `MethodRegistry` (the `repo.*` / `approval.*` / `timeline.*` registration path) and dispatch each to its Phase-2 service: `health.statusRead` → T2.3, `health.failureDetailRead` → T2.4, `health.stuckRunInspect` → T2.5, `health.recoveryActionRequest` → T2.6, `health.redactionPolicyRead` → the T2.8 policy-state read. Every request and response is validated through the Phase-1 Zod schemas at the handler boundary — no shape crosses the wire unparsed.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/health-method-handlers.test.ts` (CREATE) — each of the five strings resolves through the registry to a handler that round-trips its contract shapes; a malformed request is refused with a typed error, never dispatched; the recovery-action handler writes through T2.6 so the audit record is not bypassable via the wire path.
  - **Acceptance:** every Plan-020 operation is callable end-to-end over daemon JSON-RPC; no health surface is reachable except through a registered method.
  - **Spec coverage:** Spec-020 §Interfaces And Contracts
  - **Verifies invariant:** none (transport wiring; the services it dispatches to carry their own tasks' invariants)
  - **Consumes:** the five method-name constants ← T1.4; services ← T2.3, T2.4, T2.5, T2.6, T2.8; the `MethodRegistry` substrate ← Plan-007-partial (shipped Tier 1)

### Phase 3 — Prometheus `/metrics` exposition

**Precondition:** Phase 2 merged. Implementation Step 5; the endpoint reports on surfaces Phase 2 creates.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 318, baseline_tag: "plan-readiness-audit-tier-8" }
  - { type: plan_phase, plan: 020, phase: 2, status: merged }
```

#### Tasks

- **T3.1 — `metrics-registry.ts`: allow-listed families with bounded labels.**
  - **Files:** `packages/runtime-daemon/src/observability/metrics-registry.ts` (CREATE)
  - Register exactly the six families §Prometheus `/metrics` Exposition documents — the five row-9a daemon families (the D-021-8-ratified set, unchanged) plus the plan-owned `retention_policy_override` warning gauge (label-less; the family I-020-3 / T2.7 require) — with their documented bounded label sets. Label values are compile-time enumerable; emitting a value outside the allow-list throws rather than coercing — for the label-less gauge, emitting any label at all throws. No rate-limit family is registered daemon-side — those are control-plane-side per D-021-8.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/metrics-registry.test.ts` (CREATE) — one negative unit test per family asserting an out-of-allow-list label value throws at emission time (for `retention_policy_override`, that any label at all throws); the registry exposes exactly six families — the five row-9a families plus `retention_policy_override`; no label value derives from participant ids, session ids, invite codes, command text, file paths, URLs, or tokens.
  - **Acceptance:** the registry is the only place a family or label can be introduced, so widening the surface is a reviewable diff.
  - **Spec coverage:** Spec-027 §Required Behavior
  - **Verifies invariant:** I-020-2
  - **Consumes:** the canonical control-plane family set ← [Plan-021](./021-rate-limiting-policy.md) (CP-020-1 — label-invariant doc contract; no daemon registration); the `retention_policy_override` emission site ← T2.7 (Phase 2 — the family registered here is the one T2.7's warning emissions ride)

- **T3.2 — `metrics-exposition.ts`: the `GET /metrics` endpoint.**
  - **Files:** `packages/runtime-daemon/src/observability/metrics-exposition.ts` (CREATE)
  - Serve Prometheus v0.0.4 exposition (`text/plain; version=0.0.4; charset=utf-8`), accepting OpenMetrics where a client negotiates it via `Accept:`.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/metrics-exposition.test.ts` (CREATE) — exposition output round-trips through a reference parser; OpenMetrics negotiation is honored; only registered families appear in the output.
  - **Acceptance:** a stock Prometheus scraper reads the endpoint with no vendor-specific handling.
  - **Spec coverage:** Spec-027 §Required Behavior
  - **Verifies invariant:** none (format task; the label and cardinality invariants bind on T3.1 and T3.4)
  - **Consumes:** registered families ← T3.1

- **T3.3 — `metrics-auth.ts`: bind and auth secure-default gate.**
  - **Files:** `packages/runtime-daemon/src/observability/metrics-auth.ts` (CREATE)
  - Default `METRICS_BIND=127.0.0.1:<port>`. A non-loopback bind without auth is a config-parse-time error. Non-loopback requires either `METRICS_AUTH=bearer` with the token file `METRICS_AUTH_TOKEN_FILE` or `METRICS_AUTH=mtls` with the client CA `METRICS_TLS_CLIENT_CA_FILE` plus the SPKI-SHA256 fingerprint allow-list `METRICS_TLS_CLIENT_ALLOWLIST_FILE`, and in both modes the non-loopback listener serves TLS from `METRICS_TLS_CERT_FILE` / `METRICS_TLS_KEY_FILE` — the full credential-input, fail-closed validation, and rotation/reload contract is the credential bullets of §Prometheus `/metrics` Exposition above (token file and allow-list re-read on the authorization path with no accept-both grace window; listener material on restart). `METRICS_BIND=off` disables the endpoint and emits the banner plus a `security.default.override=metrics_disabled` log event exactly once per startup. This is the contract Plan-025 consumes for the relay endpoint per CP-020-4.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/metrics-auth.test.ts` (CREATE) — non-loopback bind without auth fails at parse time with an actionable error; bearer mode rejects missing and wrong tokens and invalidates old tokens on the next request after rotation; mtls mode rejects a client cert absent from the allow-list; `METRICS_BIND=off` disables the endpoint and emits the banner and log event exactly once; one fail-closed parse-time negative per credential variable (`METRICS_AUTH_TOKEN_FILE`, `METRICS_TLS_CERT_FILE`, `METRICS_TLS_KEY_FILE`, `METRICS_TLS_CLIENT_CA_FILE`, `METRICS_TLS_CLIENT_ALLOWLIST_FILE` — missing, unreadable, or empty each refuse startup naming the variable); a mismatched cert/key pair and a zero-entry allow-list are parse-time errors; a token file emptied after startup rejects every scrape rather than serving unauthenticated; an allow-list edit takes effect on the next request without restart.
  - **Acceptance:** every insecure configuration fails at parse time rather than serving and warning.
  - **Spec coverage:** Spec-027 §Required Behavior, Spec-027 §Fallback Behavior
  - **Verifies invariant:** none (the bind and auth defaults are Spec-027 row 9a MUSTs rather than plan-owned invariants)
  - **Consumes:** the endpoint ← T3.2

- **T3.4 — Cardinality-ceiling integration test and CI wiring.**
  - **Files:** `packages/runtime-daemon/src/observability/__tests__/metrics-cardinality.test.ts` (CREATE)
  - Assert total emitted series across the six registered families stays below 200 per daemon instance under a fixture exercising every registered label combination, and wire the assertion into CI so a breach blocks merge.
  - **Tests:** the task is the test — plus a negative control proving the assertion fails when a deliberately unbounded label is registered.
  - **Acceptance:** exceeding the ceiling blocks merge; it never degrades to a warning.
  - **Spec coverage:** Spec-027 §Required Behavior
  - **Verifies invariant:** I-020-1
  - **Consumes:** the registry ← T3.1

### Phase 4 — Client SDK and desktop recovery surfaces

**Precondition:** Phase 3 merged — and per §Parallelization Notes, desktop surfaces wait for stable machine-readable payloads and actionability rules. Implementation Step 6.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 318, baseline_tag: "plan-readiness-audit-tier-8" }
  - { type: plan_phase, plan: 020, phase: 3, status: merged }
```

#### Tasks

- **T4.1 — `healthClient.ts` typed SDK surface.**
  - **Files:** `packages/client-sdk/src/healthClient.ts` (CREATE)
  - Expose health status, failure detail, stuck-run inspection, recovery-action requests, and the `DiagnosticRedactionPolicy` policy-state read over the typed SDK — each SDK operation calling its registered `health.*` wire method (T1.4 strings, T2.10 handlers), never an ad-hoc unregistered string.
  - **Tests:** `packages/client-sdk/src/__tests__/healthClient.test.ts` (CREATE) — each method round-trips its contract shape; a recovery action refused by policy surfaces as a typed error rather than a silent no-op.
  - **Acceptance:** the renderer consumes health exclusively through this client — no ad-hoc daemon calls.
  - **Spec coverage:** Spec-020 §Interfaces And Contracts
  - **Verifies invariant:** none (transport task)
  - **Consumes:** contracts + the five `health.*` method strings ← Phase 1 (T1.4); daemon services + the registered method handlers ← Phase 2 (T2.10)

- **T4.2 — Desktop health and recovery surfaces.**
  - **Files:** `apps/desktop/src/renderer/src/health-and-recovery/` (CREATE)
  - Render runtime state, failure category, degraded and blocked modes, stuck-run suspicion, and the operator-triggered recovery path, keeping canonical `RunState` visually distinct from derived health signals. A blocked run renders its `blockingReason` and links to the approval surface rather than presenting itself as a failure.
  - **Tests:** `apps/desktop/src/renderer/src/health-and-recovery/__tests__/health-and-recovery.test.tsx` (CREATE) — healthy, degraded, and blocked render distinctly; a stuck-suspected run is visible without opening raw logs; a failed recovery stays visible until resolved.
  - **Acceptance:** an operator distinguishes blocked from degraded from healthy, and diagnoses a stuck run, without reading raw logs.
  - **Spec coverage:** Spec-020 §Required Behavior, Spec-020 §Fallback Behavior
  - **Verifies invariant:** none (presentation task)
  - **Consumes:** `healthClient.ts` ← T4.1

## Parallelization Notes

- Contract work and daemon projection work can proceed in parallel once recovery vocabulary is fixed.
- Desktop health surfaces should wait for stable machine-readable payloads and actionability rules.

## Test And Verification Plan

- Health-projection tests for healthy, degraded, and blocked runtime conditions
- Stuck-run detection tests covering thresholds, blocking-state exemptions, and false-positive suppression
- Recovery-action audit and safety tests for provider, replay, and persistence failure scenarios
- Retention tests proving compaction of raw diagnostics does not erase canonical failure detail or recovery visibility
- Outbound-telemetry-default-deny (I-020-4): no diagnostic-bucket row content appears in any outbound payload unless the corresponding per-bucket opt-in is explicitly enabled
- Raw-content-opt-in-explicit-only (I-020-4): opt-in toggle requires operator acknowledgement and is audited; a flipped toggle does not retroactively release previously-captured data
- TTL-bucket-purge-coverage (I-020-3, I-020-5): each of the 4 buckets expires rows at or before the configured TTL; participant-purge requests trigger immediate purge of that participant's rows ahead of TTL per [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md#shred-fan-out) Path 3
- `retention_policy_override` warning emission (I-020-3): any policy read observing TTL > 30 days emits the warning metric on daemon startup and on each policy read
- **/metrics endpoint secure-default tests (Spec-027 row 9):**
  - Default bind is `127.0.0.1`; a non-loopback `METRICS_BIND` without auth fails at config-parse time with actionable error.
  - `METRICS_AUTH=bearer` on non-loopback bind rejects requests without the bearer token and with a wrong bearer token; rotating the token file invalidates old tokens on the next request; the token is read from `METRICS_AUTH_TOKEN_FILE`, and a missing, unreadable, or empty token file is a config-parse-time error (fail closed).
  - `METRICS_AUTH=mtls` on non-loopback bind rejects requests from clients whose cert is not on the operator-provided allow-list; the listener keypair (`METRICS_TLS_CERT_FILE` / `METRICS_TLS_KEY_FILE`), client CA (`METRICS_TLS_CLIENT_CA_FILE`), and fingerprint allow-list (`METRICS_TLS_CLIENT_ALLOWLIST_FILE`) each fail closed at parse time when missing or invalid.
  - `METRICS_BIND=off` disables the endpoint, emits the loud banner, and emits `security.default.override=metrics_disabled` log event exactly once per startup.
  - Cardinality ceiling (I-020-1): integration test asserts total emitted series across the six registered families stays below 200 per daemon instance; exceeding ceiling blocks merge.
  - PII-free label enforcement (I-020-2): attempting to emit a label value outside the documented allow-list throws at emission time (unit test per family).
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

## Progress Log

### Shipment Manifest

<!-- Machine-readable. Housekeeper-emitted, orchestrator-written, preflight-read.
     Schema authoritative in:
       .claude/skills/plan-execution/scripts/lib/manifest.mjs -->

```yaml
manifest_schema_version: 1
shipped: []
```

### Notes

<!-- Per-PR human commentary (round-trips, learnings, partial-ship details). Append-only. -->

- 2026-06-10 — Tier-6 plan-readiness audit (Plan-021 walk, D-021-8): removed the daemon-side `rate_limit_trip_total{bucket}` family from §Prometheus `/metrics` Exposition (the daemon has no rate-limit enforcer per `Spec-021 §Scope` / AC-8) and recorded the supersession note pointing at Plan-021's canonical control-plane family set. Daemon family count 6 → 5; cardinality ceiling unchanged. Spec-027 rows 9a/9b reconciled in the same audit pass.
- 2026-08-10 — Tier-8 plan-readiness audit (PR #318): the plan's dispatch scaffolding was backfilled and one stale-count class was reconciled. **Backfill (records what was already committed; no new design).** §Implementation Phase Sequence decomposes the six §Implementation Steps into four phases with `#### Tasks` blocks and per-phase machine-readable preconditions — Phase 1 covers Step 1, Phase 2 covers Steps 2-4 (widened from the walker's "diagnostic buckets and retention" title so Steps 2-3 are not orphaned by the decomposition), Phase 3 covers Step 5, Phase 4 covers Step 6. §Invariants declares I-020-1..5 (cardinality-ceiling merge gate; PII-free-by-construction labels; ≤ 7-day bucket TTL with override warning; default-deny outbound; Path-3 flush reaching all four buckets), each grounded in a named spec clause or declared plan-owned, with §Prometheus `/metrics` Exposition, §Test And Verification Plan, and §Done Checklist repointed at the ids. §Cross-Plan Obligations declares CP-020-1..4 by transcribing the counterparties' committed text — Plan-021 CP-021-4 (label-invariant doc contract), Plan-022 CP-022-7 (Path-3 fan-out), Plan-006 CP-006-10 (forward declaration now fired: the obligation and the three event names `audit_integrity_verified` / `audit_integrity_failed` / `key_reuse_detected` are recorded, the consumption mechanism deliberately is **not**, and must not be inferred), and Plan-025 / Spec-027 row 9b (bind-auth contract owned here, relay wiring owned there). §Required ADRs gains ADR-003, ADR-012, and ADR-017 — already load-bearing in the body (queue/intervention health, `cedar_deny_total`'s policy-family labels, the runtime-local-no-Postgres-counterpart rule). §API And Transport Changes and Phase 1 T1.1 now state the `RunFailureCategory` four-arm closure explicitly and record that policy or approval blockage is not a fifth arm but a `blockingReason` on the stuck-run surface, routed to Spec-012 per `Spec-020 §Implementation Notes`. §PII in Diagnostics now states that redaction _decision logic_ is code-local with no wire contract, while the operator-readable policy _state_ is the contracted surface. **Reconciliation.** `Spec-027 §Acceptance Criteria` and the self-host secure-defaults runbook still claimed six daemon counter families; both are corrected to the five row-9a families already ratified by the 2026-06-10 D-021-8 pass; Spec-027's `/metrics`-auth open question is retired against rows 9a/9b, which have carried the bearer-or-mTLS answer since that pass; and the same acceptance criterion's auth clause — which still asserted the bearer-only premise that open question carried — is widened to that ratified scheme, so the retirement does not leave the consequence standing without its deleted premise. Recording an already-ratified decision at a site that missed it is reconciliation, not new design, so Spec-027 stays `approved`. Backfill plus reconciliation only — Plan-020 stays `approved` per the NS-19 backfill precedent. Not applied here: the cross-plan dependency-map edits (owned by a sibling in the same audit swap). **Review-round addendum (2026-08-11, same PR):** four Codex findings reconciled under the Plan-013-restore test (every edit records an existing relationship, structure, or ownership fact ratified text already asserts — none invents behavior). (1) The five `health.*` wire method strings are registered — new T1.4/T2.10, the Health Method-Name Registry, and the `DiagnosticRedactionPolicyRead` mirror shapes — catching the contracts mirror up to the §API And Transport Changes contract and giving T4.1 callable operations. (2) The `METRICS_AUTH` credential inputs are named — `METRICS_AUTH_TOKEN_FILE`; `METRICS_TLS_CERT_FILE` / `METRICS_TLS_KEY_FILE`; `METRICS_TLS_CLIENT_CA_FILE` / `METRICS_TLS_CLIENT_ALLOWLIST_FILE` — the concrete-variable layer of the bind/auth contract this plan already owns for both surfaces (CP-020-4); Spec-027 is untouched because its rows 9a/9b already ratify the material classes. (3) The health-status vocabulary is reconciled to Spec-020's `healthy` / `degraded` / `blocked` (the contracts mirror carried the drifted `unhealthy` arm) and the failure field to the corpus-wide `failureCategory` carrier (this plan's task text carried the drifted `category` spelling). (4) The Spec-020-mandated `retention_policy_override` warning gauge is registered as the sixth daemon family: the row-9a set stays the five D-021-8 ratified, and the registry total moves 5 → 6 — this entry's earlier "6 → 5" recorded the rate-limit-family removal, which stands; the new sixth is a different, plan-owned family.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
- [ ] Prometheus `/metrics` endpoint lands with the six registered daemon metric families (the five row-9a families plus the `retention_policy_override` warning gauge), bounded label sets, bearer-token / mTLS auth gate for non-loopback bind, and emission-time label enforcement verified by negative tests (I-020-2)
- [ ] Cardinality ceiling (< 200 series per daemon instance) asserted in integration tests and wired into CI (I-020-1)
- [ ] Diagnostic-bucket discipline verified across all 4 buckets: ≤ 7-day default TTL with `retention_policy_override` warning on every startup and policy read (I-020-3), default-deny outbound with per-bucket opt-in that never releases previously-captured data (I-020-4), and Path-3 participant-scoped flush coverage asserted over the bucket set (I-020-5)
