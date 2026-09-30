# Plan-018: Observability And Failure Recovery

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `018` |
| **Slug** | `observability-and-failure-recovery` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-018: Observability And Failure Recovery](../specs/018-observability-and-failure-recovery.md) |
| **Required ADRs** | [ADR-003](../decisions/003-daemon-backed-queue-and-interventions.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-005](../decisions/005-provider-drivers-use-a-normalized-interface.md), [ADR-012](../decisions/012-cedar-approval-policy-engine.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md) |
| **Dependencies** | [Plan-013](./013-persistence-recovery-and-replay.md) (persistence layer) |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |
| **Owned Spec-024 Rows** | 9 — Prometheus `/metrics` exposition (daemon endpoint + the daemon metric families of row 9a + the bind/auth secure-default contract, which is shared: the same `METRICS_BIND` / `METRICS_AUTH` contract governs row 9b's relay endpoint); see [Spec-024 row 9](../specs/024-self-host-secure-defaults.md#required-behavior). The relay mounts the equivalent relay-side surface, owning row 9b's relay metric families and endpoint wiring while consuming this plan's bind/auth contract. |

## Goal

Implement the daemon's diagnostic signals: bounded retention on this machine for its diagnostic buckets, and the loopback `/metrics` endpoint. No client reads a `health.*` method; Settings › Runtime reads the service's status from `daemon.status.read`.

## Scope

This plan covers the diagnostic buckets `driver_raw_events`, `command_output` and `tool_traces` (their tables, TTL retention and summary construction; nothing in them leaves the machine) and the daemon's `/metrics` endpoint with its registered families. The retry rules of [Spec-018 §Required Behavior](../specs/018-observability-and-failure-recovery.md#required-behavior) are built where their mechanisms live: the Codex service restart bound with the Codex service's lifecycle, the pane-read retry with the pane reads.

## Non-Goals

- External dashboard or vendor-tool rollout
- Full incident-management workflow
- Business analytics

## Preconditions

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/runtime-daemon/src/observability/diagnostic-redaction-policy.ts` (PII redaction gate on every diagnostic bucket)
- `packages/runtime-daemon/src/observability/diagnostic-buckets/` (TTL-bucket implementations for `driver_raw_events`, `command_output` and `tool_traces`)
- `packages/runtime-daemon/src/observability/metrics-exposition.ts` — Prometheus `/metrics` endpoint (Spec-024 row 9 daemon scope)
- `packages/runtime-daemon/src/observability/metrics-registry.ts` — allow-listed metric families with bounded label sets; PII-free by construction
- `packages/runtime-daemon/src/observability/metrics-auth.ts` — bearer-token / mTLS gate for non-loopback `METRICS_BIND`

## PII in Diagnostics

Plan-018 is the implementation surface for [Spec-018 §PII in Diagnostics](../specs/018-observability-and-failure-recovery.md#pii-in-diagnostics) and must honor the [Spec-020 §PII Data Map](../specs/020-data-retention-and-gdpr.md#pii-data-map) classification of diagnostic data. The bounded-retention diagnostic buckets — `driver_raw_events`, `command_output`, `tool_traces` — are runtime-local stores that may transit raw user content and therefore require TTL-bounded local retention and never leave the machine.

- Default TTL: ≤ 7 days per [Spec-018 §PII in Diagnostics](../specs/018-observability-and-failure-recovery.md#pii-in-diagnostics). An override the person configures beyond 30 days MUST emit the `retention_policy_override` warning metric on every daemon startup and on each policy read.
- Nothing leaves the machine: the daemon runs no telemetry exporter and sends no diagnostic bucket content to any sink. A compacted summary carries only signals derived by construction from non-PII inputs (counts, categories, latencies).
- Bound and erase: each bucket drops its rows past `Keep diagnostic logs for` ([Spec-020 §Erasure Paths](../specs/020-data-retention-and-gdpr.md#erasure-paths) Path 3), and `Erase all data` deletes them with the data folder. There is no per-person flush.

**Redaction-decision locality (no wire contract).** The redaction _decision logic_ — which fields a compacted summary keeps and which it drops — is daemon-local code in `diagnostic-redaction-policy.ts`. It is deliberately **not** published as a typed payload in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md), because no cross-package consumer evaluates redaction: the daemon is the only principal that sees diagnostic content, and none of it leaves the machine. The policy _state_ does not cross a contract boundary either. The retention period is the `Keep diagnostic logs for` setting on Settings › Runtime, carried by the daemon's configuration reads and writes ([Plan-006 §Phase R1 — Namespace Handlers](./006-local-ipc-and-daemon-control.md#phase-r1--namespace-handlers)), and a retention override beyond 30 days announces itself on the `retention_policy_override` gauge. A consumer that needs to _evaluate_ redaction or _read_ policy state reads a typed contract published for it; otherwise changing a redaction rule is a code change with no cross-plan contract ripple.

## Prometheus `/metrics` Exposition (Spec-024 row 9)

Plan-018 owns the daemon-side `/metrics` endpoint required by [Spec-024 row 9](../specs/024-self-host-secure-defaults.md#required-behavior). The endpoint is an externally reachable security boundary, not a harmless diagnostic surface; it is designed to fail closed on insecure bind/auth configurations.

**Endpoint contract.**

- Path: `GET /metrics`
- Wire format: Prometheus v0.0.4 exposition (text/plain; version=0.0.4; charset=utf-8). OpenMetrics is accepted where clients request it via `Accept:` negotiation.
- Default bind: `METRICS_BIND=127.0.0.1:<port>` (loopback only). The daemon MUST reject a non-loopback `METRICS_BIND` at config-parse time unless auth is configured (bearer-token OR mTLS client cert).
- Non-loopback opt-in: when `METRICS_BIND` is non-loopback, the daemon MUST require either (a) `METRICS_AUTH=bearer` with a rotated token file or (b) `METRICS_AUTH=mtls` with a client-cert allow-list the person provides. Missing auth on non-loopback bind is a parse-time error.
- Credential inputs (the concrete-variable layer of this contract; the relay config loader parses the identical set): credential material is supplied by file-path env vars, never inline env values. `METRICS_AUTH=bearer` requires `METRICS_AUTH_TOKEN_FILE` — the path to the bearer-token file; the entire trimmed file body is the token. `METRICS_AUTH=mtls` requires `METRICS_TLS_CLIENT_CA_FILE` — the PEM CA bundle presented client certificates must chain to — and `METRICS_TLS_CLIENT_ALLOWLIST_FILE` — the allow-list the person provides, one SPKI-SHA256 client-certificate fingerprint per line (the fingerprint form Spec-024 row 1 persists at `./data/trust/fingerprint.txt`), `#`-prefixed comment lines ignored; a client certificate is accepted only when it both verifies against the CA bundle and matches an allow-list entry. Any non-loopback `METRICS_BIND` additionally requires the listener keypair `METRICS_TLS_CERT_FILE` + `METRICS_TLS_KEY_FILE` (server certificate + private key) in **both** auth modes — Spec-024 row 2 refuses unencrypted non-loopback listeners independently of the auth gate, so a plaintext bearer scrape is never servable.
- Credential validation (fail closed): at config-parse time, a required credential file that is missing, unreadable, empty, or malformed — including a cert/key pair that does not match, a CA bundle containing no usable certificate, and an allow-list with zero entries — is a parse-time error naming the offending variable, never a warn-and-serve. Credential material that becomes invalid after startup (token file deleted or emptied, allow-list emptied) causes every scrape to be rejected with an actionable log line rather than the endpoint serving unauthenticated.
- Credential rotation/reload: `METRICS_AUTH_TOKEN_FILE` and `METRICS_TLS_CLIENT_ALLOWLIST_FILE` are change-detected and re-read on the authorization path, so replacing file contents rotates the credential without a daemon restart; a rotated-away token or de-listed fingerprint is rejected from the next request onward with no accept-both grace window (the behavior T3.3's rotation test pins). `METRICS_TLS_CERT_FILE` / `METRICS_TLS_KEY_FILE` / `METRICS_TLS_CLIENT_CA_FILE` take effect on daemon restart.
- Disable: `METRICS_BIND=off` disables the endpoint entirely. Disabling MUST emit a banner + `security.default.override=metrics_disabled` log event per [Spec-024 §Fallback Behavior](../specs/024-self-host-secure-defaults.md#fallback-behavior).

**Metric families (daemon scope — the relay mounts the equivalent relay-side set).** The daemon registry exposes these families: the Spec-024 row 9a families (D-019-8), the plan-owned `retention_policy_override` warning gauge mandated by [Spec-018 §PII in Diagnostics](../specs/018-observability-and-failure-recovery.md#pii-in-diagnostics) and required by I-018-3 / T2.7. The plan-owned gauge is daemon-only — it reports diagnostic retention, which has no relay-side equivalent — and sits outside the row-9a security set, so Spec-024's row-9a enumeration is unchanged.

| Family | Type | Labels (bounded) | Source |
| --- | --- | --- | --- |
| `token_auth_failure_total` | counter | `reason: "expired"\|"invalid"\|"dpop_mismatch"\|"principal_mismatch"\|"scope_denied"` (5 bounded values) | Auth middleware |
| `cedar_deny_total` | counter | `policy_family: "session"\|"workflow"` (bounded; owned by [Plan-010](./010-approvals-permissions-and-trust-boundaries.md), which owns the Cedar layer) | Cedar authorization layer |
| `relay_connection_churn_total` | counter | `phase: "connect"\|"disconnect"\|"reconnect"\|"rejected"` (4 bounded values) | Relay client (mounted by the relay-side equivalent) |
| `backup_success_total` | counter | `kind: "event_end"\|"nightly"\|"manual"` (3 bounded values) | Backup job (Plan-001 + the persistence-hardening plan) |
| `auto_update_check_status` | gauge | none | Update-notify poller (Plan-006 row 7a) — values: `0=ok`, `1=behind`, `2=poll_failed` |
| `retention_policy_override` | gauge | none | Diagnostic-bucket retention policy (T2.7) — values: `0` = no TTL override beyond 30 days, `1` = an override > 30 days is active; re-asserted on every daemon startup and on every policy read (I-018-3). Plan-owned per [Spec-018 §PII in Diagnostics](../specs/018-observability-and-failure-recovery.md#pii-in-diagnostics); outside the row-9a set |

**Rate-limit families are control-plane-side, not daemon-side (Plan-019 D-019-8).** The daemon has no rate-limit enforcer — [Spec-019 §Scope](../specs/019-rate-limiting-policy.md#scope) excludes the local IPC path, and its acceptance criteria assert that local daemon endpoints are not rate-limited — so no daemon-side `rate_limit_trip_total{bucket}` family appears in this table. The canonical rate-limit family set (`rate_limit_trip_total{endpoint,tier}`, `rate_limit_backend_error_total{backend}`, `rate_limit_failclosed_total{backend}`) is owned by [Plan-019](./019-rate-limiting-policy.md#design-decisions), registered + emitted control-plane-side under this section's label invariants (Plan-019 CP-019-4), and exposed on the self-hosted relay's `GET /metrics` by [Plan-028](./028-remote-control.md); the Workers relay writes the same counters as structured log lines, which the person reads in their own Cloudflare dashboard (Plan-019 D-019-15).

**PII-free-by-construction invariants (I-018-2).**

- Labels MUST NEVER carry: raw user IDs, session IDs, command text, file paths, URLs, tokens, or any free-form content.
- Labels MUST be enumerable at compile time — no dynamic label values. Tests assert the full label cardinality per family is bounded by the documented allow-list.
- Any attempt to emit a label value outside the allow-list MUST throw at emission time, not silently coerce. Emission-time enforcement prevents accidental PII bleed when a new code path adds a metric observation.

**Cardinality ceiling (I-018-1).** Total emitted series across all registered families MUST stay below 200 per daemon instance (the plan-owned `retention_policy_override` gauge contributes one series). Series-count assertion runs in integration tests; exceeding the ceiling is a violation of I-018-1 (not a warning), failing the test until the allow-list tightens.

## Data And Storage Changes

- Add the diagnostic-bucket tables (`driver_raw_events`, `command_output`, `tool_traces`) to Local Runtime Daemon SQLite with TTL-purge indices per [Local SQLite Schema §Diagnostic Bucket Tables](../architecture/schemas/local-sqlite-schema.md#diagnostic-bucket-tables-plan-018). These are runtime-local; they have no shared-Postgres counterpart per [ADR-017](../decisions/017-shared-event-sourcing-scope.md).
- Add bounded-retention handling for raw diagnostic payload classes so compaction never removes the failure detail a run event carries.
- Diagnostic bucket column definitions live in the Local SQLite schema because raw diagnostics never leave the machine. This plan adds no shared-Postgres table.

## API And Transport Changes

- No `health.*` read is added for any client, and no `health.*` method string is registered. Settings › Runtime's service status comes from the supervisor through `daemon.status.read` ([Plan-006 §Phase R1 — Namespace Handlers](./006-local-ipc-and-daemon-control.md#phase-r1--namespace-handlers)).
- The diagnostic redaction policy is daemon-local state, not a contract: the TTL from `Keep diagnostic logs for` and the `retention_policy_override` gauge. The default TTL is ≤ 7 days.
- Add Prometheus `/metrics` endpoint (Spec-024 row 9) on the daemon with the bind/auth secure-default contract documented in §Prometheus `/metrics` Exposition above. The relay mounts an equivalent `/metrics` endpoint using the same auth gate and metric-family allow-list shape.

## Invariants

Load-bearing constraints every Plan-018 PR — and every downstream extension — must preserve. Each entry names the governing clause it grounds in, or declares itself plan-owned.

- **I-018-1 — The daemon `/metrics` cardinality ceiling is a hard limit, not a warning.** Total emitted series across the registered daemon families — the row-9a families and the `retention_policy_override` warning gauge — stays below 200 per daemon instance. An integration test asserts the live series count; exceeding the ceiling blocks merge until the label allow-list tightens, rather than emitting a warning and shipping. **Grounds in.** [Spec-024 §Required Behavior](../specs/024-self-host-secure-defaults.md#required-behavior) row 9a states the ceiling ("cardinality ceiling < 200 series per daemon instance"). The merge-blocking enforcement posture layered on top of it is **plan-owned**: the spec states the ceiling but no enforcement mechanism for it. **Why load-bearing.** A metrics endpoint that degrades gracefully past its ceiling degrades silently — series growth is monotonic in practice, so a warning is observed once and then ignored while scrape cost and daemon memory grow unbounded on the person's machine while nobody is watching. **Verification.** T3.4.
- **I-018-2 — Metric labels are PII-free by construction, enforced at emission time.** Label values come from a closed, compile-time-enumerable allow-list per family; no label value derives from user IDs, session IDs, command text, file paths, URLs, tokens, or any free-form content; an out-of-allow-list value throws at emission time rather than being silently coerced or truncated. **Grounds in.** [Spec-024 §Required Behavior](../specs/024-self-host-secure-defaults.md#required-behavior) row 9a ("Labels MUST be bounded and PII-free"), serving [Spec-018 §PII in Diagnostics](../specs/018-observability-and-failure-recovery.md#pii-in-diagnostics). The closed allow-list plus emission-time throw is the **plan-owned** enforcement mechanism for that MUST — the spec states the property, not how it is detected. **Why load-bearing.** `/metrics` is scraped by systems outside the daemon's trust boundary; a single dynamic label value leaks PII to every scraper and every retained scrape sample simultaneously, and truncating or masking it does not help because partial PII is still PII per Spec-018. Throwing at emission converts a silent leak into a loud test failure at the moment a new code path adds an observation. **Verification.** T3.1.
- **I-018-3 — Diagnostic-bucket retention is TTL-bounded at ≤ 7 days by default, and any longer override announces itself.** All the buckets (`driver_raw_events`, `command_output`, `tool_traces`) default to a ≤ 7-day TTL; an override the person sets beyond 30 days emits the `retention_policy_override` warning metric on every daemon startup and on every policy read. **Grounds in.** [Spec-018 §PII in Diagnostics](../specs/018-observability-and-failure-recovery.md#pii-in-diagnostics) ("Bounded local retention"), with the storage side owned by [Spec-020 §PII Data Map](../specs/020-data-retention-and-gdpr.md#pii-data-map)'s bounded-retention tier. **Why load-bearing.** The buckets capture full prompts, full command arguments, and full tool results by the nature of their purpose; unbounded retention turns diagnostics into an Article-17 escape hatch where erasure obligations are satisfied on canonical stores while the same content persists indefinitely beside them. Repeating the warning on every policy read (not once at startup) is what keeps a long override visible to the person long after it was set. **Verification.** T2.7.
- **I-018-4 — Diagnostics never leave the machine, and a compacted summary carries no free text.** The daemon runs no telemetry exporter and sends no diagnostic-bucket row to any sink. Where high-volume tool traces are compacted, the summary is built from counts, categories and durations, never truncated from free text. **Grounds in.** [Spec-018 §PII in Diagnostics](../specs/018-observability-and-failure-recovery.md#pii-in-diagnostics) ("Nothing leaves the machine", "Summary-only retention"). **Why load-bearing.** A summary cut from a prompt keeps part of the prompt past the TTL that bounds the raw row, and truncated personal data is still personal data. **Verification.** T2.8.

## Cross-Plan Obligations

Each entry transcribes an obligation already committed in the named counterparty's text; none is authored here. See Cross-Plan Dependency Graph for the graph-level view.

### CP-018-1 — Metric-family label invariants are a doc contract Plan-019 registers against (⇄ Plan-019 CP-019-4)

**Obligation.** Plan-019 registers its canonical control-plane `rate_limit_*` metric families against this plan's §Prometheus `/metrics` Exposition label invariants — bounded, compile-time-enumerable label values, PII-free by construction, emission-time enforcement (I-018-2). Plan-019 records the relationship as `consumes ←` and scopes it explicitly: a **doc contract only, with no Plan-018 code consumed**, so neither plan waits on the other's code.

**Resolution.** Live and reciprocal. Plan-019's side is CP-019-4; the reciprocal recorded there is that Plan-019's canonical family set is the sole registry for those families (D-019-8), as this plan's §Prometheus `/metrics` Exposition already states. Plan-018 owes Plan-019 a stable label-invariant contract, not code; Plan-019's registrations are validated against the invariants, so a change to them reaches those registrations too.

### CP-018-2 — The diagnostic buckets are bounded by `Keep diagnostic logs for` (⇄ Plan-020 CP-020-7)

**Obligation.** Plan-018's diagnostic buckets drop their rows past `Keep diagnostic logs for` on the service's one scheduler ([Plan-006 §Phase R1 — Namespace Handlers](./006-local-ipc-and-daemon-control.md#phase-r1--namespace-handlers)); `Erase all data` deletes them with the data folder. There is no per-person flush. Plan-020 records the reciprocal as **live** (Spec-018 bounded-retention).

**Resolution.** Live and reciprocal. Plan-018's half is I-018-3, implemented by T2.7. Plan-020 places the bound in its retention tiers as Path 3. A new diagnostic bucket added by either side joins the same bound.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define the diagnostic redaction policy state, daemon-local.
2. Implement bounded-retention policy handling for raw diagnostics without weakening canonical diagnosis. Build compacted summaries from counts, categories and durations for every diagnostic bucket, with no exporter and no sink off the machine; emit `retention_policy_override` warning metric when TTL override > 30 days.
3. Implement Prometheus `/metrics` endpoint with the registered daemon metric families (the row-9a families and the `retention_policy_override` warning gauge), bounded label sets, bearer/mTLS auth gate for non-loopback `METRICS_BIND`, and emission-time label enforcement (`metrics-exposition.ts`, `metrics-registry.ts`, `metrics-auth.ts`).

## Implementation Phase Sequence

Three phases decompose the three §Implementation Steps above; nothing here is new design. Phase 1 covers Step 1; Phase 2 covers Step 2; Phase 3 covers Step 3. Phase 1 has no unsatisfied upstream code dependency; Phases 2 and 3 serialize behind their predecessors.

### Phase 1 — Diagnostic policy state

**Precondition:** none. Implementation Step 1; gates Phase 2, whose retention and summary code read this state.

#### Tasks

- **T1.3 — Diagnostic redaction policy state (daemon-local).**
  - **Files:** `packages/runtime-daemon/src/observability/diagnostic-redaction-policy.ts` (CREATE — the policy-state type and its resolution; T2.8 adds the summary builder to the same file)
  - The policy _state_ the retention and summary code reads: the TTL per bucket, resolved from the `Keep diagnostic logs for` setting in daemon configuration, and whether an override beyond 30 days is active. The default TTL is ≤ 7 days. Neither the state nor the redaction _decision logic_ is a wire contract — see §PII in Diagnostics above.
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

- **T2.7 — Diagnostic-bucket TTL retention and `retention_policy_override`.**
  - **Files:** `packages/runtime-daemon/src/observability/diagnostic-buckets/` (CREATE — one TTL-bucket implementation per bucket plus the shared purge driver)
  - Apply the ≤ 7-day default TTL to every bucket; support a per-deployment override; emit the `retention_policy_override` warning metric on every daemon startup and on every policy read when the override exceeds 30 days. Compaction of raw diagnostics never removes the failure detail a run event carries.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/diagnostic-buckets.test.ts` (CREATE) — each bucket expires rows at or before the configured TTL; an override > 30 days emits the warning on startup and on each policy read (not once); compaction leaves the run event's failure detail intact.
  - **Acceptance:** no bucket retains rows past its TTL, and a long override is impossible to hold quietly.
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

### Phase 3 — Prometheus `/metrics` exposition

**Precondition:** Phase 2 merged. Implementation Step 3; the endpoint reports on the retention state Phase 2 creates.

#### Tasks

- **T3.1 — `metrics-registry.ts`: allow-listed families with bounded labels.**
  - **Files:** `packages/runtime-daemon/src/observability/metrics-registry.ts` (CREATE)
  - Register the families §Prometheus `/metrics` Exposition documents — the row-9a daemon families (D-019-8), the plan-owned `retention_policy_override` warning gauge (label-less; the family I-018-3 / T2.7 require) — with their documented bounded label sets. Label values are compile-time enumerable; emitting a value outside the allow-list throws rather than coercing — for the label-less gauge, emitting any label at all throws. No rate-limit family is registered daemon-side — those are control-plane-side per D-019-8.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/metrics-registry.test.ts` (CREATE) — one negative unit test per family asserting an out-of-allow-list label value throws at emission time (for `retention_policy_override`, that any label at all throws); the registry exposes exactly the row-9a families and `retention_policy_override`; no label value derives from user ids, session ids, command text, file paths, URLs, or tokens.
  - **Acceptance:** the registry is the only place a family or label can be introduced, so widening the surface is a reviewable diff.
  - **Spec coverage:** Spec-024 §Required Behavior
  - **Verifies invariant:** I-018-2
  - **Consumes:** the canonical control-plane family set ← [Plan-019](./019-rate-limiting-policy.md) (CP-018-1 — label-invariant doc contract; no daemon registration); the `retention_policy_override` emission site ← T2.7 (Phase 2 — the family registered here is the one T2.7's warning emissions ride)

- **T3.2 — `metrics-exposition.ts`: the `GET /metrics` endpoint.**
  - **Files:** `packages/runtime-daemon/src/observability/metrics-exposition.ts` (CREATE)
  - Serve Prometheus v0.0.4 exposition (`text/plain; version=0.0.4; charset=utf-8`), accepting OpenMetrics where a client negotiates it via `Accept:`.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/metrics-exposition.test.ts` (CREATE) — exposition output round-trips through a reference parser; OpenMetrics negotiation is honored; only registered families appear in the output.
  - **Acceptance:** a stock Prometheus scraper reads the endpoint with no vendor-specific handling.
  - **Spec coverage:** Spec-024 §Required Behavior
  - **Verifies invariant:** none (format task; the label and cardinality invariants bind on T3.1 and T3.4)
  - **Consumes:** registered families ← T3.1

- **T3.3 — `metrics-auth.ts`: bind and auth secure-default gate.**
  - **Files:** `packages/runtime-daemon/src/observability/metrics-auth.ts` (CREATE)
  - Default `METRICS_BIND=127.0.0.1:<port>`. A non-loopback bind without auth is a config-parse-time error. Non-loopback requires either `METRICS_AUTH=bearer` with the token file `METRICS_AUTH_TOKEN_FILE` or `METRICS_AUTH=mtls` with the client CA `METRICS_TLS_CLIENT_CA_FILE` plus the SPKI-SHA256 fingerprint allow-list `METRICS_TLS_CLIENT_ALLOWLIST_FILE`, and in both modes the non-loopback listener serves TLS from `METRICS_TLS_CERT_FILE` / `METRICS_TLS_KEY_FILE` — the full credential-input, fail-closed validation, and rotation/reload contract is the credential bullets of §Prometheus `/metrics` Exposition above (token file and allow-list re-read on the authorization path with no accept-both grace window; listener material on restart). `METRICS_BIND=off` disables the endpoint and emits the banner plus a `security.default.override=metrics_disabled` log event exactly once per startup. This is the contract the relay endpoint consumes.
  - **Tests:** `packages/runtime-daemon/src/observability/__tests__/metrics-auth.test.ts` (CREATE) — non-loopback bind without auth fails at parse time with an actionable error; bearer mode rejects missing and wrong tokens and invalidates old tokens on the next request after rotation; mtls mode rejects a client cert absent from the allow-list; `METRICS_BIND=off` disables the endpoint and emits the banner and log event exactly once; one fail-closed parse-time negative per credential variable (`METRICS_AUTH_TOKEN_FILE`, `METRICS_TLS_CERT_FILE`, `METRICS_TLS_KEY_FILE`, `METRICS_TLS_CLIENT_CA_FILE`, `METRICS_TLS_CLIENT_ALLOWLIST_FILE` — missing, unreadable, or empty each refuse startup naming the variable); a mismatched cert/key pair and a zero-entry allow-list are parse-time errors; a token file emptied after startup rejects every scrape rather than serving unauthenticated; an allow-list edit takes effect on the next request without restart.
  - **Acceptance:** every insecure configuration fails at parse time rather than serving and warning.
  - **Spec coverage:** Spec-024 §Required Behavior, Spec-024 §Fallback Behavior
  - **Verifies invariant:** none (the bind and auth defaults are Spec-024 row 9a MUSTs rather than plan-owned invariants)
  - **Consumes:** the endpoint ← T3.2

- **T3.4 — Cardinality-ceiling integration test and CI wiring.**
  - **Files:** `packages/runtime-daemon/src/observability/__tests__/metrics-cardinality.test.ts` (CREATE)
  - Assert total emitted series across the registered families stays below 200 per daemon instance under a fixture exercising every registered label combination, and wire the assertion into CI so a breach blocks merge.
  - **Tests:** the task is the test — plus a negative control proving the assertion fails when a deliberately unbounded label is registered.
  - **Acceptance:** exceeding the ceiling blocks merge; it never degrades to a warning.
  - **Spec coverage:** Spec-024 §Required Behavior
  - **Verifies invariant:** I-018-1
  - **Consumes:** the registry ← T3.1

## Parallelization Notes

- T2.1's tables can proceed in parallel with T1.3; the metrics registry (T3.1) waits on nothing but Phase 2's merge.

## Test And Verification Plan

- Retention tests proving compaction of raw diagnostics does not erase canonical failure detail or recovery visibility
- Summary construction (I-018-4): a compacted summary carries counts, categories and durations and none of the free-text fixture's words
- TTL-bucket-purge-coverage (I-018-3): each bucket expires rows at or before the configured TTL
- `retention_policy_override` warning emission (I-018-3): any policy read observing TTL > 30 days emits the warning metric on daemon startup and on each policy read
- **/metrics endpoint secure-default tests (Spec-024 row 9):**
  - Default bind is `127.0.0.1`; a non-loopback `METRICS_BIND` without auth fails at config-parse time with actionable error.
  - `METRICS_AUTH=bearer` on non-loopback bind rejects requests without the bearer token and with a wrong bearer token; rotating the token file invalidates old tokens on the next request; the token is read from `METRICS_AUTH_TOKEN_FILE`, and a missing, unreadable, or empty token file is a config-parse-time error (fail closed).
  - `METRICS_AUTH=mtls` on non-loopback bind rejects requests from clients whose cert is not on the allow-list the person provides; the listener keypair (`METRICS_TLS_CERT_FILE` / `METRICS_TLS_KEY_FILE`), client CA (`METRICS_TLS_CLIENT_CA_FILE`), and fingerprint allow-list (`METRICS_TLS_CLIENT_ALLOWLIST_FILE`) each fail closed at parse time when missing or invalid.
  - `METRICS_BIND=off` disables the endpoint, emits the loud banner, and emits `security.default.override=metrics_disabled` log event exactly once per startup.
  - Cardinality ceiling (I-018-1): integration test asserts total emitted series across the registered families stays below 200 per daemon instance; exceeding the ceiling fails the test.
  - PII-free label enforcement (I-018-2): attempting to emit a label value outside the documented allow-list throws at emission time (unit test per family).
  - Exposition format conforms to Prometheus v0.0.4 (parse-round-trip verified against a reference parser).

## Rollout Order

1. Ship the diagnostic buckets with their TTL and summary builder
2. Enable the `/metrics` endpoint with its registered families

## Rollback Or Fallback

- Set `METRICS_BIND=off` if the `/metrics` endpoint regresses; the diagnostic buckets' TTL has no off switch, because turning it off would keep personal data past its limit.

## Risks And Blockers

- Bounded-retention implementation can become misleading if raw diagnostic expiry is not clearly distinguished from canonical observability truth

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
- [ ] Prometheus `/metrics` endpoint lands with the registered daemon metric families (the row-9a families and the `retention_policy_override` warning gauge), bounded label sets, bearer-token / mTLS auth gate for non-loopback bind, and emission-time label enforcement verified by negative tests (I-018-2)
- [ ] Cardinality ceiling (< 200 series per daemon instance) asserted in integration tests and wired into CI (I-018-1)
- [ ] Diagnostic-bucket discipline verified across every bucket: ≤ 7-day default TTL with `retention_policy_override` warning on every startup and policy read (I-018-3), and compacted summaries built from counts, categories and durations only, with nothing leaving the machine (I-018-4)
