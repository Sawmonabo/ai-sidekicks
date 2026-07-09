# Plan-021: Rate Limiting Policy

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `021` |
| **Slug** | `rate-limiting-policy` |
| **Date** | `2026-04-17` (Tier-6 readiness audit 2026-06-10) |
| **Author(s)** | `Claude Opus 4.7` |
| **Spec** | [Spec-021: Rate Limiting Policy](../specs/021-rate-limiting-policy.md) |
| **Required ADRs** | [ADR-014: tRPC Control-Plane API](../decisions/014-trpc-control-plane-api.md); [ADR-020: V1 Deployment Model And OSS License](../decisions/020-v1-deployment-model-and-oss-license.md); [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md); [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md). ADR-012 removed by the Tier-6 audit (D-021-1): no control-plane Cedar surface exists — admin-bans authorization is operator-token-based, and the Cedar engine is daemon-embedded per ADR-012 itself. |
| **Dependencies** | Plan-008 (CP-008-5 tRPC middleware-mount surface + CP-008-9 WS per-frame admission seam, both consumed; wrangler.toml deployment config extended); Plan-018 (`AuthenticatedIdentityContext` — the `ctx.participantId` producer for identity resolution; the former "role-claim surface for admin endpoints" dependency is removed by D-021-1). Non-blocking context, not dependencies: Plan-007 daemon-IPC scope exclusion (§Explicitly Out of Scope); the Plan-020 metric-name doc contract (CP-021-4 — Tier 8, no code consumed, no tier inversion); Plan-002 Phase 4 + Plan-025 as downstream consumers (see §Cross-Plan Obligations) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Ship the Spec-021 rate-limiting enforcement layer across the control-plane tRPC surface and the WebSocket relay data path, as a single `RateLimiter` contract with two deployment-aware implementations (Cloudflare-native `rate_limit` binding + escalation Durable Object for the hosted relay; `rate-limiter-flexible` v11.0.0 with a Postgres backend for the self-hostable relay), composed into one admission pipeline (ban → escalation block → counter), plus a three-stage escalation ladder, an operator-authenticated permanent-ban surface, and canonical `rate_limit_*` telemetry. Enforcement must be identical in both deployment modes (identical limits, identical headers, identical error envelopes) so that protocol-level changes land once and ship to both.

## Scope

- `RateLimiter` contract owned by this plan at `packages/contracts/src/rate-limiter.ts` (PtyHost-precedent placement — see [Plan-024](./024-rust-pty-sidecar.md#target-areas) for the pattern), plus the typed `RateLimitEndpointGroup` key union derived from the [Spec-021 §Canonical Endpoint Group Registry](../specs/021-rate-limiting-policy.md#canonical-endpoint-group-registry) and the canonical 5-field `RateLimitResponse` wire envelope + Zod schema (D-021-6, A-021-18).
- Two `RateLimiter` implementations:
  - `CloudflareWorkersRateLimiter` — wraps `env.<LIMITER>.limit({ key })` per the Cloudflare `rate_limit` binding, with the `RateLimitEscalationDO` consulted on every check for block state and authoritative window values (eager-DO design, D-021-3).
  - `PostgresRateLimiter` — wraps `rate-limiter-flexible` v11.0.0's `RateLimiterPostgres` store (self-host), one instance per `(endpoint group, tier variant)` (D-021-4).
- `RateLimiterFactory` — runtime selector via env var `AIS_RATELIMIT_BACKEND={cloudflare|postgres}`, fails loudly on unknown **or absent** value; also reads `AIS_RATELIMIT_MODE={enforce|observe}` once at construction (D-021-16).
- Two-layer enforcement composition (D-021-3):
  - **Admission pipeline** (`checkAdmission`): active-ban check (403 `ratelimit.banned`, terminal, no counter consumed) → `RateLimiter.check()`. Both transports call only `checkAdmission`.
  - **Inside `RateLimiter.check()`:** escalation-block pre-check (blocked → 429 with block-remaining `Retry-After`) → sliding-window counter → on trip, violation recording + ladder evaluation (3/5min → 15-min block; 10/1hr → 1-hr block + ops-alert telemetry).
- Elevated tier (3×) for session owners on the registry's elevated-eligible rows, resolved via a per-endpoint `resolveTier` hook with bounded-staleness membership reads (D-021-4, D-021-5).
- tRPC v11 middleware `rateLimitProcedure({ endpoint, identityKeyFn?, resolveTier? })` wired per the §Endpoint Wiring Ownership table (D-021-6 — not every spec row is wired by this plan).
- WebSocket per-frame admission consumed by Plan-008's relay via CP-008-9 (hosted) and by Plan-025's frame handler (self-host): drop-frame on counter trip with one in-band `rate_limited` frame; close `4029` only on active escalation block; ban refusals close with distinct code `4003` (D-021-9).
- Admin bans API (operator-token-authenticated, D-021-1):
  - `POST /admin/bans` — issue ban (optional `expiresAt`; NULL = permanent, D-021-12).
  - `GET /admin/bans` — list bans (paginated; `activeOnly` default true).
  - `DELETE /admin/bans/{id}` — revoke a ban.
- `admin_bans` Postgres table (shared between both deployments — hosted and self-host both have Postgres per ADR-004).
- Fail-open grace period controlled by `AIS_RATELIMIT_FAILOPEN_SECONDS` env var (default 60s); after grace, fail-closed with HTTP 503; degraded responses carry `degraded: true` and suppress all `X-RateLimit-*` headers (A-021-18).
- Retry-After and standard rate-limit headers on sliding-window and escalation 429s — concurrency-cap refusals omit the timing pair and send only the truthful subset `X-RateLimit-Limit` + `X-RateLimit-Remaining: 0` (Spec-021 §Overflow Response); on allowed responses headers attach only when `remaining < 25%` of the limit (Spec-021 §Default Behavior).
- Prometheus-compatible metrics, canonical snake spelling (D-021-8): `rate_limit_trip_total{endpoint,tier}`, `rate_limit_block_total{window_size}`, `rate_limit_backend_error_total{backend}`, `rate_limit_failclosed_total{backend}`, `admin_ban_total{action}`. Registration + emission only; exposition is downstream (D-021-15).

## Non-Goals

- **Local daemon IPC rate limiting.** Spec-021 §Scope explicitly excludes the daemon path (trusted by socket reachability). This plan consumes that exclusion; no IPC-side middleware is authored, and a structural import-boundary test enforces it (I-021-1 verification companion, A-021-20).
- **KeyPackage upload rate limit.** Spec-021's `keypackage.upload` registry row is gated on the MLS upgrade path per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md). The V1 control plane ships **no** KeyPackage endpoint, so no limit binding is wired. A stub config entry is placed and the `identity_type` domain pre-reserves the dormant `'user'` arm (D-021-17), so V1.1 can activate without a schema change.
- **Hosted `/metrics` exposition.** No Workers scrape surface exists in the V1 corpus; hosted counters degrade to structured-log emission of the same bounded fields. Reinstating hosted exposition requires a hosted-observability decision (D-021-15 — explicit V1 gap, named criterion).
- **Per-model / per-provider token-level throttling.** Out of Spec-021 §Non-Goals.
- **Billing metering.** Separate plan (not in V1 scope per ADR-015).
- **Custom rate-limit algorithms beyond sliding window.** Fixed-window and token-bucket are not implemented; Spec-021 §Implementation Notes prefers sliding windows.
- **Admin UI for ban management.** API only in V1. UI comes with Plan-023 / Plan-026 follow-on (post-V1).
- **Wiring endpoint groups owned by later-landing plans.** `invite.*` wiring is Plan-002 Phase 4 (BL-120); `artifact.publish` is Plan-014 at Tier 7 (BL-146); `event.subscribe` concurrency-cap enforcement is the SSE subscription surface (BL-144); `approval.resolve` is **dormant in V1** — Plan-012's ratified transport is daemon JSON-RPC only (D-012-5) and Spec-021 excludes the daemon IPC path from rate limiting, so no V1 wiring surface exists (BL-145 is the re-arm sentinel). See §Endpoint Wiring Ownership.

## Preconditions

- [x] **Plan-readiness audit complete per [runbook](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier-6 audit (2026-06-10): 74 findings adjudicated via A-021-1..24, D-021-1..17 ratified; full rewrite to the four-phase audited Tasks structure; companion amendments in Spec-021, api-payload-contracts.md, error-contracts.md, Plan-008 (CP-008-9), Plan-020, Plan-025, Spec-027, deployment-topology.md, shared-postgres-schema.md, Spec-022, the GDPR erasure runbook, backlog.md (BL-120 rewrite + BL-144/145/146), and cross-plan-dependencies.md §2/§3/§5.
- [x] Spec-021 is approved and carries the §Canonical Endpoint Group Registry, the five-field check shape, the WS overflow semantics, ban expiry + list, and the ops-alert definition (amended by this Tier-6 audit, D-021-4/6/7/9/12).
- [x] ADR-014 (tRPC control-plane API) is accepted — establishes the tRPC router surface; the concrete middleware-mount seam is Plan-008-remainder CP-008-5 (see CP-021-1). The admin-bans routes are raw HTTP matched before tRPC dispatch per D-021-10 (the ADR-014 "narrow REST facade" posture for an operator-facing surface; route shape mandated by Spec-021 §Interfaces And Contracts).
- [x] ADR-020 (V1 deployment model) is accepted — declares both rate-limiter backends as V1-scope.
- [x] ADR-010 (PASETO v4.public) is accepted — provides the token primitive behind `AuthenticatedIdentityContext` (participant identity resolution for the middleware). The admin-bans surface does NOT use PASETO (D-021-1).
- [ ] Plan-008-remainder Tier-5 surfaces are shipped: the CP-008-5 stable middleware-mount surface (T-008r-1-5 PASETO middleware + router host) that `rateLimitProcedure` mounts onto.
- [ ] Plan-008 R3 exposes the per-frame admission seam per [CP-008-9](./008-control-plane-relay-and-session-join.md#cross-plan-obligations) (cross-plan amendment executed at this audit's swap). Gates the **hosted** half of Phase 3 WS wiring only; the self-host path is independently wired by Plan-025 steps 7-8 and is not gated on this precondition (D-021-2).
- [ ] Plan-018 ships `AuthenticatedIdentityContext` (the `ctx.participantId` producer). The former Cedar-consumable role-model precondition is removed (D-021-1).
- [x] BL-135 (resolved — Plan-025 D-025-8): canonical self-host admin-token path is `./data/admin-token`. Gates nothing in this plan's code (the operator token is constructor-injected config); recorded because Plan-025's token generator is the self-host credential provider for the admin-bans surface (D-021-1).

## Target Areas

- `packages/contracts/src/rate-limiter.ts` — **created by this plan.** `RateLimitIdentityType`, `RateLimitTier`, `RateLimitEndpointGroup`, `RateLimitCheckRequest`/`RateLimitCheckResponse`, `RateLimiter` interface, `RateLimitResponse` wire envelope + `RateLimitResponseSchema` (Zod).
- `packages/contracts/src/admin-bans.ts` — **created by this plan.** `AdminBan`, `AdminBansStore` interface (single `RateLimitIdentityType` — the former `BanIdentityType` duplicate is deleted, A-021-18), `AdminBanCreateRequest`/`AdminBanCreateResponse`/`AdminBanListResponse` wire pairs + Zod schemas.
- `packages/control-plane/src/rate-limit/` — **created by this plan.**
  - `endpoint-limits.ts` — canonical endpoint-group → `{ limit, period, tierEligible, enforcementClass }` config module transcribed from the Spec-021 registry (single source for both backends and wrangler parity, A-021-19).
  - `cloudflare-rate-limiter.ts` — Cloudflare-binding implementation (eager-DO, D-021-3).
  - `postgres-rate-limiter.ts` — `rate-limiter-flexible` Postgres implementation.
  - `factory.ts` — runtime backend selector + observe-mode read.
  - `enforcement-pipeline.ts` — `checkAdmission` (ban → limiter) with the ≤60s ban cache (D-021-3, D-021-5).
  - `escalation/escalation-store.ts` — internal `EscalationStore` + `EscalationDecision` contract both stores implement (A-021-19; internal seam, deliberately NOT in `packages/contracts/` per the hoist-only-when-cross-surface rule).
  - `escalation/postgres-escalation-store.ts` — self-host escalation state.
  - `escalation/durable-object-escalation-store.ts` — hosted escalation state (DO class + Worker-side adapter).
  - `fail-open.ts` — grace-period wrapper (wraps any `RateLimiter` with fail-open/fail-closed logic + `degraded` marker).
  - `metrics.ts` — `RateLimitMetrics` registry wrapper (five families, emission-time label guard).
  - `rate-limiter-contract-suite.ts` — exported shared contract suite (`describeRateLimiterContract`), the I-021-2 parity proof Plan-025 re-runs (A-021-20).
- `packages/control-plane/src/middleware/rate-limit.ts` — **created by this plan.** tRPC middleware `rateLimitProcedure`.
- `packages/control-plane/src/middleware/ws-rate-limit.ts` — **created by this plan.** WS frame check consumed via CP-008-9 (hosted) and Plan-025 (self-host).
- `packages/control-plane/src/admin/bans-routes.ts` — **created by this plan.** Admin-API raw HTTP routes (D-021-10).
- `packages/control-plane/src/admin/bans-store.ts` — **created by this plan.** Postgres-backed `AdminBansStore` implementation.
- `packages/control-plane/src/migrations/NNNN-rate-limit-tables.ts` — **extends the control-plane migration-runner series (v1 = Plan-001).** NNNN = next free version at landing time, append-order per [cross-plan-dependencies.md §5](../architecture/cross-plan-dependencies.md#5-canonical-build-order) (D-021-11). Two new tables: `admin_bans`, `rate_limit_escalations`.
- `packages/control-plane/src/server/host.ts` — **extended by this plan (export-only edit):** re-export `RateLimitEscalationDO` from the Worker entry module (Cloudflare requires DO classes exported from the deployed script; A-021-19) and mount the admin-bans route match ahead of tRPC dispatch (D-021-10), both inside the CP-008-5 stable-mount seam.
- `packages/control-plane/package.json` — **extended by this plan:** `rate-limiter-flexible: ^11.0.0`, `prom-client` dependencies.
- `packages/runtime-daemon/test/no-rate-limit-import.test.ts` — **created by this plan.** Daemon-exclusion structural test (A-021-20).
- `docs/architecture/schemas/shared-postgres-schema.md` §Rate Limiting Tables — **already extended (pre-propagated).** Phase 1 verifies DDL parity against §Data And Storage Changes and lands only the audit-ratified deltas (D-021-13 GDPR paragraph; D-021-17 CHECK alignment) — verified field-for-field at the audit (F-021-1-19).
- `docs/architecture/contracts/api-payload-contracts.md` — **already extended (pre-propagated at the Tier-6 audit).** Five-field `RateLimitResponse` (symbol anchor: `interface RateLimitResponse` under §Error Responses); five-field `RateLimitCheckRequest` / two-arm `RateLimitCheckResponse` (window arm: 4-field + `blockUntil?`; fail-open degraded arm: `{allowed: true, degraded: true, graceEndsAt}`, no window fields) under §GDPR And Rate Limiting; AdminBan payloads under §Admin Bans API; `"admin"`/`"ratelimit"` in the illustrative `ErrorNamespace` union; §Relay Rate-Limit Signalling (in-band frame + `4029`/`4003`). The audit applied these edits doc-first so within-Tier-6 Plan-002 Phase 4 (BL-120) consumes a non-contradictory envelope; T21.1-4 verifies shape parity against the typed exports at implementation time and lands only drift fixes.
- `docs/architecture/contracts/error-contracts.md` — **already extended (pre-propagated at the Tier-6 audit).** New `### Admin` codes table (`admin.forbidden` 403, `admin.ban_not_found` 404, `admin.ban_already_exists` 409) and §Rate Limiting enforcement-layer codes (`ratelimit.banned` 403, `ratelimit.backend_unavailable` 503). The 5-field envelope was already canonical there — no envelope edit was needed (F-021-1-18). T21.1-5 verifies code-table parity at implementation time and lands only drift fixes.
- `docs/architecture/deployment-topology.md` §Rate Limiting By Deployment — **amended by this audit** (hosted application-layer cell reworded to the binding-counter + escalation/window-authority-DO split, D-021-3/A-021-3).
- `wrangler.toml` (hosted; Plan-008-owned file, extended at Phase-2 landing) — declare (a) `[[ratelimits]]` bindings one per sliding-window endpoint group + `_ELEVATED` variants for elevated-eligible groups (D-021-4), (b) `[[durable_objects.bindings]]` `{ name = "RATE_LIMIT_ESCALATION", class_name = "RateLimitEscalationDO" }`, (c) a `[[migrations]]` entry adding `RateLimitEscalationDO` to `new_sqlite_classes`, (d) `[vars] AIS_RATELIMIT_BACKEND = "cloudflare"` + `AIS_RATELIMIT_MODE`, and (e) the operator secret `AIS_ADMIN_TOKEN` via `wrangler secret put` (never in `[vars]`).

## Data And Storage Changes

### Postgres: `admin_bans` (new, shared by both deployments)

```
ban_id          UUID         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()
identity        TEXT         NOT NULL
identity_type   TEXT         NOT NULL             -- 'participant' | 'ip' | 'token_hash' | 'session'
issued_by       TEXT         NOT NULL              -- operator attribution per D-021-1 ('deployment-operator' in V1; no participant principal exists on this surface) — no FK; rows survive participant deletion, D-021-13
issued_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
reason          TEXT
expires_at      TIMESTAMPTZ                        -- NULL = permanent (Spec-021 §Escalation, D-021-12)
revoked_at      TIMESTAMPTZ
revoked_by      TEXT                               -- operator attribution of the revoking operator (same semantics as issued_by, D-021-1)
CHECK (identity_type IN ('participant', 'ip', 'token_hash', 'session', 'user'))
```

- **One-active-ban enforcement (I-021-6):** `UNIQUE INDEX idx_admin_bans_one_active ON admin_bans (identity, identity_type) WHERE revoked_at IS NULL`. Postgres treats `NULL` as distinct in standard `UNIQUE` column constraints, so a partial index with `WHERE revoked_at IS NULL` is the correct idiom — it applies uniqueness only to active rows, admitting as many revoked (non-NULL `revoked_at`) rows as history requires.
- **Hot read path:** the `idx_admin_bans_one_active` partial unique index doubles as the ban-check covering index — `findActive` scans `(identity, identity_type) WHERE revoked_at IS NULL` and filters expiry in the query (`AND (expires_at IS NULL OR expires_at > now())`) at execution time. No second expiry-filtered index exists: `now()` is not IMMUTABLE, so it cannot appear in ANY index predicate (the same constraint behind the D-021-12 supersession path).

### Postgres: `rate_limit_escalations` (new, self-host only — hosted uses DO)

```
identity             TEXT         NOT NULL
identity_type        TEXT         NOT NULL
violation_timestamps TIMESTAMPTZ[] NOT NULL DEFAULT '{}'   -- per-violation timestamps; append + prune to the 1-hr horizon on upsert (exact N-in-window ladder; DO parity)
active_block_until   TIMESTAMPTZ
PRIMARY KEY (identity, identity_type)
CHECK (identity_type IN ('participant', 'ip', 'token_hash', 'session', 'user'))
```

- Escalation windows are evaluated exactly, mirroring the DO's array semantics: `recordViolation` appends `now()` to `violation_timestamps` and prunes entries older than 1 hour (the longest window — the same ≤1-hr retention horizon the DO alarm enforces), then evaluates the ladder by filtering the retained array at read time (`>= 3` entries within 5 min → 15-min block; `>= 10` within 1 hr → 1-hr block). An aggregate count + first/last-timestamp triple cannot answer N-in-window (violations at minutes 0, 6, 7 read as three recent ones — over-blocking); per-violation timestamps are the minimal exact representation, and growth is self-bounding (~≤15 entries: violations cannot accrue while a block is active, since the block stage precedes the counter stage per I-021-1). Row is upserted on each violation. The CHECK mirrors `admin_bans` (D-021-17 — it was missing pre-audit, F-021-1-11).

### GDPR erasure dispositions (D-021-13)

`admin_bans` rows — including rows whose `identity_type = 'participant'` matches an erased participant, and rows where the erased participant is `issued_by`/`revoked_by` — are **retained** under the abuse-prevention legitimate-interest carve-out: erasure must not un-ban an identity, and operator attribution must survive. Revoked/expired rows are purgeable after 90 days. `rate_limit_escalations` rows for an erased participant identity are **hard-DELETEd** (ephemeral ≤1-hr operational state). Hosted escalation/window state (`RateLimitEscalationDO`) is **self-evicting** — every stored field is horizon-bounded at ≤1 hr (violation timestamps, blocks, per-group windows) and the single-alarm sweep `storage.deleteAll()`s the instance once all horizons pass (§Durable Object block) — so a hosted participant erasure needs no manual DO step: any in-flight state evaporates ≤1 hr after last activity, within the GDPR Art. 12(3) response window. The CF `[[ratelimits]]` binding counters are non-addressable and expire within their ≤60s declared period. Both dispositions are mirrored in [shared-postgres-schema.md §Rate Limiting Tables](../architecture/schemas/shared-postgres-schema.md), [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md), and the [GDPR manual-erasure runbook](../operations/gdpr-manual-erasure-runbook.md). The TEXT/no-FK choice for `issued_by`/`revoked_by` is deliberate: operator-scope identities, rows must survive participant deletion.

### Postgres: `ratelimit_*` namespace tables (self-host only — NOT owned, NOT migrated)

`rate-limiter-flexible` auto-creates its counter tables on first use (posture ratified at [cross-plan-dependencies.md §1 Plan-021 row](../architecture/cross-plan-dependencies.md#1-table-ownership-map) and Plan-025 §Data And Storage Changes). `PostgresRateLimiter` configures each `RateLimiterPostgres` with a `keyPrefix` namespacing into `ratelimit_*` and leaves table creation to the library. These tables MUST NOT appear in the Phase-1 migration; they hold only ephemeral sliding-window counters (I-021-5) — escalation state lives in `rate_limit_escalations`, never in `ratelimit_*` (A-021-19).

### Durable Object: `RateLimitEscalationDO` (hosted only)

- One DO instance per `(identity, identity_type)` pair, keyed by `idFromName(`${identityType}:${identity}`)`.
- Persisted state (survives worker restart) via DO's built-in storage API: `violation_timestamps: number[]`, `active_block_until: number | null`, plus per-group window state for authoritative `remaining`/`resetAt` (eager-DO, D-021-3; for binding-less hourly groups the window is the counter of record — T21.2-5 step f).
- **Single-alarm scheduling (A-021-19):** Cloudflare permits one scheduled alarm per object and `setAlarm` overrides. On every state change, re-arm to the EARLIEST pending deadline among: oldest `violation_timestamps` entry + 1 hr (the retention horizon), `active_block_until` (block expiry), and the latest per-group window `resetAt` (window expiry). `alarm()` trims entries older than 1 hour — the 5-min ladder is evaluated by filtering the retained array at read time, never by trimming — clears an expired `active_block_until`, drops expired per-group window state, and re-arms if live state remains; once every horizon has passed it calls `storage.deleteAll()` (no per-identity residue survives — the D-021-13 GDPR basis) and the DO idles out with no alarm.
- RPC surface = the `EscalationStore` methods (`recordViolation`, `getActiveBlock`) plus the eager-DO `recordAllowed` window record-and-read — folds an allowed request into per-group window state and returns authoritative `remaining`/`resetAt` in the same round-trip — and `checkAndConsume`, the atomic per-group check+consume that IS the counter for binding-less hourly groups (T21.2-5 step f: refuses over-threshold; no CF binding exists at 1-hr periods); `DurableObjectEscalationStore` is the Worker-side adapter resolving the stub.

### Cloudflare `[[ratelimits]]` bindings (hosted only)

- One binding per **60s-window** sliding-window endpoint group from the Spec-021 registry — the CF binding supports only 10s/60s periods, so hourly rows (`invite.create_session`, `invite.create_participant`, `keypackage.upload`) are DO-tracked on hosted instead — the T21.2-5 step-f `checkAndConsume` branch (see §Open Questions binding-period-cap note), and `approval.resolve` is dormant in V1 (BL-145). Elevated-eligible groups declare a second `<NAME>_ELEVATED` binding with `limit = 3 × <threshold>` (D-021-4). Each binding declared with `period: 60` (or `period: 10` for sub-minute limits) and `limit: <threshold>` per the registry.
- Example (partial):
  ```toml
  [[ratelimits]]
  name = "GENERAL_API_LIMITER"
  namespace_id = "1001" # string containing a positive integer, unique per namespace
  simple = { limit = 100, period = 60 }
  ```
- `namespace_id` integers are allocated sequentially per binding; the allocation table lives in `endpoint-limits.ts` so IDs never collide across deploys (A-021-19).
- The binding exposes only `limit({ key }) → { success }`; declared `limit`/`period` values are NOT runtime-readable. `endpoint-limits.ts` is the canonical config source for both the wrangler block and the in-code values, with a unit test asserting wrangler.toml parity (A-021-19).

### `RateLimitResponse` canonical shape (reconciliation)

There was a pre-existing drift in the contracts docs: api-payload-contracts.md §Error Responses declared `RateLimitResponse` with 4 fields (missing `resetAt`), while error-contracts.md §Rate Limiting declared 5 fields (including `resetAt`). The Tier-6 audit named the 5-field shape canonical (the shape in error-contracts.md) and reconciled api-payload-contracts.md to match, doc-first — before within-Tier-6 Plan-002 Phase 4 (BL-120) consumes the envelope:

```ts
interface RateLimitResponse {
  code: "rate_limited";
  retryAfter?: number; // seconds until retry is allowed — sliding-window/escalation refusals; omitted on concurrency-cap refusals (no reset clock exists)
  limit: number; // total allowed requests in the window (the cap itself on concurrency-cap refusals)
  remaining: number; // requests remaining in the current window
  resetAt?: string; // ISO 8601 timestamp when the limit resets — same enforcement-class rule as retryAfter; the pair is both-present or both-absent (schema-refined)
}
```

Code-level home: `packages/contracts/src/rate-limiter.ts` (T21.1-1) exports the interface + `RateLimitResponseSchema` so Plan-002 Phase 4 (BL-120) and Plan-025 assert against a typed export instead of a doc shape (A-021-18). The api-payload-contracts.md edit was applied at the audit, anchored by symbol (`interface RateLimitResponse` under §Error Responses); T21.1-4 verifies doc-vs-export parity at implementation time. The timing pair (`retryAfter`, `resetAt`) is optional at the type level: required on sliding-window/escalation refusals, omitted on concurrency-cap refusals (Spec-021 §Overflow Response — cap capacity frees on release, not at a clock edge); `RateLimitResponseSchema` encodes the pair both-or-neither via a refinement (`(v.retryAfter === undefined) === (v.resetAt === undefined)`) so a half-timed envelope — e.g. the legacy shape carrying `retryAfter` without `resetAt` — fails parse (T21.1-6).

## API And Transport Changes

### `RateLimiter` contract (new, owned by this plan)

```ts
// packages/contracts/src/rate-limiter.ts
export type RateLimitIdentityType = "participant" | "ip" | "token_hash" | "session" | "user"; // D-021-17 — 'user' reserved dormant for V1.1 keypackage.upload

export type RateLimitTier = "anonymous" | "authenticated" | "elevated";

// Union of the Key column of Spec-021 §Canonical Endpoint Group Registry (D-021-6).
export type RateLimitEndpointGroup =
  | "general.api"
  | "auth.endpoint"
  | "unauthenticated.request"
  | "session.create"
  | "session.join"
  | "invite.create_session"
  | "invite.create_participant"
  | "invite.pending_cap"
  | "invite.accept"
  | "invite.redeem_ip"
  | "presence.heartbeat"
  | "event.query"
  | "event.subscribe"
  | "approval.resolve"
  | "artifact.publish"
  | "artifact.upload.init" // 2026-07-08 cross-node relay amendment (Spec-014); Plan-014 self-wires at Tier 7
  | "artifact.upload.chunk" // 2026-07-08 cross-node relay amendment (Spec-014); Plan-014 self-wires at Tier 7
  | "artifact.fetch.authorize" // 2026-07-08 cross-node relay amendment (Spec-014); Plan-014 self-wires at Tier 7
  | "artifact.fetch.chunk" // 2026-07-08 cross-node relay amendment (Spec-014); Plan-014 self-wires at Tier 7
  | "health.check"
  | "ws.message"
  | "keypackage.upload"; // V1.1+ stub — no V1 endpoint exists

export interface RateLimitCheckRequest {
  identity: string; // canonical form per §Identity And Tier Resolution
  identityType: RateLimitIdentityType;
  endpoint: RateLimitEndpointGroup;
  tier?: RateLimitTier;
  context?: Record<string, unknown>;
}

// Two-arm union: the window arm reports authoritative backend window state; the
// degraded arm is minted ONLY by the fail-open wrapper during grace (A-021-18) and
// carries NO window fields — no authoritative state exists while the backend is
// unreachable, so nothing is sentinel-fabricated. `graceEndsAt` is the truthful
// grace-expiry instant (the fail-closed 503 boundary), never a window reset.
export type RateLimitCheckResponse =
  | {
      allowed: boolean;
      remaining: number;
      resetAt: string; // ISO 8601
      limit: number; // total threshold for this window
      degraded?: never;
      blockUntil?: string; // ISO 8601; set ONLY when the denial is an active escalation block (block pre-check inside check(), D-021-3) — equals the block expiry; the counter-trip-vs-block discriminator
    }
  | { allowed: true; degraded: true; graceEndsAt: string };

export interface RateLimiter {
  check(req: RateLimitCheckRequest): Promise<RateLimitCheckResponse>;
}
```

- The interface intentionally collapses `rate-limiter-flexible` v11.0.0's `RateLimiterCompatibleAbstract` surface (`consume, get, set, delete, penalty, reward, block, getKey`) into a single `check()` because the Cloudflare `rate_limit` binding exposes only `limit({ key })` returning `{ success }`. Escalation composition (block pre-check, violation recording, ladder evaluation) lives INSIDE both `check()` implementations (D-021-3) so the shared contract suite proves the full ladder on both backends and the WS path gets escalation without extra wiring.
- `RateLimiter` and `AdminBansStore` are interface-only (PtyHost precedent); the wire pairs (`RateLimitResponse`, `AdminBan*` request/response) ship interface + Zod schema per the `runtime-node.ts` wire-shape convention (A-021-18).

### `EscalationStore` contract (internal — both escalation backends implement)

```ts
// packages/control-plane/src/rate-limit/escalation/escalation-store.ts
export interface EscalationDecision {
  blocked: boolean;
  blockUntil: string | null; // ISO 8601; set when a threshold tripped
  violationCountWindow5m: number;
  violationCountWindow1h: number;
  escalatedTo1h: boolean; // true exactly when the 10/1-hr threshold trips — the calling limiter emits the T21.4-2 ops-alert pair on this flag (the limiter holds the request's endpoint; the stores never see it, and hosted DO-side emission cannot reach the Worker registry)
}

export interface EscalationStore {
  /** Record one violation (one 429) and evaluate the 3/5-min + 10/1-hr ladders atomically. */
  recordViolation(
    identity: string,
    identityType: RateLimitIdentityType,
  ): Promise<EscalationDecision>;
  /** Read current block state without recording a violation (hot-path pre-check). */
  getActiveBlock(
    identity: string,
    identityType: RateLimitIdentityType,
  ): Promise<{ blockUntil: string } | null>;
}
```

Internal seam co-located with the backends — deliberately NOT in `packages/contracts/` (hoist-only-when-cross-surface rule; the only consumers are this plan's two limiters).

### Admission pipeline (D-021-3)

```ts
// packages/control-plane/src/rate-limit/enforcement-pipeline.ts
export type AdmissionResult =
  | { admitted: true; check: RateLimitCheckResponse }
  | { admitted: false; refusal: "banned"; expiresAt: string | null } // 403 ratelimit.banned — terminal, no counter consumed; expiresAt = admin_bans.expires_at (null = permanent) — the close/Retry-After hint source
  | { admitted: false; refusal: "blocked"; blockUntil: string; check: RateLimitCheckResponse } // 429; active escalation block (check.blockUntil surfaced) — the WS 4029-close arm, retryAfter = blockUntil
  | { admitted: false; refusal: "rate_limited"; check: RateLimitCheckResponse }; // 429; counter trip — the WS in-band-frame arm (connection stays open)

export function createAdmissionCheck(deps: {
  bans: AdminBansStore;
  limiterFor: (endpoint: RateLimitEndpointGroup) => RateLimiter;
  banCacheTtlMs?: number; // default 60_000 (D-021-5)
  onTrip?: (labels: { endpoint: RateLimitEndpointGroup; tier: RateLimitTier }) => void; // fires on EVERY rate-limit refusal (blocked + rate_limited), observe + enforce alike — T21.4-1 binds rate_limit_trip_total (the D-021-16 soak input)
}): {
  check: (req: RateLimitCheckRequest) => Promise<AdmissionResult>; // what middleware/WS consume as `checkAdmission`
  invalidateBanCache: (identity: string, identityType: RateLimitIdentityType) => void; // write-through hook — T21.3-5 calls it on issue/revoke (D-021-5)
};
```

Evaluation order on BOTH transports (I-021-1): **ban → escalation block → counter** — the ban check consults `AdminBansStore.findActive` through an in-memory ≤60s cache (per process on self-host, per isolate on hosted; write-through invalidation in the issuing process = T21.3-5 calling the returned `invalidateBanCache` on issue/revoke, so a cached negative never outlives a ban issued in-process; D-021-5), and the block + counter stages run inside `limiter.check()` — the pipeline discriminates the two by `check.blockUntil` (set → `refusal: "blocked"`, absent → `refusal: "rate_limited"`). Observe mode (D-021-16) is applied by the consumers: checks run and telemetry emits — the pipeline's `onTrip` hook fires on every rate-limit refusal (blocked or rate_limited) regardless of mode, so `rate_limit_trip_total` counts would-be 429s during the observe soak — but rate-limit refusals (trip/block) are not enforced. The banned arm is exempt from observe pass-through: bans are operator-issued enforcement state, not a soak measurand — `ratelimit.banned` enforces in both modes (Spec-021 §Example Flows: a banned identity receives 403 on all future requests).

### Admin bans API (operator-token-authenticated, D-021-1)

```ts
// POST /admin/bans
interface AdminBanCreateRequest {
  identity: string;
  identityType: RateLimitIdentityType;
  reason?: string;
  expiresAt?: string; // ISO 8601; omit for permanent (Spec-021 §Escalation, D-021-12)
}
interface AdminBanCreateResponse {
  banId: string; // UUID
  issuedAt: string;
  expiresAt: string | null;
}

// GET /admin/bans?activeOnly=<bool>&limit=<n>&cursor=<c>   (defaults: activeOnly=true, limit=100)
interface AdminBanListResponse {
  bans: Array<{
    banId: string;
    identity: string;
    identityType: RateLimitIdentityType;
    issuedBy: string;
    issuedAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
    reason: string | null;
  }>;
  nextCursor: string | null;
}

// DELETE /admin/bans/:id
// Response: 204 No Content, or 404 admin.ban_not_found
```

- **Authorization (D-021-1):** all three routes require the deployment's operator admin token as a bearer credential over TLS, compared constant-time, read once at startup. Self-host: the Spec-027 Row 3 first-run relay admin token (Plan-025 generator; canonical on-disk path `./data/admin-token` per BL-135 → D-025-8). Hosted: operator-provisioned Workers secret `AIS_ADMIN_TOKEN` (`wrangler secret put`; Plan-008's deploy-time-secret precedent). Trust-model rationale: ban issuance is a deployment-operator action, not an in-product participant action — no participant role model is required.
- Absent/malformed credential → `401 auth.token_invalid` (existing registry row; no new auth code). Mismatch → `403 admin.forbidden`. `issuedBy` is server-derived from operator context, never body-supplied.
- Race semantics: two concurrent issues for the same `(identity, identity_type)` — the partial unique index rejects the loser (Postgres `23505`), surfaced as `409 admin.ban_already_exists` when the standing ban is active; a standing ban that is expired but not revoked is superseded instead (atomic revoke-then-insert in one transaction, D-021-12). `revoke` of a missing or already-revoked ban → `404 admin.ban_not_found` (not idempotent).
- **Transport (D-021-10):** raw HTTP routes pattern-matched on the host **before** tRPC dispatch (hosted: Workers fetch handler; self-host: Plan-025 Fastify routes). Route shape (`POST/GET/DELETE /admin/bans*`) is mandated by [Spec-021 §Interfaces And Contracts](../specs/021-rate-limiting-policy.md#interfaces-and-contracts); ADR-014's tRPC decision governs the session API surface, and this operator-facing surface follows the spec's explicit REST shape (the ADR's "narrow REST facade" posture).

### Identity and tier resolution (D-021-4, D-021-14)

- **Typed identity pair.** `identityKeyFn` returns `{ identity: string; identityType: RateLimitIdentityType }`; absent the override, resolution is `ctx.participantId` → `{ identity: participantId, identityType: 'participant' }`, else `{ identity: clientIp, identityType: 'ip' }`. The pair always travels together; no bare-string identities.
- **Canonical identity forms (D-021-14):** `participant` = ParticipantId UUID string; `ip` = IPv4 exact dotted-quad / IPv6 normalized to its /64 prefix (lowercase, compressed); `token_hash` = the Plan-002 invite token-hash convention (the same digest stored by the invite store — bans must byte-match the limiter identity); `session` = SessionId UUID; the reserved `'user'` arm (dormant in V1 — no surface constructs it) pins its canonical form at V1.1 `keypackage.upload` activation (ADR-010 account identity). The same canonical forms are written to `admin_bans.identity`.
- **Client IP provenance.** Hosted: the Cloudflare-set `CF-Connecting-IP` header. Self-host: leftmost-untrusted-hop `X-Forwarded-For`, honored ONLY under explicit Fastify trust-proxy configuration for the Caddy hop (Plan-025 propagates the header; the `trustProxy` setting is Plan-025's server bootstrap — reciprocal note recorded on Plan-025). An anonymous-tier request with no resolvable IP is refused 400 rather than rate-limited into a shared bucket.
- **Tier resolution (D-021-4):** auth state yields `anonymous` | `authenticated`. Elevated applies only on registry rows marked elevated-eligible: the wiring passes `resolveTier`, which reads the caller's membership role for the request's target session (shipped `session_memberships` read surface) through the D-021-5 cache; owner → `elevated`. Absent `tier` defaults to the row's base tier, never elevated. Caller-supplied tier values are never trusted.

### tRPC middleware surface (mounts onto Plan-008's host per CP-008-5)

```ts
// packages/control-plane/src/middleware/rate-limit.ts
export const rateLimitProcedure = (opts: {
  endpoint: RateLimitEndpointGroup;
  identityKeyFn?: (ctx: Ctx) => { identity: string; identityType: RateLimitIdentityType };
  resolveTier?: (ctx: Ctx, rawInput: unknown) => Promise<RateLimitTier>; // elevated-eligible rows only
}) =>
  t.middleware(async ({ ctx, getRawInput, next }) => {
    const { identity, identityType } = resolveIdentity(ctx, opts.identityKeyFn); // D-021-14
    const tier = opts.resolveTier
      ? await opts.resolveTier(ctx, await getRawInput())
      : tierFromAuthState(ctx);
    const admission = await ctx.checkAdmission({
      identity,
      identityType,
      endpoint: opts.endpoint,
      tier,
    });
    if (admission.admitted === false) {
      if (admission.refusal === "banned") throw forbidden("ratelimit.banned"); // 403 in BOTH modes — operator enforcement, never observe-suppressed (D-021-16 ban carve-out; Spec-021 §Example Flows)
      if (ctx.rateLimitMode === "enforce") {
        throw tooManyRequests(rateLimitResponseFrom(admission.check)); // 429 + canonical envelope + headers
      }
    }
    // headersFrom: {} for banned arms — headers are a 429/threshold surface, never a ban surface
    return next({ ctx: { ...ctx, rateLimitHeaders: headersFrom(admission) } });
  });
```

- Usage on a procedure: `t.procedure.use(rateLimitProcedure({ endpoint: 'session.create' }))`. The tRPC v11 middleware chaining model is documented in [tRPC v11 middlewares](https://trpc.io/docs/server/middlewares) (uses `.use()` with opts `{ ctx, path, type, input, getRawInput, next }`).
- Header policy: all four headers on sliding-window and escalation-block 429s; concurrency-cap 429s omit `Retry-After`/`X-RateLimit-Reset` and send the truthful subset `X-RateLimit-Limit` + `X-RateLimit-Remaining: 0` (Spec-021 §Overflow Response — cap capacity frees on holder release, not at a reset clock); on allowed responses, headers attach only when `remaining < 25%` of the limit; no headers while `degraded` is set (Spec-021 §Default Behavior; A-021-18); never on the 403 ban path (bans carry no counter state).

### WebSocket per-frame admission (consumed via CP-008-9 hosted; Plan-025 self-host)

```ts
// packages/control-plane/src/middleware/ws-rate-limit.ts
export const wsRateLimit =
  (
    checkAdmission: AdmissionCheck,
    identityExtractor: (conn: WsConnection) => WsIdentity,
    mode: "enforce" | "observe",
    endpointFor: (frame: WsFrame) => RateLimitEndpointGroup = () => "ws.message", // forwardable ciphertext-envelope routing — 1-byte type discriminator only (CP-008-9 metadata, never payload); control frames are broker-dispatched upstream (Plan-008 T-008r-3-9) and never reach this seam
  ) =>
  async (conn: WsConnection, frame: WsFrame): Promise<WsAdmissionOutcome> => {
    const { identity, identityType, tier } = identityExtractor(conn); // connection principal; never payload inspection
    const admission = await checkAdmission({
      identity,
      identityType,
      endpoint: endpointFor(frame),
      tier,
    });
    if (admission.admitted) return { proceed: true };
    if (admission.refusal === "banned") {
      return { proceed: false, close: { code: 4003, retryAfter: banExpiryFrom(admission) } }; // operator enforcement — closes in BOTH modes (D-021-16 ban carve-out); timed ban → expiresAt seconds, permanent → omitted
    }
    if (mode === "observe") return { proceed: true }; // D-021-16 soak: would-be trip/block recorded by checkAdmission telemetry; never frame-drop or close
    if (admission.refusal === "blocked") {
      return {
        proceed: false,
        close: { code: 4029, retryAfter: secondsUntil(admission.blockUntil) },
      }; // escalation-block teardown (D-021-9); the blocked arm carries blockUntil
    }
    return { proceed: false, sendFrame: rateLimitedFrame(admission.check) }; // drop-frame: in-band signal, connection stays open
  };
```

- **Drop-frame semantics (D-021-9):** a counter trip refuses the offending frame only — the caller sends one in-band `rate_limited` error frame (shape registered in [api-payload-contracts.md §Relay Rate-Limit Signalling](../architecture/contracts/api-payload-contracts.md)) and keeps the connection. Close `4029` (WebSocket private range) fires ONLY for active escalation blocks; an active admin ban tears down with the distinct code `4003` (403-class `ratelimit.banned` analog — Spec-021 §WebSocket Overflow Response), never `4029`. Single-signal contract: the hook returns the outcome; the CALLER (relay frame handler) performs the send/close — the hook never writes to the connection.
- **Observe mode (D-021-16):** `mode` is factory-provided at construction (`createRateLimiterFactory` reads `AIS_RATELIMIT_MODE` once — T21.2-7), mirroring the tRPC middleware's `ctx.rateLimitMode`. In observe, tripped/blocked frames still return `{ proceed: true }` — `checkAdmission` telemetry records the would-be refusal, but no `rate_limited` frame is sent and no `4029` close fires. The banned arm is exempt (D-021-16 ban carve-out): bans are operator enforcement, not a soak measurand — banned connections close with `4003` in both modes.
- **Per-frame endpoint routing:** `endpointFor` selects the registry group from the decoded envelope's 1-byte `type` discriminator only (ciphertext-envelope metadata — the CP-008-9 seam exposes no payload). The relay's 1-byte `RelayFrameType` ([Spec-008](../specs/008-control-plane-relay-and-session-join.md) §Message Framing; the contracts wire enum per [Plan-008](./008-control-plane-relay-and-session-join.md) T-008r-1-3) carries **two** V1 frame categories — **forwardable pairwise-ciphertext envelopes** and **broker-handled control frames** (bundle post/distribution, keepalive, close). Only the forwardable-envelope category transits the CP-008-9 opaque-forward seam this hook binds into (T-008r-3-3 decodes ciphertext-envelope metadata only), so `endpointFor` maps it → `ws.message`; the broker-handled control frames are dispatched on Plan-008's broker control path ([Plan-008](./008-control-plane-relay-and-session-join.md) T-008r-3-9) — **not** metered as `ws.message`, **not** a Plan-021 registry row (their admission is Plan-008's). The seam is retained (not inlined into `wsRateLimit`) because it is the CP-021-3-exported contract Plan-025 consumes — a ratified Tier-6-audit signature, out of scope to change here. `presence.heartbeat` is **not** reachable here: presence heartbeats ride the WebSocket (JSON-RPC 2.0) collaboration channel ([Spec-002](../specs/002-invite-membership-and-presence.md) §Heartbeat Transport; [Spec-008](../specs/008-control-plane-relay-and-session-join.md) §Control-Plane Transport Protocol), not the relay WSS binary frames, so no relay `type` byte can carry one.
- Zero-knowledge constraint (CP-008-9): the hosted seam exposes ciphertext-envelope metadata + the authenticated connection principal only; identity = the connection's PASETO-resolved participant.

### Standard headers on 429 responses

Sliding-window and escalation-block 429 responses must set:

- `X-RateLimit-Limit: <limit>`
- `X-RateLimit-Remaining: 0`
- `X-RateLimit-Reset: <unix-timestamp-seconds>`
- `Retry-After: <seconds>` — formula: `max(0, ceil((resetAt - now) / 1000))`. For the Postgres sliding-window backend, `resetAt` is "the time the oldest counted request ages out of the window" (the oldest in-window hit's timestamp plus the window duration). For the Cloudflare backend, `resetAt` is the DO-tracked authoritative window state (eager-DO, D-021-3); for an active block, `resetAt = active_block_until` (also surfaced as the check's `blockUntil` discriminator).

Concurrency-cap 429s send only the truthful subset `X-RateLimit-Limit` + `X-RateLimit-Remaining: 0`: no reset clock exists — capacity frees when an existing holder releases, not at a window edge — so the timing pair (`X-RateLimit-Reset`, `Retry-After`) is omitted rather than fabricated (Spec-021 §Overflow Response).

## Invariants

| ID | Invariant | Verified by |
| --- | --- | --- |
| I-021-1 | Admission order is ban → escalation block → counter on every enforced transport: a banned identity receives 403 `ratelimit.banned` without consuming counter capacity; an actively-blocked identity receives 429 with block-remaining `Retry-After`; only clean identities reach the counter. The daemon IPC path is reachable by NO admission stage. | T21.3-2 pipeline unit tests; T21.4-3 banned-403 integration row; daemon-exclusion structural test (T21.3-6). |
| I-021-2 | Both `RateLimiter` backends enforce identical limits and expose identical `check()` semantics for every canonical endpoint group; backend selection is configuration-only. | `rate-limiter-contract-suite.ts` (T21.2-9) green against both backends in CI; Plan-025 re-runs it at Tier 7 (CP-021-3). |
| I-021-3 | An identity with `active_block_until > now` is rejected on every check until expiry, independent of counter capacity. | T21.2-9 block-window behavioral rows (both ladders, both backends — capacity-restored-but-blocked assertions). |
| I-021-4 | Backend failure yields fail-open for at most the configured grace per wrapper scope, then 503 `ratelimit.backend_unavailable`; degraded responses carry no window fields at all (the degraded union arm) and serialize zero rate-limit headers. | T21.2-8 fail-open unit rows (grace expiry → throw; degraded header suppression); T21.4-3 grace-expiry 503 integration row. |
| I-021-5 | Storage split: sliding-window counters are ephemeral (binding state / `ratelimit_*`); escalation state persists for its window in `rate_limit_escalations` / DO storage; bans persist durably in `admin_bans`. | Migration review (no `ratelimit_*` DDL, T21.1-3); DO-restart persistence test (T21.2-4); migration-shape test (T21.1-3). |
| I-021-6 | At most one non-revoked ban row exists per `(identity, identity_type)` (partial unique index); 23505 surfaces as `admin.ban_already_exists` only when the standing ban is active — an expired standing ban is atomically superseded on issue (revoke-then-insert, D-021-12). | T21.1-3 migration-shape test (duplicate active insert raises 23505; revoked-history insert succeeds); T21.3-1 store-level 409 mapping + expired-supersession tests. |
| I-021-7 | The check request/response and the 429 `RateLimitResponse` envelope have exactly one canonical shape — identical in Spec-021 §Interfaces, error-contracts.md, api-payload-contracts.md, and `packages/contracts/src/rate-limiter.ts`. | contracts docs pre-propagated at the Tier-6 audit; T21.1-4/T21.1-5 parity verification at implementation; T21.1-6 schema tests (5-field parses; legacy 4-field + half-timed envelopes rejected); cross-doc drift re-checked at PR review. |
| I-021-8 | Rate-limit metric labels are compile-time-enumerable, PII-free, and emission-time-enforced per Plan-020 §Prometheus /metrics Exposition; total series across the plan's families < 50. | T21.4-1 unit tests (out-of-allow-list label throws per family; series-count assertion). |

## Cross-Plan Obligations

| ID | Direction | Counterparty | Obligation | Anchor |
| --- | --- | --- | --- | --- |
| CP-021-1 | consumes ← | Plan-008-remainder (Tier 5) | CP-008-5 stable tRPC middleware-mount surface that `rateLimitProcedure` mounts onto; Plan-008 authors no rate-limit task. The admin-route pre-tRPC match and the DO class export are export-only edits inside the same stable-mount seam. | [Plan-008 CP-008-5](./008-control-plane-relay-and-session-join.md#cross-plan-obligations) (return-cite) |
| CP-021-2 | provides → | Plan-002 Phase 4 (BL-120; within-Tier-6, lands after this plan) | `rateLimitProcedure({ endpoint })` middleware factory + the canonical 429 `RateLimitResponse` (typed export) that the invite-endpoint tests assert; `invite.*` registry keys reserved in `RateLimitEndpointGroup`. | [BL-120](../backlog.md); cross-plan-dependencies.md §3 Plan-002 row |
| CP-021-3 | provides → | Plan-025 remainder (Tier 7) | `RateLimiter` contract + `PostgresRateLimiter` (constructor: injected `pg.Pool` + `endpoint-limits` + `EscalationStore`) + `AdminBansStore` + admin-bans routes + `wsRateLimit`, instantiated not re-implemented; the `AIS_RATELIMIT_BACKEND` / `AIS_RATELIMIT_FAILOPEN_SECONDS` / `AIS_RATELIMIT_MODE` env contract; the exported contract suite at `packages/control-plane/src/rate-limit/rate-limiter-contract-suite.ts` (Plan-025 §Test re-runs it). | Plan-025 §Dependencies / §Preconditions / step 7 / §Test |
| CP-021-4 | consumes ← | Plan-020 (Tier 8) | §Prometheus /metrics Exposition label invariants (doc contract only — no Plan-020 code consumed; no tier inversion). Reciprocal: the canonical `rate_limit_*` family set supersedes the former daemon-side `rate_limit_trip_total{bucket}` registry row (D-021-8; Plan-020 registry amended at this audit's swap). | [Plan-020 §Prometheus /metrics Exposition](./020-observability-and-failure-recovery.md#prometheus-metrics-exposition-spec-027-row-9) |
| CP-021-5 | consumes ← | Plan-008 R3 (Tier 5) | CP-008-9 per-decoded-frame admission seam on the zero-knowledge DO relay broker (ciphertext-envelope metadata + connection principal only) into which `wsRateLimit` injects on the hosted path. | [Plan-008 CP-008-9](./008-control-plane-relay-and-session-join.md#cross-plan-obligations) |

### Endpoint wiring ownership (D-021-6)

`rateLimitProcedure` is NOT applied by iterating the spec registry; ownership is explicit:

| Endpoint group (canonical key) | Procedure owner | Wiring owner + mechanism |
| --- | --- | --- |
| `session.create` / `session.join` + `general.api` fallback | Plan-008 (shipped surface) | Plan-021 T21.3-6 (Tier 6) |
| `presence.heartbeat` | Plan-002/Plan-008 (Tier 5) | — (not wired in V1): heartbeats ride the **WebSocket (JSON-RPC 2.0)** collaboration channel ([Spec-002](../specs/002-invite-membership-and-presence.md) §Heartbeat Transport; [Spec-008](../specs/008-control-plane-relay-and-session-join.md) §Control-Plane Transport Protocol), which is neither a tRPC procedure (nothing for `rateLimitProcedure` to wrap) nor a relay binary frame (the `endpointFor` seam decodes only the 1-byte ciphertext-envelope `type` and cannot admit a JSON-RPC message); no JSON-RPC-WS message-admission surface ships in V1, so the row stays priced/reserved (10/min) — the JSON-RPC-WS admission surface is the V1.1 wiring point (mirrors the `approval.resolve` / `keypackage.upload` reserved-row pattern — see [Spec-021](../specs/021-rate-limiting-policy.md) §Registry semantics for the live-channel distinction from `approval.resolve`) |
| `event.query` | Plan-008 SSE/query surface | Plan-021 T21.3-6 for shipped procedures |
| `event.subscribe` (5 concurrent — concurrency_cap) | Plan-008 SSE subscription registry | SSE surface owner per [BL-144](../backlog.md) (store-side cap, mirrors the BL-120 pattern) |
| `health.check` | Plan-008 host (+ Plan-025 self-host) | Plan-021 T21.3-6 (hosted); Plan-025 step 7 (self-host) |
| `invite.create_session` / `invite.create_participant` / `invite.accept` / `invite.redeem_ip` / `invite.pending_cap` | Plan-002 | Plan-002 Phase 4 self-wires per [BL-120](../backlog.md) (NOT this plan; pending-cap is store-side) |
| `approval.resolve` | — (dormant in V1) | No V1 wiring surface: Plan-012's transport is daemon JSON-RPC only (D-012-5; api-payload §Approval Method-Name Registry) and Spec-021 excludes daemon IPC from rate limiting (§Scope, §Non-Goals, AC). Row stays priced/reserved; [BL-145](../backlog.md) re-arms it on the Spec-021 §ADR Triggers topology condition |
| `artifact.publish` | Plan-014 (Tier 7) | Plan-014 self-wires at Tier 7 per [BL-146](../backlog.md) (mirrors BL-120) |
| `artifact.upload.init` / `artifact.upload.chunk` / `artifact.fetch.authorize` / `artifact.fetch.chunk` | Plan-014 (Tier 7) | Plan-014 self-wires at Tier 7 with the relay upload/fetch routes (2026-07-08 Spec-021 cross-node relay amendment; scope folded into [BL-146](../backlog.md), mirroring the `artifact.publish` row) |
| `ws.message` | Plan-008 R3 relay (hosted) / Plan-025 (self-host) | Plan-021 T21.3-4 via CP-008-9 (hosted); Plan-025 steps 7-8 (self-host) |
| `auth.endpoint` / `unauthenticated.request` | Plan-018/Plan-008 auth + unauthenticated procedures | Plan-021 T21.3-6 (fallback buckets + auth group over shipped procedures) |
| `keypackage.upload` | none in V1 | not wired (V1.1+ stub) |

## Ratified Design Decisions (Tier-6 audit)

| ID | Decision |
| --- | --- |
| D-021-1 | Admin-bans authorization = operator admin token (bearer over TLS, constant-time compare, startup-injected). Self-host: Spec-027 Row 3 relay admin token (Plan-025 generator; path `./data/admin-token`, BL-135 → D-025-8). Hosted: Workers secret `AIS_ADMIN_TOKEN`. Absent/malformed → 401 `auth.token_invalid`; mismatch → 403 `admin.forbidden`. Cedar/`admin.ratelimit.*` removed (no control-plane Cedar surface exists; ADR-012 is daemon-embedded); Plan-018 dependency narrows to `AuthenticatedIdentityContext`. Attribution: `issued_by`/`revoked_by` store the operator constant `deployment-operator` in V1 — the single shared token carries no per-operator identity and no participant principal exists on this surface; a future per-operator-credential ADR would store its identifier instead. |
| D-021-2 | Hosted WS frame seam = CP-008-9 minted on Plan-008 R3: per-decoded-frame admission seam, ciphertext-envelope metadata + connection principal only (I-008-5 preserved). Self-host path independent (Plan-025 steps 7-8). |
| D-021-3 | Eager-DO + two-layer composition: escalation (block pre-check, counter, violation recording) inside `RateLimiter.check()` on both backends; ban enforcement in `checkAdmission` (ban → limiter). Hosted DO consulted on every check (cost priced + accepted in §Risks). |
| D-021-4 | Elevated tier implemented for session owners: per-`(endpoint group, tier)` limiter variants (CF `_ELEVATED` bindings at 3×; PG per-pair instances); `resolveTier` membership-role hook on elevated-eligible rows; absent tier never defaults to elevated; Spec-021 narrows `elevated` to session-owner ("system service" removed — no V1 service principal). |
| D-021-5 | Bounded-staleness identity reads: ban lookups + membership-role reads cached in-memory ≤60s per process/isolate, write-through invalidation in the issuing process; ban/revoke propagation bound ≤60s documented. |
| D-021-6 | Spec-021 §Canonical Endpoint Group Registry is the single limit enumeration with canonical keys; stacked invite-redemption rows (`invite.redeem_ip` 5/IP/min + `invite.accept` 10/min/token-hash); `general.api`/`unauthenticated.request` fallback buckets; concurrency-cap rows enforced store-side by named owners; step-10-style census replaced by the §Endpoint Wiring Ownership table; BL-144/145/146 mint the later-landing wiring obligations. |
| D-021-7 | Escalation ops-alert = alertable telemetry: `rate_limit_block_total{window_size="1h"}` increment + one structured warning log with bounded PII-free fields. No Spec-006 session event (daemon-written, session-scoped; control-plane escalations have neither). |
| D-021-8 | Canonical metric family set (snake spelling per Spec-027; labels per this plan): `rate_limit_trip_total{endpoint,tier}`, `rate_limit_block_total{window_size}`, `rate_limit_backend_error_total{backend}`, `rate_limit_failclosed_total{backend}`, `admin_ban_total{action}`. Plan-020's daemon-side `rate_limit_trip_total{bucket}` registry row removed (daemon has no enforcer); Spec-027 rows 9a/9b reconciled; Plan-025 export list collapsed to the canonical set. |
| D-021-9 | WS overflow = drop-frame: counter trip refuses the frame with one in-band `rate_limited` frame and keeps the connection; close `4029` only on an active escalation block; an active admin ban closes with distinct code `4003` (403-class refusal — never `4029`), in observe mode too. Frame + both close codes registered in api-payload-contracts §Relay Rate-Limit Signalling. |
| D-021-10 | Admin transport = raw HTTP routes pattern-matched before tRPC dispatch on the host (hosted Workers fetch; self-host Plan-025 Fastify). Spec-021 route shape satisfied verbatim; ADR-014 narrow-REST-facade posture recorded. |
| D-021-11 | Migration = `NNNN-rate-limit-tables.ts` exporting inline SQL reproduced verbatim from shared-postgres-schema §Rate Limiting Tables (incl. owner stamps + CHECKs), registered in the migration-runner `MIGRATIONS` array; NNNN assigned at landing by append-order. |
| D-021-12 | Admin bans MAY carry `expiresAt` (NULL = permanent) and `GET /admin/bans` is spec-ratified; time-limited admin bans are distinct from automated escalation blocks. `list()` paginated (`activeOnly` default true, limit 100, cursor). Expired-but-unrevoked bans are superseded on issue: the issue path atomically revokes the expired row (`revoked_at := now()`, `revoked_by :=` operator attribution) and inserts the new ban in one transaction, so `admin.ban_already_exists` fires only on a genuinely active (non-revoked, non-expired) conflict — the partial unique index cannot test expiry (`now()` is not IMMUTABLE). |
| D-021-13 | GDPR: `admin_bans` retained under the abuse-prevention legitimate-interest carve-out (erasure never un-bans; operator attribution survives; revoked/expired rows purgeable after 90 days); `rate_limit_escalations` hard-DELETE on erasure + active sweep of fully-expired rows (`PostgresEscalationStore.sweepExpired()`, 10-min interval via Plan-025 — a quiet identity's row never outlives `GREATEST(last violation + 1 hr, block expiry)`); hosted `RateLimitEscalationDO` state self-evicts (all fields horizon-bounded ≤1 hr; alarm `deleteAll` once expired — no manual DO erasure step). Spec-022 fan-out + erasure runbook + schema doc annotated. |
| D-021-14 | Typed identity pair from `identityKeyFn`; canonical forms (participant UUID; IPv4 exact / IPv6 /64; Plan-002 token-hash convention; session UUID; reserved `'user'` arm pinned at V1.1 activation); IP provenance = `CF-Connecting-IP` (hosted) / `X-Forwarded-For` under explicit trust-proxy (self-host, Plan-025 reciprocal); missing IP on anonymous endpoint → 400. |
| D-021-15 | Hosted metrics exposition = explicit V1 gap: hosted counters degrade to structured-log emission; self-host exposition = Plan-025 relay `GET /metrics` (Tier 7); Plan-021 ships registration + emission only (injectable registry). |
| D-021-16 | `AIS_RATELIMIT_MODE={enforce\|observe}` read once at factory construction (deploy-time; preserves the no-runtime-kill-switch stance). Rollout soak = 24h observe-mode in production (no staging environment exists); FP-rate gate < 0.1% measured as would-be-429s issued to identities whose logged request rate never exceeded the configured limit ÷ total would-be-429s (plan-local target). The inert `AIS_RATELIMIT_FAILOPEN_SECONDS=999999` rollback lever is deleted. Observe suppresses rate-limit refusals only (trips + escalation blocks): the banned arm enforces in both modes — operator-issued bans are not part of the FP measurand and a soak/rollback posture must not bypass them. |
| D-021-17 | `RateLimitIdentityType` gains `'session'` plus the reserved dormant `'user'` arm (the V1.1 `keypackage.upload` row is scoped per user — pre-reserving keeps activation schema-change-free per §Explicitly Out of Scope); both tables' `identity_type` CHECK constraints carry the five values; per-session registry rows key on the session identity. |

## Implementation Phase Sequence

### Phase 1 — Contracts + Schema + Doc Reconciliation

**Goal:** land the typed contract surface, the Postgres migration, and the contracts-doc reconciliation so every later phase builds against canonical shapes.

**Precondition:** Spec-021 registry amendment landed (this audit's swap). No code preconditions beyond the shipped contracts package + migration runner.

#### Tasks

- [ ] **T21.1-1 — `packages/contracts/src/rate-limiter.ts`.** Author `RateLimitIdentityType` (5 values incl. the reserved dormant `'user'` arm, D-021-17), `RateLimitTier`, `RateLimitEndpointGroup` (registry-key union, D-021-6), `RateLimitCheckRequest` (5-field), `RateLimitCheckResponse` (two-arm union — window arm: 4-field + `blockUntil?`; fail-open degraded arm: `{allowed: true, degraded: true, graceEndsAt}`, no window fields), `RateLimiter` interface (interface-only, PtyHost precedent), `RateLimitResponse` wire envelope + `RateLimitResponseSchema` (Zod; timing pair `.optional()` with a both-or-neither refinement — concurrency-cap refusals omit `retryAfter`/`resetAt`, sliding-window/escalation refusals carry both, Spec-021 §Overflow Response); re-export from `packages/contracts/src/index.ts`.
  - **Spec coverage:** Spec-021 line 131 (five-field check shape), line 48 (same programmatic interface both backends), line 152 (single `RateLimiter` interface), line 117 (standard `RateLimitResponse` envelope)
  - **Verifies invariant:** I-021-7
  - **Consumes:** Spec-021 §Canonical Endpoint Group Registry (amended at this audit — shipped doc contract); zod (workspace dep).
- [ ] **T21.1-2 — `packages/contracts/src/admin-bans.ts`.** Author `AdminBan`, `AdminBansStore` (typed signatures: `issue` with 23505 → already-exists semantics; non-idempotent `revoke`; paginated `list({ activeOnly = true, limit = 100, cursor })`; indexed `findActive`), and the `AdminBanCreateRequest`/`AdminBanCreateResponse`/`AdminBanListResponse` wire pairs + Zod schemas; reuse `RateLimitIdentityType` (no `BanIdentityType`); `issuedBy` server-derived, never body-supplied; index.ts re-export.
  - **Spec coverage:** Spec-021 line 133 (admin API POST + GET + DELETE shapes), line 104 (permanent bans exclusively via admin API), line 105 (ban expiry semantics), line 141 (durable ban shape)
  - **Verifies invariant:** I-021-6 (contract layer: typed already-exists error), I-021-7
  - **Consumes:** `RateLimitIdentityType` ← T21.1-1 (same Phase).
- [ ] **T21.1-3 — Migration `packages/control-plane/src/migrations/NNNN-rate-limit-tables.ts`.** Version = next free at landing (append-order, cross-plan §5). Export `RATE_LIMIT_TABLES_MIGRATION_SQL` reproducing shared-postgres-schema.md §Rate Limiting Tables VERBATIM (incl. `-- Owner: Plan-021` stamps + both CHECK constraints per D-021-17); register `{ version: NNNN, sql: RATE_LIMIT_TABLES_MIGRATION_SQL }` in the `MIGRATIONS` array in `packages/control-plane/src/sessions/migration-runner.ts`. Migration-shape test (PGlite, repo precedent — testcontainer fallback only if `rate-limiter-flexible` proves PGlite-incompatible, recorded at implementation): both tables exist with documented columns/types/nullability (incl. `violation_timestamps TIMESTAMPTZ[] NOT NULL DEFAULT '{}'`) + the single `idx_admin_bans_one_active` partial unique index — the only secondary index; no expiry-filtered companion exists (`now()` is not IMMUTABLE) — via information_schema/pg_indexes; re-apply is a no-op; duplicate active-ban insert raises 23505 (I-021-6); insert-after-revoke succeeds; `identity_type` outside the 5-value set (incl. reserved `'user'`, D-021-17) is rejected by CHECK.
  - **Spec coverage:** Spec-021 line 141 (bans stored durably, survive restarts), line 140 (escalation state persisted for the escalation window — self-host table)
  - **Verifies invariant:** I-021-5, I-021-6
  - **Consumes:** `applyMigrations` `MIGRATIONS` registry seam ← Plan-001 runner (shipped; v3 registration precedent [GitHub PR-#145](https://github.com/Sawmonabo/ai-sidekicks/pull/145)).
- [ ] **T21.1-4 — api-payload-contracts.md parity verification.** The Tier-6 audit pre-propagated the reconciliation (5-field `interface RateLimitResponse` (timing pair optional) under §Error Responses; 5-field `RateLimitCheckRequest` / two-arm `RateLimitCheckResponse` (window arm: 4-field + `blockUntil?`; degraded arm: `{allowed: true, degraded: true, graceEndsAt}`) under §GDPR And Rate Limiting; AdminBan\* payloads under §Admin Bans API; `"admin"`/`"ratelimit"` in the illustrative `ErrorNamespace` union; §Relay Rate-Limit Signalling frame + close codes `4029` (block) / `4003` (ban) per D-021-9). This task verifies, field-for-field, that each documented shape matches the T21.1-1/T21.1-2 typed exports, and lands ONLY drift fixes (any divergence that crept in between audit-merge and implementation). No-drift outcome = no doc edit; record the parity check in the PR description.
  - **Spec coverage:** Spec-021 line 134 (api-payload-contracts holds the typed request/response schemas), line 117 (standard envelope), line 96 (WS overflow signalling shape)
  - **Verifies invariant:** I-021-7
  - **Consumes:** pre-propagated api-payload-contracts.md §Spec-021 sections (Tier-6 audit); error-contracts.md §Rate Limiting 5-field envelope (already canonical pre-audit — no envelope edit was needed there); T21.1-1 + T21.1-2 exports (same Phase).
- [ ] **T21.1-5 — error-contracts.md parity verification.** The Tier-6 audit pre-propagated the code tables: `### Admin` (`admin.forbidden` 403 — operator-token mismatch on the admin-bans surface per D-021-1; `admin.ban_not_found` 404; `admin.ban_already_exists` 409 — losing side of the one-active-ban race, Postgres 23505) and the §Rate Limiting enforcement-layer rows (`ratelimit.banned` 403 — active admin ban matches the identity; `ratelimit.backend_unavailable` 503 — fail-closed after grace). This task verifies every code the implementation emits resolves to a registered row (the admin-route 401 path maps to the EXISTING `auth.token_invalid` row — no new auth code) and lands ONLY drift fixes. No-drift outcome = no doc edit; record the parity check in the PR description.
  - **Spec coverage:** Spec-021 line 135 (error-contracts holds error response schemas and error codes), line 148 (banned identity receives 403)
  - **Verifies invariant:** I-021-7 (registry side)
  - **Consumes:** pre-propagated error-contracts.md `### Admin` + §Rate Limiting tables (Tier-6 audit); D-021-1 adjudicated auth mechanism (ratified at this audit).
- [ ] **T21.1-6 — Contracts schema tests (`packages/contracts/src/__tests__/`).** AdminBan\* request/response Zod schemas round-trip the documented example payloads; `RateLimitResponseSchema` parses the 5-field envelope and rejects the legacy 4-field shape and any half-timed envelope (`retryAfter` without `resetAt`, and vice versa — the both-or-neither refinement); `RateLimitEndpointGroup` union matches the registry key census (snapshot of the 22 keys — the four `artifact.*` relay keys joined via the 2026-07-08 Spec-021 amendment).
  - **Spec coverage:** Spec-021 line 117 (canonical envelope), line 131 (check shape)
  - **Verifies invariant:** I-021-7
  - **Consumes:** T21.1-1 + T21.1-2 exports (same Phase).

### Phase 2 — Backends

**Goal:** both `RateLimiter` implementations, both escalation stores, factory, fail-open wrapper, and the parity proof (shared contract suite).

**Precondition:** Phase 1 shipped.

#### Tasks

- [ ] **T21.2-1 — `endpoint-limits.ts`.** Canonical endpoint-group → `{ limit, periodSeconds, tierEligible, enforcementClass, namespaceId }` table transcribed from the Spec-021 registry; exported as the single config source for both backends, wrangler authoring, and header values. Unit test parses the repo's wrangler.toml (when present) and asserts every `[[ratelimits]]` binding's `simple = { limit, period }` + `namespace_id` matches this module (drift guard).
  - **Spec coverage:** Spec-021 line 54 (registry table header — single enumeration), line 48 (identical limits)
  - **Verifies invariant:** I-021-2
  - **Consumes:** `RateLimitEndpointGroup` ← T21.1-1.
- [ ] **T21.2-2 — `escalation/escalation-store.ts`.** Author the internal `EscalationStore` + `EscalationDecision` contract per §API And Transport Changes (atomic `recordViolation` ladder evaluation; `getActiveBlock` hot-path read).
  - **Spec coverage:** Spec-021 line 100 (3/5-min ladder), line 101 (10/1-hr ladder), line 102 (block keying + full-window enforcement)
  - **Verifies invariant:** I-021-3 (contract layer)
  - **Consumes:** `RateLimitIdentityType` ← T21.1-1.
- [ ] **T21.2-3 — `escalation/postgres-escalation-store.ts`.** Append-and-prune upsert on `rate_limit_escalations.violation_timestamps` per violation inside `recordViolation` (single statement or transaction — atomic ladder evaluation: prune to the 1-hr horizon, then array-filter both windows exactly per §Data And Storage Changes); `getActiveBlock` indexed read; `sweepExpired()` bulk-DELETE of fully-expired rows (`GREATEST(max(violation_timestamps) + interval '1 hour', COALESCE(active_block_until, '-infinity')) < now()`) — the self-host mirror of the DO self-eviction alarm (D-021-13 ephemerality; live cardinality self-bounds to recently-violating identities, so the periodic full-scan DELETE needs no companion column or index). Sweep test: a fully-expired row is deleted; a recent-violation or active-block row survives.
  - **Spec coverage:** Spec-021 line 140 (escalation state persisted for the window), line 100 (15-min block), line 101 (1-hr block)
  - **Verifies invariant:** I-021-3, I-021-5
  - **Consumes:** `EscalationStore` ← T21.2-2; `rate_limit_escalations` ← T21.1-3; `pg` (injected client seam — production pool is Plan-025's, tests inject PGlite/testcontainer per T21.1-3's harness note).
- [ ] **T21.2-4 — `escalation/durable-object-escalation-store.ts`.** `RateLimitEscalationDO` class (storage fields + single-alarm earliest-deadline scheduling per §Data And Storage Changes; RPC = `recordViolation`/`getActiveBlock` + `recordAllowed` eager window record-and-read + `checkAndConsume` hourly binding-less counter) + `DurableObjectEscalationStore` Worker-side adapter (`idFromName(`${identityType}:${identity}`)`). Export the DO class from `packages/control-plane/src/server/host.ts` (export-only edit, CP-021-1 seam). DO-restart persistence test (storage survives; alarm re-arms) + full-expiry eviction test (alarm `deleteAll`s storage once violations, block, and windows have all passed their horizons — D-021-13) + hourly counter row (21st `invite.create_session` consume in 1 hr refused atomically, `resetAt` = window expiry).
  - **Spec coverage:** Spec-021 line 140 (escalation state persisted), line 102 (block enforced for full window)
  - **Verifies invariant:** I-021-3, I-021-5
  - **Consumes:** `EscalationStore` ← T21.2-2; Cloudflare DO runtime (`@cloudflare/workers-types` for types); wrangler DO binding + migration declaration (§Target Areas wrangler deliverable).
- [ ] **T21.2-5 — `cloudflare-rate-limiter.ts`.** `CloudflareWorkersRateLimiter implements RateLimiter`, eager-DO (D-021-3): (a) `getActiveBlock` first — active block → `{ allowed: false, remaining: 0, resetAt: blockUntil, blockUntil, limit }` WITHOUT consuming the binding (`blockUntil` is the trip-vs-block discriminator the admission pipeline and WS 4029 close path read — D-021-3); (b) select binding by `(endpoint, tier)` — elevated routes to `<NAME>_ELEVATED` (D-021-4); (c) `env.<LIMITER>.limit({ key })`; (d) on `success: false`, `recordViolation` and fold the `EscalationDecision`; (e) on `success: true`, `recordAllowed` — fold the allowed request into the DO's per-group window and return its authoritative `remaining`/`resetAt` in the same round-trip (success-recording is what keeps the window state authoritative — eager-DO, D-021-3); (f) binding-less hourly groups (`invite.create_session` 20/hr, `invite.create_participant` 50/hr; `keypackage.upload` stub — no CF binding exists at 1-hr periods, §Cloudflare bindings): skip (b)–(e) and call DO `checkAndConsume({ key, group, limit, windowSeconds })` — the Worker passes the registry-resolved threshold (including the 3× elevated variant, D-021-4) and the DO atomically evaluates + consumes the per-group hourly window, refusing over-threshold with authoritative `remaining`/`resetAt`; a refusal folds the same `recordViolation` ladder path as a binding trip. DO round-trip failure falls through to the fail-open wrapper semantics.
  - **Spec coverage:** Spec-021 line 47 (hosted = Cloudflare `rate_limit` binding), line 102 (block supersedes counter), line 115 (elevated 3× via eligible-row variants), line 61 + line 62 (hourly rows — DO `checkAndConsume` branch, no binding at 1-hr periods)
  - **Verifies invariant:** I-021-2, I-021-3
  - **Consumes:** `RateLimiter` ← T21.1-1; `endpoint-limits.ts` ← T21.2-1; `EscalationStore` ← T21.2-2/T21.2-4; `[[ratelimits]]` bindings (wrangler deliverable).
- [ ] **T21.2-6 — `postgres-rate-limiter.ts`.** `PostgresRateLimiter implements RateLimiter` wrapping `RateLimiterPostgres`, one instance per `(endpoint group, tier variant)` (D-021-4), `pg.Pool` constructor-injected (`storeClient` — never constructed; Plan-025 is the production instantiator, CP-021-3), points/duration from `endpoint-limits.ts`, `keyPrefix` namespacing into `ratelimit_*` with library-managed creation. Same internal composition as T21.2-5 (block pre-check → consume → recordViolation on trip). Add `rate-limiter-flexible: ^11.0.0` to `packages/control-plane/package.json`; contract suite asserts `semver.gte(installedVersion, '11.0.0')` (documented-pin → enforced-pin). Postgres TLS posture (`sslmode=verify-full`; refusal table per Spec-027 row 5, CVE-2024-10977 — fixed in PG 17.1/16.5/15.9/14.14/13.17/12.21) is enforced where the connection string is parsed: Plan-025's config loader (Spec-027 row-5 ownership). This class documents the requirement on the injected pool and the contract suite exercises a `parsePostgresConfig()` refusal-table assertion; it does not parse connection strings.
  - **Spec coverage:** Spec-021 line 47 (self-host = rate-limiter-flexible + Postgres), line 153 (sliding window), AC7 (line 172 — identical limits, via shared suite)
  - **Verifies invariant:** I-021-2, I-021-3, I-021-5
  - **Consumes:** `RateLimiter` ← T21.1-1; `endpoint-limits.ts` ← T21.2-1; `EscalationStore` ← T21.2-2/T21.2-3; `rate-limiter-flexible@^11.0.0` (npm); `pg.Pool` (injected — production provider Plan-025 step 7 at Tier 7; test provider per T21.1-3 harness note).
- [ ] **T21.2-7 — `factory.ts`.** `createRateLimiterFactory(config)` with the discriminated config (`{ kind: 'workers'; env } | { kind: 'node'; pool }`), returning `{ forEndpoint(endpoint: RateLimitEndpointGroup): RateLimiter; mode: 'enforce' | 'observe' }`. Backend resolution: `cloudflare` / `postgres`; ABSENT or unknown `AIS_RATELIMIT_BACKEND` throws at startup naming the env var (no implicit default — self-host declares via `.env`, hosted via wrangler `[vars]`). `AIS_RATELIMIT_MODE` read once here (D-021-16; absent → `enforce`). On Workers, values come from the injected `env`, never `process.env`. Table-driven tests: `cloudflare` → CF registry; `postgres` → PG registry; `undefined`/`''`/`'redis'` → throw; `observe` mode surfaces on the factory.
  - **Spec coverage:** Spec-021 line 48 (swap via deployment configuration), line 152 (configuration selects the backend at startup)
  - **Verifies invariant:** I-021-2
  - **Consumes:** T21.2-5 + T21.2-6 (same Phase).
- [ ] **T21.2-8 — `fail-open.ts`.** Grace wrapper per A-021-18/A-021-19: try/catch around `check()`; on backend error start the grace window (`AIS_RATELIMIT_FAILOPEN_SECONDS`, default 60; monotonic clock); during grace return the degraded union arm `{ allowed: true, degraded: true, graceEndsAt: <now + grace_remaining> }` (the arm carries no window fields — nothing is sentinel-fabricated) + structured warn log `{ backend, error, grace_remaining_ms }`; consumers suppress all `X-RateLimit-*` headers when `degraded` is set; after grace, throw → middleware maps to 503 `ratelimit.backend_unavailable`, increments `rate_limit_failclosed_total{backend}` (emission point lands with T21.4-1), and emits ONE structured error log at the grace-expiry transition. Grace scope = per wrapper instance (per process self-host / per isolate hosted) — the per-isolate deviation is ACCEPTED for V1 and recorded in §Risks. Unit rows: allow-for-grace then throw; degraded → zero headers; transition log exactly once.
  - **Spec coverage:** Spec-021 line 126 (bounded-grace fail-open + warning log), line 127 (fail-closed 503 after grace), line 122 (degraded header suppression)
  - **Verifies invariant:** I-021-4
  - **Consumes:** `RateLimiter` ← T21.1-1; `ratelimit.backend_unavailable` ← T21.1-5.
- [ ] **T21.2-9 — `rate-limiter-contract-suite.ts` + runners.** Export `describeRateLimiterContract(makeLimiter: () => Promise<RateLimiter>)` — scenario set: under-limit allow; at-limit deny; header-source fields present + internally consistent; window expiry re-allow; per-endpoint-group isolation; per-tier variant selection (elevated 3×, D-021-4); **block-window behavioral rows (I-021-3):** after the 3/5-min ladder trips, advance fake time past the counter window (capacity restored) but within the 15-min block → next check REJECTED with `resetAt = blockUntil` and `blockUntil` set (the trip-vs-block discriminator); advance past expiry → allowed; same for the 10/1-hr ladder asserting `escalatedTo1h` fires exactly once. Runners: `postgres-rate-limiter.contract.test.ts` (PGlite/testcontainer per harness note) and `cloudflare-rate-limiter.contract.test.ts` (hand-rolled `env.<LIMITER>.limit()` fake honoring `endpoint-limits.ts` + DO-storage fake — `@cloudflare/workers-types` is types-only; fidelity caveat recorded: local emulation does not reproduce production per-edge-location counting; I-021-2 parity is asserted at the contract level, not edge-distribution level).
  - **Spec coverage:** Spec-021 line 48 (identical limits — the parity proof), AC4 (line 169 — behavioral half), AC5 (line 170 — behavioral half), AC7 (line 172), AC9 (line 174 — elevated)
  - **Verifies invariant:** I-021-2, I-021-3
  - **Consumes:** all Phase-2 tasks; Plan-025 re-runs this suite at Tier 7 (CP-021-3).

### Phase 3 — Enforcement Wiring

**Goal:** the admission pipeline, both transport middlewares, the admin-bans surface, and the wiring of shipped procedures.

**Precondition:** Phase 2 shipped. CP-008-9 (hosted frame seam) gates only the hosted half of T21.3-4's consumption — the middleware module itself + self-host path are not gated. D-021-1 operator token available as injected config.

#### Tasks

- [ ] **T21.3-1 — `admin/bans-store.ts`.** Postgres `AdminBansStore`: `issue` (insert; 23505 conflict with an active ban → typed already-exists error → 409; conflict with an expired non-revoked ban → atomic revoke-then-insert supersession per D-021-12), `revoke` (set revoked_at/revoked_by; missing/already-revoked → not-found), `list` (paginated, `activeOnly` default), `findActive` (single indexed lookup via the `idx_admin_bans_one_active` partial index; expiry filtered in the query — `now()` cannot appear in an index predicate). Unit tests: issue → findActive returns ban; revoke → null; expired auto-filtered; issue over expired ban supersedes (old row revoked, new row active); 23505 mapping (I-021-6); pagination cursor.
  - **Spec coverage:** Spec-021 line 104 (admin-API-exclusive ban management), line 141 (durable bans), line 133 (route-backing store shapes)
  - **Verifies invariant:** I-021-6
  - **Consumes:** `AdminBansStore` contract ← T21.1-2; `admin_bans` ← T21.1-3; pg client seam (injected; hosted production = Plan-008's Tier-5 Hyperdrive-backed Querier substrate, self-host = Plan-025 pool).
- [ ] **T21.3-2 — `rate-limit/enforcement-pipeline.ts`.** `createAdmissionCheck` per §API And Transport Changes — returns `{ check, invalidateBanCache }`: ban (≤60s cache; write-through = T21.3-5 calls `invalidateBanCache` on issue/revoke; D-021-5) → `limiter.check`; `onTrip` seam fires on every rate-limit refusal (blocked + rate_limited) in observe and enforce alike (T21.4-1 binds `rate_limit_trip_total{endpoint,tier}` — the D-021-16 soak input). Unit tests: banned → `{ refusal: "banned", expiresAt }` (carries `admin_bans.expires_at`; null = permanent) without counter consumption (I-021-1); blocked → `{ refusal: "blocked", blockUntil }` (surfaced from `check.blockUntil`); clean → counter path; cache: issue → `invalidateBanCache` → immediate enforcement; cross-process staleness bounded by TTL (fake timers); `onTrip` fires for would-be 429s with no mode dependence.
  - **Spec coverage:** Spec-021 line 148 (banned identity → 403 on future requests), line 100 (15-min block enforced), line 101 (1-hr block enforced), line 90 (Retry-After on refusal)
  - **Verifies invariant:** I-021-1
  - **Consumes:** `AdminBansStore` ← T21.3-1; `RateLimiter` via factory ← T21.2-7.
- [ ] **T21.3-3 — `middleware/rate-limit.ts`.** `rateLimitProcedure` per §API And Transport Changes: typed identity pair (D-021-14), `resolveTier` hook with D-021-5 cached membership read (elevated-eligible rows only), observe-mode pass-through for trip/block (D-021-16 — the banned arm enforces in both modes), 25%-threshold header attachment + degraded suppression, 429 with the canonical envelope, 403 `ratelimit.banned` mapping. Unit tests: identity fallback chain (participant → ip; missing IP on anonymous endpoint → 400); tier never caller-supplied; observe mode emits telemetry and never denies on trip/block while banned still → 403; header policy rows (remaining < 25% of limit → headers attach; remaining ≥ 25% → none; degraded → none; sliding-window/escalation 429 → all four; concurrency-cap 429 → only the truthful subset `X-RateLimit-Limit` + `X-RateLimit-Remaining: 0` (Spec-021 §Overflow Response — this module's header helper also serves the store-side cap owners, BL-120/BL-144)); banned arm attaches no rate-limit headers (403 in both modes).
  - **Spec coverage:** Spec-021 line 122 (threshold-approach headers), line 89 (429), line 90 (Retry-After), line 91 (standard headers), line 92 (concurrency-cap header subset), line 115 (elevated resolution)
  - **Verifies invariant:** I-021-1, I-021-7
  - **Consumes:** `checkAdmission` ← T21.3-2; CP-008-5 mount surface ← Plan-008-remainder (Tier 5, §Preconditions); `AuthenticatedIdentityContext` (`ctx.participantId`) ← Plan-018; `session_memberships` read surface ← Plan-001/Plan-002 (shipped) for `resolveTier`.
- [ ] **T21.3-4 — `middleware/ws-rate-limit.ts`.** `wsRateLimit` per §API And Transport Changes: drop-frame on counter trip (in-band `rate_limited` frame shape from T21.1-4), close `4029` only on active block / `4003` on ban (both modes), observe-mode pass-through for trip/block (D-021-16; factory-provided `mode`), envelope-kind endpoint routing (`endpointFor`: maps the **forwardable pairwise-ciphertext-envelope** frame's 1-byte `type` → `ws.message` — the one `RelayFrameType` category that transits the CP-008-9 opaque-forward seam; envelope `type` byte only, CP-008-9-safe; broker-handled control frames are dispatched on Plan-008's broker path (T-008r-3-9 — its ciphertext→forward / control→broker / unknown→reject routing is verified at T-008r-3-T21/22/23) and never reach this seam; `presence.heartbeat` is not reachable — it is a JSON-RPC-WS message, not a relay frame), single-signal outcome contract (caller performs send/close). Unit tests: trip → frame outcome + connection-stays-open; active block → close outcome (code `4029`, `retryAfter` = blockUntil); banned → close outcome (code `4003`; `retryAfter` = ban `expiresAt` when timed, omitted when permanent) in observe mode too; observe mode → `{ proceed: true }` on trip/block (telemetry only — never frame or close; bans excepted above); a forwardable ciphertext-envelope frame routes to `ws.message`; no `type` byte yields `presence.heartbeat`; identity from connection principal only.
  - **Spec coverage:** Spec-021 line 96 (WS overflow semantics), line 154 (per-frame limiting), line 76 (ws.message registry row)
  - **Verifies invariant:** I-021-1
  - **Consumes:** `checkAdmission` ← T21.3-2; factory `mode` ← T21.2-7; CP-008-9 seam ← Plan-008 R3 (hosted consumption; §Preconditions); Plan-025 steps 7-8 (self-host consumption, CP-021-3).
- [ ] **T21.3-5 — `admin/bans-routes.ts`.** Raw HTTP routes (D-021-10) registered ahead of tRPC dispatch in the host fetch handler: `POST /admin/bans` (validate via `AdminBanCreateRequestSchema`; 201), `GET /admin/bans` (pagination), `DELETE /admin/bans/:id` (204/404). Operator-token auth per D-021-1 (constant-time compare; absent/malformed → 401 `auth.token_invalid`; mismatch → 403 `admin.forbidden`). On issue/revoke: ban-cache write-through invalidation (call T21.3-2's `invalidateBanCache` before returning) + `admin_ban_total{action}` emission point (lands with T21.4-1).
  - **Spec coverage:** Spec-021 line 133 (the three routes), line 104 (exclusively via admin API), line 148 (ban example flow)
  - **Verifies invariant:** I-021-6
  - **Consumes:** `AdminBansStore` ← T21.3-1; `invalidateBanCache` ← T21.3-2; wire schemas ← T21.1-2; operator token (injected config per D-021-1; self-host provider = Spec-027 Row 3, path `./data/admin-token` (BL-135 → D-025-8); hosted = `AIS_ADMIN_TOKEN` secret).
- [ ] **T21.3-6 — Wire shipped procedures + daemon-exclusion test.** Apply `rateLimitProcedure` per the §Endpoint Wiring Ownership table to the procedures shipped at Tier 6: `session.create`, `session.join`, `event.query`, `health.check`, the `general.api`/`unauthenticated.request` fallback buckets, and `auth.endpoint` over the shipped auth procedures — inside the CP-008-5 mount seam (export-only host edit). Bind `wsRateLimit` into the CP-008-9 frame seam for `ws.message` relay-frame admission (`endpointFor` maps the **forwardable pairwise-ciphertext-envelope** category — the one `RelayFrameType` category that transits the opaque-forward seam — → `ws.message`, Spec-008 §Message Framing; broker-handled control frames are dispatched on Plan-008's broker path per T-008r-3-9, not metered here). `presence.heartbeat` is **neither** a tRPC procedure **nor** a relay frame — presence heartbeats ride the WebSocket (JSON-RPC 2.0) collaboration channel (Spec-002 §Heartbeat Transport; Spec-008 §Control-Plane Transport Protocol), piggybacking the existing subscription connection with no dedicated endpoint, so nothing wraps via `rateLimitProcedure` and no relay `type` byte meters it; its 10/min row (Spec-021 line 66) stays priced/reserved as no JSON-RPC-WS message-admission surface ships in V1 (§Endpoint Wiring Ownership `presence.heartbeat` row). Author `packages/runtime-daemon/test/no-rate-limit-import.test.ts`: glob `packages/runtime-daemon/src/**/*.ts` and assert zero import specifiers matching `control-plane/src/middleware`, `control-plane/src/rate-limit`, or the `rateLimitProcedure`/`wsRateLimit` symbols (type-only `packages/contracts` imports permitted).
  - **Spec coverage:** Spec-021 line 166 (AC-1 general.api), AC2 (line 167 — auth.endpoint), AC8 (line 173 — daemon exclusion), line 25 (daemon scope exclusion), line 66 (presence.heartbeat — priced/reserved, not wired in V1: a JSON-RPC-WS collaboration-channel message, neither tRPC nor relay frame)
  - **Verifies invariant:** I-021-1 (daemon-exclusion companion)
  - **Consumes:** `rateLimitProcedure` ← T21.3-3; `wsRateLimit` + `endpointFor` ← T21.3-4; CP-008-9 seam ← Plan-008 R3; shipped Plan-008/Plan-002 procedure surfaces (Tier 5); BL-120/BL-144/BL-145/BL-146 rows cover the NOT-wired groups (tracked, not satisfied here).

### Phase 4 — Observability + Rollout Verification

**Goal:** canonical telemetry registration + emission, escalation alerting, and the AC-anchored verification suite.

**Precondition:** Phase 3 shipped.

#### Tasks

- [ ] **T21.4-1 — `rate-limit/metrics.ts`.** `RateLimitMetrics` class wrapping an injected `prom-client` `Registry`; register the five canonical families (D-021-8); emission map: trip → the T21.3-2 pipeline `onTrip` seam (fires in observe + enforce — the middleware/WS deny paths go dark in observe and MUST NOT own this counter); block → `escalatedTo1h` decisions consumed inside both limiters' `check()` (the seam holding the request `endpoint`; hosted DO-side emission cannot reach the Worker registry); failclosed → post-grace 503 path; backend_error → fail-open catch; admin_ban → store issue/revoke. Emission-time label-allow-list guard throws on out-of-list values (Plan-020 invariants). Add `prom-client` to `packages/control-plane/package.json`. Hosted disposition: no exposition — counters degrade to structured-log emission of the same bounded fields (D-021-15); self-host exposition = Plan-025 relay `GET /metrics` (CP-021-3). Unit tests: each emission point increments exactly its family; out-of-allow-list label throws; total series across families < 50 (I-021-8).
  - **Spec coverage:** Spec-027 §Required Behavior line 67 (row 9b relay family set — Plan-021's counters); Spec-021 line 103 (ops-alert telemetry pair)
  - **Verifies invariant:** I-021-8
  - **Consumes:** `onTrip` + `escalatedTo1h` seams ← Phases 2-3; Plan-020 §Prometheus /metrics Exposition label invariants (doc contract, CP-021-4); `prom-client` (npm).
- [ ] **T21.4-2 — Escalation alert telemetry.** On `escalatedTo1h: true` from `recordViolation` — observed inside BOTH limiters' `check()` composition, the seam that still holds the request's `endpoint` (the stores never receive it, and hosted DO-side emission cannot reach the Worker registry): increment `rate_limit_block_total{window_size="1h"}` + emit one structured warning log with bounded fields `{ identity_type, endpoint, window_size: "1h", block_until }` (no raw identity — PII-free; exactly-once per crossing rides the store's atomic ladder evaluation). Integration row: ten violations in 1 hr → `active_block_until ≈ now+1h` AND the counter incremented by exactly 1 AND one warning log with the bounded field set.
  - **Spec coverage:** Spec-021 line 101 (1-hr block + ops alert), line 103 (ops-alert definition), AC5 (line 170)
  - **Verifies invariant:** I-021-8
  - **Consumes:** `escalatedTo1h` ← T21.2-3/T21.2-4 (surfaced through the T21.2-5/T21.2-6 limiters); `RateLimitMetrics` ← T21.4-1.
- [ ] **T21.4-3 — AC-anchored integration verification (`packages/control-plane/integration/`).** Named rows, all metric assertions via in-process registry reads (D-021-15 — no scrape exists at Tier 6): (1) `event.query` hammer 61× in 60s → 61st = 429 with `X-RateLimit-Limit: 60`, `Retry-After` per formula; (2) AC-1: 101st `general.api` request in 60s → 429 + all four headers; (3) AC-2: 21st `auth.endpoint` request from one IP → 429 + `Retry-After`; (4) AC-3: 6th redemption attempt from one IP → 429 on `invite.redeem_ip` (limiter-level — route wiring is BL-120); (5) AC-4/AC-5 ladder rows incl. blocked-while-capacity (I-021-3) via the contract suite; (6) AC-6 exclusivity negative: ≥3 consecutive 10/1-hr escalation cycles → zero `admin_bans` rows + ladder ceiling ≤ 1h; (7) admin flow: 201 issue → 403 `ratelimit.banned` on next request from the banned identity (no counter consumed, I-021-1) → 204 revoke → allowed; 409 race row; (8) WS: 61 frames in 60s → 61st refused with in-band frame + connection alive; post-block frame → close 4029 (D-021-9); (9) grace-expiry → 503 + `rate_limit_failclosed_total` increment + one transition log; (10) per-scenario counter deltas (trip/block/admin_ban/backend_error families).
  - **Spec coverage:** Spec-021 line 166 (AC-1), AC2 (line 167), AC3 (line 168), AC4 (line 169), AC5 (line 170), AC6 (line 171), AC8 (line 173 — via T21.3-6's structural test), line 146 (61-message example), line 148 (ban example)
  - **Verifies invariant:** I-021-1, I-021-3, I-021-4, I-021-6
  - **Consumes:** all prior phases; PGlite/testcontainer harness per T21.1-3 note.

## Parallelization Notes

- Phase 1 lands first; T21.1-1/T21.1-2 are the root contracts; T21.1-3 (migration) and T21.1-4/-5 (doc parity verification) are parallel after them; T21.1-6 follows the contracts.
- Phase 2: T21.2-1 and T21.2-2 first; then T21.2-3/T21.2-4 (stores) in parallel; T21.2-5/T21.2-6 (limiters) in parallel after stores; T21.2-7/T21.2-8 after limiters; T21.2-9 last (drives everything).
- Phase 3: T21.3-1 → T21.3-2 → {T21.3-3, T21.3-4, T21.3-5 in parallel} → T21.3-6.
- Phase 4: T21.4-1 → {T21.4-2, T21.4-3 in parallel}.

## Test And Verification Plan

The authoritative per-task test obligations live in each `#### Tasks` row above. Summary by layer:

- **Unit (`packages/control-plane/src/rate-limit/*.test.ts`, `src/middleware/*.test.ts`, `src/admin/*.test.ts`):** factory table rows; fail-open grace + degraded suppression + transition log; escalation ladder threshold math on both stores; DO single-alarm re-arm + restart persistence; bans-store CRUD + 23505 + pagination; pipeline ordering (ban → block → counter) + `onTrip`/`invalidateBanCache` rows; middleware identity/tier/header/observe rows; WS drop-frame vs close vs observe rows; metrics label guard + series count.
- **Migration-shape (`packages/control-plane/src/migrations/__tests__/`):** PGlite information_schema assertions + idempotent re-apply + I-021-6 race + CHECK rejection (T21.1-3).
- **Contracts (`packages/contracts/src/__tests__/`):** Zod round-trips; 5-field envelope acceptance / 4-field rejection; registry-key union snapshot (T21.1-6).
- **Contract parity suite (`rate-limiter-contract-suite.ts`):** the I-021-2 proof, run against both backends in CI and re-run by Plan-025 at Tier 7 (T21.2-9; CP-021-3).
- **Integration (`packages/control-plane/integration/`):** the ten AC-anchored rows of T21.4-3.
- **Structural:** daemon-exclusion import-boundary test (T21.3-6).

## Rollout Order

1. Land Phase 1 (contracts + migration + doc reconciliation).
2. Land Phase 2 backends; contract suite green against both.
3. Land Phase 3 wiring (tRPC + admin routes; WS hosted half gated on CP-008-9, self-host rides Plan-025 at Tier 7).
4. Land Phase 4 telemetry + verification suite.
5. Pre-enable soak (D-021-16; no staging environment exists — ADR-023's `environment: production` is a release gate, and Plan-008's dev-environment allow-list refuses `'staging'`): deploy with `AIS_RATELIMIT_MODE=observe` for 24h. Monitor `rate_limit_trip_total`, `rate_limit_block_total`, `admin_ban_total`, `rate_limit_backend_error_total`, `rate_limit_failclosed_total`. Gate: false-positive rate < 0.1%, measured as would-be-429s issued to identities whose structured-log request rate never exceeded the configured limit for that endpoint group ÷ total would-be-429s (plan-local target).
6. Flip `AIS_RATELIMIT_MODE=enforce` in production; first 24h enforced runs with the same monitoring + §Rollback levers armed.

## Rollback Or Fallback

- **False-positive storm:** set `AIS_RATELIMIT_MODE=observe` and redeploy/restart (deploy-time configuration change, not a request-time toggle — D-021-16); rate-limit enforcement stops (admin bans stay enforced — D-021-16 ban carve-out), full telemetry continues; log retention captures which identity tripped. There is deliberately no in-band runtime kill switch (DoS footgun).
- **Admin revocation:** any operator can `DELETE /admin/bans/:id` to lift an individual ban (cache write-through makes it immediate in the issuing process; ≤60s elsewhere, D-021-5).
- **Backend outage:** fail-open for 60s (default grace) covers transient Postgres / DO outages. After grace, 503s surface to clients with `rate_limit_failclosed_total` visibility; clients retry with backoff per their own logic.
- **Rollback from v1 → pass-through:** the middleware can be uninstalled by removing the `.use(rateLimitProcedure(...))` on each procedure. The `RateLimiter` contract + backends remain deployed but no longer enforce. This is a code change; observe mode (above) is the operational lever.

## Risks And Blockers

- **Cloudflare `rate_limit` binding period cap.** The binding only supports 10s or 60s periods ([Cloudflare: Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)). Escalation windows (5 min, 1 hr) and authoritative window state live in the DO layer (D-021-3). Hourly registry rows (`invite.create_*`, `keypackage.upload`) are DO-tracked on hosted; the binding covers the per-minute rows.
- **`rate-limiter-flexible` v11.0.0 recency.** Published 2026-04-03 ([GitHub release](https://github.com/animir/node-rate-limiter-flexible/releases/tag/v11.0.0)). Breaking changes in v11: `RLWrapperBlackAndWhite` now extends `RateLimiterCompatibleAbstract` (we do not use black/white wrappers). No breakage expected. Pinned `^11.0.0` in `packages/control-plane/package.json` with a semver floor assertion in the contract suite (T21.2-6).
- **Clock skew across CF edge locations.** The Cloudflare `rate_limit` binding is per-location per-key by design, so a highly mobile attacker rotating through locations can get `L × limit` requests for `L` locations before any single location trips. Under the eager-DO design (D-021-3) the `RateLimitEscalationDO` observes every check for the identity across locations (DO instances are globally unique per `identity_type:identity`), so cumulative per-identity violations are visible even when no single location's binding trips; sub-threshold-per-location rotation remains accepted residual risk for V1. Mitigation is post-V1: route counters themselves through a global DO (trade-off: 10–50ms per request).
- **Eager-DO round-trip cost.** Every hosted rate check consults the DO (block state + authoritative `remaining`/`resetAt`). This doubles the CF rate-limit check cost (~1-5ms DO lookup added to the free binding). For the hot path (60/min messages), 2ms × 60 = 120ms/min added compute per participant per minute. Accepted for V1 (D-021-3 — the lazy alternative breaks block enforcement and header accuracy).
- **Per-isolate grace scope (hosted).** The fail-open grace window is in-memory per Workers isolate; isolate churn during a sustained backend outage re-opens grace per cold isolate, so hosted fail-closed convergence is per-isolate, not fleet-wide. ACCEPTED for V1 (A-021-19); mitigant: `rate_limit_backend_error_total{backend}` + `rate_limit_failclosed_total{backend}` alerting catches the sustained-outage case; persisting grace state would require the very backend that is failing.
- **Ban-cache staleness.** A just-issued ban takes effect immediately in the issuing process and within ≤60s elsewhere (D-021-5). Accepted: ban issuance is incident response, not a synchronous control; the bound is documented in the spec's example flow.
- **`admin_bans` concurrency.** Two concurrent operators issuing a ban for the same identity: the partial unique index rejects the second insert (23505) → deterministic `409 admin.ban_already_exists` (I-021-6). Accepted as-is.
- **Hosted admin-token provisioning.** `AIS_ADMIN_TOKEN` is an operator-provisioned Workers secret; if unset, the admin-bans routes refuse all callers (fail-closed) and log a startup warning. Self-host token path canonicalization is BL-135 (resolved — Plan-025 D-025-8; canonical path `./data/admin-token`) — Plan-025's surface, recorded in §Preconditions.

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

- 2026-06-10 — Tier-6 plan-readiness audit: full rewrite to audit format. 74 findings (12 critical) adjudicated via A-021-1..24; D-021-1..17 ratified; invariants I-021-1..8 and CP-021-1..5 minted; phases restructured 1-4 with 24 tasks. Central re-bases: admin auth Cedar → operator token (D-021-1); hosted WS frame seam → CP-008-9 (D-021-2); lazy-DO → eager-DO with the ban → block → counter admission pipeline (D-021-3); `ratelimit.escalated` Plan-006 event → telemetry pair (D-021-7); metric families → canonical `rate_limit_*` (D-021-8). Spec-021 amended in the same audit (registry, tiers, WS overflow, expiry/list, ops-alert definition).

## Done Checklist

- [ ] `RateLimiter` interface + `RateLimitEndpointGroup` + `RateLimitResponse`/`RateLimitResponseSchema` live in `packages/contracts/src/rate-limiter.ts` with the shapes defined in §API And Transport Changes.
- [ ] `CloudflareWorkersRateLimiter` + `PostgresRateLimiter` both pass the shared contract suite (`rate-limiter-contract-suite.ts`) covering every sliding-window registry row including elevated variants and block-window behavioral rows.
- [ ] `RateLimiterFactory` selects backend from `AIS_RATELIMIT_BACKEND`; throws on unknown OR absent value at startup; reads `AIS_RATELIMIT_MODE` once at construction.
- [ ] Postgres `admin_bans` + `rate_limit_escalations` tables ship via the registered `.ts` migration, match shared-postgres-schema.md verbatim (incl. both `identity_type` CHECKs with the five-value set), and the migration-shape test passes.
- [ ] `RateLimitEscalationDO` is exported from the Worker entry module, declared in wrangler `[[durable_objects.bindings]]` + `[[migrations]]`, and handles both windows via single-alarm earliest-deadline scheduling with 1-hr retention and full-expiry `deleteAll` self-eviction (D-021-13).
- [ ] Admission order ban → escalation block → counter is enforced on both transports via `checkAdmission` (I-021-1); a banned identity receives 403 `ratelimit.banned` without consuming counter capacity.
- [ ] `rateLimitProcedure` is wired on every endpoint group the §Endpoint Wiring Ownership table assigns to this plan; BL-120/BL-144/BL-145/BL-146 track the rest.
- [ ] WS per-frame admission implements drop-frame semantics: in-band `rate_limited` frame on counter trip (connection stays open); close `4029` only on active block, `4003` on ban; hosted consumption via CP-008-9, self-host via Plan-025.
- [ ] Escalation ladder trips at 3 violations / 5 min → 15-min block, 10 / 1 hr → 1-hr block + telemetry pair (counter + bounded structured warning log); blocks enforced for their full window independent of counter capacity (I-021-3); permanent bans only via admin API with the escalation-never-permabans negative test green.
- [ ] Admin API (`POST /admin/bans`, `GET /admin/bans` paginated, `DELETE /admin/bans/:id`) authenticates via the operator admin token (constant-time); absent/malformed → 401 `auth.token_invalid`; mismatch → 403 `admin.forbidden`; issue/revoke write through the ban cache.
- [ ] Fail-open grace is configurable via `AIS_RATELIMIT_FAILOPEN_SECONDS` (default 60); degraded responses carry `degraded: true` and zero `X-RateLimit-*` headers; post-grace returns 503 `ratelimit.backend_unavailable` with `rate_limit_failclosed_total` + one transition log.
- [ ] Sliding-window and escalation 429s include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` computed as `max(0, ceil((resetAt - now) / 1000))`; concurrency-cap 429s omit the timing pair (no reset clock exists — capacity frees on holder release) and send the truthful subset `X-RateLimit-Limit` + `X-RateLimit-Remaining: 0` (Spec-021 §Overflow Response envelope rule); allowed responses attach headers only when `remaining < 25%` of the limit.
- [ ] api-payload-contracts.md parity verified against the typed exports (5-field `RateLimitResponse`, timing pair optional; 5-field `RateLimitCheckRequest`; two-arm `RateLimitCheckResponse` (window arm + `limit` + `blockUntil?`; degraded arm `graceEndsAt`); §Admin Bans API payloads; `ErrorNamespace` + `admin`/`ratelimit`; §Relay Rate-Limit Signalling frame + `4029`/`4003` — pre-propagated at the Tier-6 audit; T21.1-4 lands only drift fixes).
- [ ] Error codes `admin.forbidden` (403), `admin.ban_not_found` (404), `admin.ban_already_exists` (409), `ratelimit.banned` (403), `ratelimit.backend_unavailable` (503) are registered in error-contracts.md (pre-propagated at the Tier-6 audit) and every code the implementation emits resolves to a registered row (T21.1-5).
- [ ] Canonical metric families `rate_limit_trip_total{endpoint,tier}`, `rate_limit_block_total{window_size}`, `rate_limit_backend_error_total{backend}`, `rate_limit_failclosed_total{backend}`, `admin_ban_total{action}` are registered + emitted with the label guard (series < 50); self-host exposition rides Plan-025; hosted degrades to structured logs (D-021-15).
- [ ] Local daemon IPC path is NOT rate-limited — enforced by the import-boundary structural test, not by review.
- [ ] KeyPackage upload limit is not wired (V1.1+ per the registry stub and ADR-010's MLS deferral).
- [ ] Postgres TLS posture documented on the injected pool: `sslmode=verify-full` enforced at Plan-025's config-parse locus per [Spec-027 row 5](../specs/027-self-host-secure-defaults.md#required-behavior) ([CVE-2024-10977](https://www.postgresql.org/support/security/CVE-2024-10977/), fixed in PG 17.1/16.5/15.9/14.14/13.17/12.21); the contract suite exercises the refusal-table assertion.

## Tier Placement

Tier 6 per [cross-plan-dependencies.md §5 Canonical Build Order](../architecture/cross-plan-dependencies.md#5-canonical-build-order). Strictly **downstream of Plan-008** (this plan consumes the CP-008-5 tRPC mount + CP-008-9 frame seam) and **upstream of Plan-025** (the self-hostable relay instantiates `PostgresRateLimiter` + `wsRateLimit` + the admin routes inside its compose-deployed process, CP-021-3). Additionally: (a) within-Tier-6 upstream of Plan-002 Phase 4, which consumes `rateLimitProcedure` for invite-endpoint wiring per BL-120 (CP-021-2); (b) registers its metric families against Plan-020's §Prometheus /metrics Exposition contract (Tier 8 — doc-contract compliance only, no code consumed; CP-021-4) with self-host exposition mounted by Plan-025 (Tier 7).

## References

- [Spec-021: Rate Limiting Policy](../specs/021-rate-limiting-policy.md)
- [ADR-014: tRPC Control-Plane API](../decisions/014-trpc-control-plane-api.md)
- [ADR-020: V1 Deployment Model And OSS License](../decisions/020-v1-deployment-model-and-oss-license.md)
- [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md)
- [ADR-012: Cedar Approval Policy Engine](../decisions/012-cedar-approval-policy-engine.md) (removal rationale, D-021-1)
- [Plan-008: Control Plane Relay And Session Join](./008-control-plane-relay-and-session-join.md) (CP-008-5, CP-008-9)
- [Plan-020: Observability And Failure Recovery](./020-observability-and-failure-recovery.md) (metrics contract)
- [Plan-025: Self-Hostable Node Relay](./025-self-hostable-node-relay.md) (downstream instantiator)
- [Spec-027: Self-Host Secure Defaults](../specs/027-self-host-secure-defaults.md) (rows 3, 5, 9)
- [Deployment Topology §Rate Limiting By Deployment](../architecture/deployment-topology.md)
- [Cloudflare Workers: Rate Limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Cloudflare Durable Objects: Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [rate-limiter-flexible v11.0.0 release](https://github.com/animir/node-rate-limiter-flexible/releases/tag/v11.0.0)
- [tRPC v11 middlewares](https://trpc.io/docs/server/middlewares)
- [PostgreSQL CVE-2024-10977](https://www.postgresql.org/support/security/CVE-2024-10977/)
