# Plan-021: Rate Limiting Policy

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `021` |
| **Slug** | `rate-limiting-policy` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude Opus 4.7` |
| **Spec** | [Spec-021: Rate Limiting Policy](../specs/021-rate-limiting-policy.md) |
| **Required ADRs** | [ADR-014: tRPC Control-Plane API](../decisions/014-trpc-control-plane-api.md); [ADR-020: V1 Deployment Model And OSS License](../decisions/020-v1-deployment-model-and-oss-license.md); [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md); [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md); [ADR-012: Cedar Approval Policy Engine](../decisions/012-cedar-approval-policy-engine.md) |
| **Dependencies** | Plan-008 (relay + control-plane surface — this plan wires middleware into Plan-008's tRPC router and into the relay's per-frame receive hook); Plan-018 (PASETO v4.public token issuance and role-claim surface for admin endpoints); Plan-007 (local daemon IPC — scope **exclusion**, confirms the daemon path is not rate-limited) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Ship the Spec-021 rate-limiting enforcement layer across the control-plane tRPC surface and the WebSocket relay data path, as a single `RateLimiter` contract with two deployment-aware implementations (Cloudflare-native `rate_limit` binding for the project-operated / hosted SaaS relay; `rate-limiter-flexible` v11.0.0 with a Postgres backend for the self-hostable relay), plus a three-stage escalation ladder and an admin-only permanent-ban surface. Enforcement must be identical in both deployment modes (identical limits, identical headers, identical error envelopes) so that protocol-level changes land once and ship to both.

## Scope

- `RateLimiter` contract owned by this plan at `packages/contracts/src/rate-limiter.ts` (PtyHost-precedent placement — see [Plan-024](./024-rust-pty-sidecar.md#target-areas) for the pattern).
- Two `RateLimiter` implementations:
  - `CloudflareWorkersRateLimiter` — wraps `env.<LIMITER>.limit({ key })` per the Cloudflare `rate_limit` binding (hosted).
  - `PostgresRateLimiter` — wraps `rate-limiter-flexible` v11.0.0's `RateLimiterPostgres` store (self-host).
- `RateLimiterFactory` — runtime selector via env var `AIS_RATELIMIT_BACKEND={cloudflare|postgres}`, fails loudly on unknown value.
- Two-layer enforcement:
  - **Counter layer:** sliding-window counters per limit defined in Spec-021 §Rate Limit Values. For hosted, CF-native binding; for self-host, `rate-limiter-flexible` with Postgres.
  - **Escalation layer:** the three-stage ladder (3/5min → 15-min block; 10/1hr → 1-hr block + ops alert; admin-only permanent ban). Hosted: Durable Object `RateLimitEscalationDO` (native binding only supports 10s/60s periods, so longer windows need DO-backed sliding logic). Self-host: `rate_limit_escalations` Postgres table.
- tRPC v11 middleware `rateLimitProcedure({ endpoint })` wrapping every procedure mapped in Spec-021 §Rate Limit Values.
- WebSocket per-frame rate check consumed by Plan-008's relay (one check per decoded frame, not per connection establishment).
- Admin bans API:
  - `POST /admin/bans` — issue permanent ban.
  - `GET /admin/bans` — list active bans.
  - `DELETE /admin/bans/{id}` — revoke a ban.
  - Auth: PASETO v4.public `sub` claim (per ADR-010) authorized by a Cedar `admin.ratelimit.*` policy (per ADR-012). No new auth primitive introduced.
- `admin_bans` Postgres table (shared between both deployments — hosted and self-host both have Postgres per ADR-004).
- Fail-open grace period controlled by `AIS_RATELIMIT_FAILOPEN_SECONDS` env var (default 60s); after grace, fail-closed with HTTP 503.
- Retry-After and standard rate-limit headers on every 429 response.
- Prometheus-compatible metrics: `ratelimit_trip_total{endpoint,tier}`, `ratelimit_block_total{window_size}`, `admin_ban_total{action}`, `ratelimit_backend_error_total{backend}`.

## Non-Goals

- **Local daemon IPC rate limiting.** Spec-021 §Scope explicitly excludes the daemon path (trusted by socket reachability). This plan consumes that exclusion; no IPC-side middleware is authored.
- **KeyPackage upload rate limit.** Spec-021's `KeyPackage uploads (V1.1+)` row is gated on the MLS upgrade path per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md). The V1 control plane ships **no** KeyPackage endpoint, so no limit binding is wired. A stub config entry is placed so V1.1 can activate without a schema change.
- **Per-model / per-provider token-level throttling.** Out of Spec-021 §Non-Goals.
- **Billing metering.** Separate plan (not in V1 scope per ADR-015).
- **Custom rate-limit algorithms beyond sliding window.** Fixed-window and token-bucket are not implemented; Spec-021 §Implementation Notes prefers sliding windows.
- **Admin UI for ban management.** API only in V1. UI comes with Plan-023 / Plan-026 follow-on (post-V1).

## Preconditions

- [x] Spec-021 is approved (this plan is paired with it).
- [x] ADR-014 (tRPC control-plane API) is accepted — defines the middleware hook point this plan uses.
- [x] ADR-020 (V1 deployment model) is accepted — declares both rate-limiter backends as V1-scope.
- [x] ADR-010 (PASETO v4.public) is accepted — provides the token primitive for admin-API auth.
- [x] ADR-012 (Cedar) is accepted — provides the authorization engine for admin-API authorization.
- [ ] Plan-008 exposes a per-frame receive hook (`onFrame(connection, frame)` or equivalent) into which `wsRateLimit` can inject. Plan-021's middleware is the consumer; the hook itself lives in Plan-008. The edit to Plan-008's Preconditions list is BL-054 propagation work (Session 4), not this plan's responsibility.
- [ ] Plan-018 issues PASETO v4.public tokens with a `sub` claim (ParticipantId) plus a Cedar-consumable participant role model in Postgres. Admin authorization reads the Cedar policy, not a token-embedded `role` claim, so no new token field is introduced. This plan assumes Plan-018's participant role model exists at implementation time.

## Target Areas

- `packages/contracts/src/rate-limiter.ts` — **created by this plan.** `RateLimiter` interface (the contract both backends implement).
- `packages/contracts/src/admin-bans.ts` — **created by this plan.** `AdminBan`, `BanIdentityType`, `AdminBansStore` interface.
- `packages/control-plane/src/rate-limit/` — **created by this plan.**
  - `cloudflare-rate-limiter.ts` — Cloudflare-binding implementation.
  - `postgres-rate-limiter.ts` — `rate-limiter-flexible` Postgres implementation.
  - `factory.ts` — runtime backend selector.
  - `escalation/postgres-escalation-store.ts` — self-host escalation state.
  - `escalation/durable-object-escalation-store.ts` — hosted escalation state (DO class).
  - `fail-open.ts` — grace-period wrapper (wraps any `RateLimiter` with fail-open/fail-closed logic).
- `packages/control-plane/src/middleware/rate-limit.ts` — tRPC middleware `rateLimitProcedure`.
- `packages/control-plane/src/middleware/ws-rate-limit.ts` — WS frame check consumed by Plan-008 relay.
- `packages/control-plane/src/admin/bans-routes.ts` — admin-API router.
- `packages/control-plane/src/admin/bans-store.ts` — Postgres-backed `AdminBansStore` implementation.
- `packages/control-plane/src/migrations/XXXX-rate-limit-tables.sql` — **extended from Plan-008's migration series.** Two new tables: `admin_bans`, `rate_limit_escalations`.
- `docs/architecture/schemas/shared-postgres-schema.md` — **extended by this plan** with the two new tables.
- `docs/architecture/contracts/api-payload-contracts.md` — **extended by this plan.** Add admin bans request/response payloads. Confirm the canonical `RateLimitResponse` shape (reconciliation note below in §Data And Storage).
- `docs/architecture/contracts/error-contracts.md` — **extended by this plan.** Add error codes `admin.ban_not_found`, `admin.forbidden`, `ratelimit.backend_unavailable`.
- `docs/architecture/deployment-topology.md` §Rate Limiting By Deployment — **already declares the deployment matrix**; this plan is the implementation consumer. No edit needed.
- `wrangler.toml` (hosted) — declare `[[ratelimits]]` bindings one per endpoint group. Listed as deliverable here; actual wrangler config authoring lands with Plan-008's relay-deployment config.

## Data And Storage Changes

### Postgres: `admin_bans` (new, shared by both deployments)

```
ban_id          UUID         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()
identity        TEXT         NOT NULL
identity_type   TEXT         NOT NULL             -- 'participant' | 'ip' | 'token_hash'
issued_by       TEXT         NOT NULL              -- ParticipantId of issuing admin
issued_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
reason          TEXT
expires_at      TIMESTAMPTZ                        -- NULL = permanent
revoked_at      TIMESTAMPTZ
revoked_by      TEXT                               -- ParticipantId of revoking admin
CHECK (identity_type IN ('participant', 'ip', 'token_hash'))
```

- **One-active-ban enforcement:** `UNIQUE INDEX idx_admin_bans_one_active ON admin_bans (identity, identity_type) WHERE revoked_at IS NULL`. Postgres treats `NULL` as distinct in standard `UNIQUE` column constraints, so a partial index with `WHERE revoked_at IS NULL` is the correct idiom — it applies uniqueness only to active rows, admitting as many revoked (non-NULL `revoked_at`) rows as history requires.
- **Hot read path:** `idx_admin_bans_lookup ON (identity, identity_type) WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())` is a second partial index covering the ban-check query. Two partial indexes on the same column set is intentional: one enforces uniqueness on active rows, the other accelerates the ban-check read (which also filters out expired bans).

### Postgres: `rate_limit_escalations` (new, self-host only — hosted uses DO)

```
identity             TEXT         NOT NULL
identity_type        TEXT         NOT NULL
violation_count      INTEGER      NOT NULL DEFAULT 0
first_violation_at   TIMESTAMPTZ
last_violation_at    TIMESTAMPTZ
active_block_until   TIMESTAMPTZ
PRIMARY KEY (identity, identity_type)
```

- Escalation windows are enforced by the application query: `WHERE last_violation_at >= now() - INTERVAL '5 minutes'` for the 15-min-block rule, and `INTERVAL '1 hour'` for the 1-hr-block rule. Row is upserted on each violation.

### Durable Object: `RateLimitEscalationDO` (hosted only)

- One DO instance per `(identity, identity_type)` pair, keyed by `identity_type:identity`.
- In-memory counters with `alarm()`-driven expiry at 5-min and 1-hr window ends.
- Persisted state (survives worker restart) via DO's built-in storage API: `violation_timestamps: number[]` (trimmed by alarm), `active_block_until: number | null`.

### Cloudflare `[[ratelimits]]` bindings (hosted only)

- One binding per endpoint group from Spec-021 §Rate Limit Values. Each binding declared with `period: 60` (or `period: 10` for sub-minute limits) and `limit: <threshold>` per the spec table.
- Example (partial):
  ```toml
  [[ratelimits]]
  name = "GENERAL_API_LIMITER"
  namespace_id = "general_api_per_user"
  simple = { limit = 100, period = 60 }
  ```
- Hosted binding setup uses `env.<LIMITER>.limit({ key })` returning `{ success: boolean }`. The implementation augments this with a second DO lookup to populate `remaining` and `resetAt` (the native binding does not return these directly; see §Implementation Steps step 3).

### `RateLimitResponse` canonical shape (reconciliation)

There is a pre-existing drift in the contracts docs: [api-payload-contracts.md §Error Responses](../architecture/contracts/api-payload-contracts.md) declares `RateLimitResponse` with 4 fields (missing `resetAt`), while [error-contracts.md §Rate Limiting](../architecture/contracts/error-contracts.md) declares 5 fields (including `resetAt`). This plan names the 5-field shape as canonical (the shape in error-contracts.md) and reconciles api-payload-contracts.md to match:

```ts
interface RateLimitResponse {
  code: "rate_limited";
  retryAfter: number; // seconds until retry is allowed
  limit: number; // total allowed requests in the window
  remaining: number; // requests remaining in the current window
  resetAt: string; // ISO 8601 timestamp when the limit resets
}
```

Edit to api-payload-contracts.md:79-84 lands in Step 13 (see §Implementation Steps).

## API And Transport Changes

### `RateLimiter` contract (new, owned by this plan)

```ts
// packages/contracts/src/rate-limiter.ts
export type RateLimitIdentityType = "participant" | "ip" | "token_hash";

export interface RateLimitCheckRequest {
  identity: string;
  identityType: RateLimitIdentityType;
  endpoint: string; // endpoint group key from Spec-021 §Rate Limit Values
  tier?: "anonymous" | "authenticated" | "elevated";
  context?: Record<string, unknown>;
}

export interface RateLimitCheckResponse {
  allowed: boolean;
  remaining: number;
  resetAt: string; // ISO 8601
  limit: number; // total threshold for this window
}

export interface RateLimiter {
  check(req: RateLimitCheckRequest): Promise<RateLimitCheckResponse>;
  // RateLimiterCompatibleAbstract (rate-limiter-flexible v11) alignment:
  // consume/reward/block/delete semantics are internal to the backend;
  // the public surface is just check().
}
```

- The interface intentionally collapses `rate-limiter-flexible` v11.0.0's `RateLimiterCompatibleAbstract` surface (`consume, get, set, delete, penalty, reward, block, getKey`) into a single `check()` because the Cloudflare `rate_limit` binding exposes only `limit({ key })` returning `{ success }`. Plan-021 is a checking consumer; it does not need the broader control surface. Where escalation logic needs to issue a block, it writes to the escalation store directly (`PostgresEscalationStore` or `RateLimitEscalationDO`), not through the `RateLimiter` contract.

### Admin bans API

```ts
// POST /admin/bans
interface AdminBanCreateRequest {
  identity: string;
  identityType: RateLimitIdentityType;
  reason?: string;
  expiresAt?: string; // ISO 8601; omit for permanent
}
interface AdminBanCreateResponse {
  banId: string; // UUID
  issuedAt: string;
  expiresAt: string | null;
}

// GET /admin/bans
interface AdminBanListResponse {
  bans: Array<{
    banId: string;
    identity: string;
    identityType: RateLimitIdentityType;
    issuedBy: string;
    issuedAt: string;
    expiresAt: string | null;
    reason: string | null;
  }>;
}

// DELETE /admin/bans/:id
// Response: 204 No Content, or 404 admin.ban_not_found
```

- Auth: all three routes require a valid PASETO v4.public token; Cedar policy `permit(principal, action == "admin.ratelimit.ban.{create|list|revoke}", resource)` must match. Denial returns `403 admin.forbidden`.
- Non-admin tokens receive `403 admin.forbidden` (Cedar deny). Absent/invalid token receives `401 auth.required`.

### tRPC middleware surface (Plan-008 consumer)

```ts
// packages/control-plane/src/middleware/rate-limit.ts
export const rateLimitProcedure = (opts: { endpoint: string; identityKeyFn?: (ctx) => string }) =>
  t.middleware(async ({ ctx, next }) => {
    const identity = opts.identityKeyFn?.(ctx) ?? ctx.participantId ?? ctx.clientIp;
    const limiter = ctx.rateLimiterFactory.forEndpoint(opts.endpoint);
    const res = await limiter.check({
      identity,
      identityType,
      endpoint: opts.endpoint,
      tier: ctx.tier,
    });
    if (!res.allowed) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        cause: {
          code: "rate_limited",
          retryAfter: secondsUntil(res.resetAt),
          limit: res.limit,
          remaining: 0,
          resetAt: res.resetAt,
        },
      });
    }
    return next({ ctx: { ...ctx, rateLimitHeaders: headersFrom(res) } });
  });
```

- Usage on a procedure: `t.procedure.use(rateLimitProcedure({ endpoint: 'session.create' }))`. The tRPC v11 middleware chaining model is documented in [tRPC v11 middlewares](https://trpc.io/docs/server/middlewares) (uses `.use()` with opts `{ ctx, path, type, input, getRawInput, next }`; v11 adds `.concat()` and `.unstable_pipe()`; the deprecated `experimental_standaloneMiddleware` is not used).

### WebSocket per-frame rate check (Plan-008 consumer)

```ts
// packages/control-plane/src/middleware/ws-rate-limit.ts
export const wsRateLimit =
  (limiter: RateLimiter, identityExtractor: (conn) => string) =>
  async (
    conn: WsConnection,
    frame: WsFrame,
  ): Promise<{ proceed: true } | { proceed: false; closeCode: number }> => {
    const res = await limiter.check({
      identity: identityExtractor(conn),
      identityType: "participant",
      endpoint: "ws.message",
      tier: conn.tier,
    });
    if (!res.allowed) {
      conn.send(rateLimitCloseFrame({ retryAfter: secondsUntil(res.resetAt) }));
      return { proceed: false, closeCode: 4029 }; // custom close code signalling rate limit
    }
    return { proceed: true };
  };
```

- Plan-008's relay frame handler calls `wsRateLimit(limiter, extractor)(conn, frame)` before dispatching. The `4029` custom close code (in the WebSocket private range `4000-4999`) signals "rate limit" to cooperating clients; clients back off using the accompanying `retryAfter` hint.

### Standard headers on 429 responses

All rate-limited responses must set:

- `X-RateLimit-Limit: <limit>`
- `X-RateLimit-Remaining: 0`
- `X-RateLimit-Reset: <unix-timestamp-seconds>`
- `Retry-After: <seconds>` — formula: `max(0, ceil((resetAt - now) / 1000))`. For the Postgres sliding-window backend, `resetAt` is "the time the oldest counted request ages out of the window" (equivalent to `first_violation_at + window_duration`). For the Cloudflare native binding, `resetAt` is the end of the current 10s/60s period (the binding enforces this natively).

## Implementation Steps

1. **Define `RateLimiter` contract.** Author `packages/contracts/src/rate-limiter.ts` per §API And Transport Changes. Export type-only. Plan-008's router and relay handler are the downstream consumers.
2. **Define `AdminBansStore` contract.** Author `packages/contracts/src/admin-bans.ts` with the methods `issue(ban)`, `revoke(banId, revokedBy)`, `list()`, `findActive(identity, identityType)`.
3. **Implement `CloudflareWorkersRateLimiter`.** In `packages/control-plane/src/rate-limit/cloudflare-rate-limiter.ts`, map each endpoint from Spec-021 §Rate Limit Values to its `[[ratelimits]]` binding on `env`. Because the native binding returns only `{ success }`, compute `remaining`, `limit`, `resetAt` lazily: on `success: true`, return best-effort values derived from the binding's declared configuration (`remaining = limit - 1` approximation, `resetAt = now + binding.period`, `limit = binding.limit`) with no DO round-trip — the hot path stays single-RPC. Only on `success: false` is the `RateLimitEscalationDO` consulted, which (a) increments the escalation violation counter and (b) returns authoritative `remaining` (always 0 at trip) and `resetAt` values. If the DO lookup itself fails during a `success: false` call, return `{ allowed: false, remaining: 0, resetAt: now + binding.period, limit }` as a safe degrade. This lazy strategy trades precise `remaining` accounting on success (acceptable: clients only care about precision when nearing the limit) for eliminating the every-call DO round-trip (~1-5ms per call × 60/min messages = 60-300ms/min reclaimed per participant).
4. **Implement `PostgresRateLimiter`.** In `packages/control-plane/src/rate-limit/postgres-rate-limiter.ts`, wrap `RateLimiterPostgres` from `rate-limiter-flexible` v11.0.0 (published 2026-04-03, release notes: [animir/node-rate-limiter-flexible releases](https://github.com/animir/node-rate-limiter-flexible/releases/tag/v11.0.0)). Use one `RateLimiterPostgres` instance per endpoint group; share a single `pg.Pool` provided by Plan-008's control-plane wiring. Enforce Postgres TLS via `sslmode=verify-full` per [Spec-027 row 5](../specs/027-self-host-secure-defaults.md#required-behavior) — `sslmode=require` is refused at config-parse time because it is MITM-exploitable per [CVE-2024-10977](https://www.postgresql.org/support/security/CVE-2024-10977/) (2024-11-14; libpq error-message injection, fixed in PG 17.2 / 16.6 / 15.10 / 14.15 / 13.18). `sslmode=verify-ca` is accepted only with a loud startup banner + `security.default.override=postgres_sslmode=verify-ca` log event; `disable\|allow\|prefer\|require` MUST be refused at parse time.
5. **Implement `RateLimiterFactory`.** In `packages/control-plane/src/rate-limit/factory.ts`, read `AIS_RATELIMIT_BACKEND`; if value is `cloudflare`, return a registry of `CloudflareWorkersRateLimiter` instances (one per endpoint); if `postgres`, return `PostgresRateLimiter` instances. Unknown value → throw at startup.
6. **Implement `PostgresEscalationStore`.** In `packages/control-plane/src/rate-limit/escalation/postgres-escalation-store.ts`, upsert `rate_limit_escalations` on every 429. Query `violation_count WHERE last_violation_at >= now() - INTERVAL '5 minutes'` for the 3/5-min rule; same with `'1 hour'` for the 10/1-hr rule. Write `active_block_until` when thresholds trip.
7. **Implement `DurableObjectEscalationStore`.** In `packages/control-plane/src/rate-limit/escalation/durable-object-escalation-store.ts`, declare the DO class with `violation_timestamps: number[]` and `active_block_until: number | null` in `this.state.storage`. Use `this.state.storage.setAlarm()` to trim the array at 5-min and 1-hr window ends.
8. **Implement fail-open wrapper.** In `packages/control-plane/src/rate-limit/fail-open.ts`, wrap any `RateLimiter` with try/catch. On backend error, start a grace timer (`AIS_RATELIMIT_FAILOPEN_SECONDS`, default 60); during grace, return `{ allowed: true, remaining: -1, resetAt: ..., limit: -1 }` and log a warning with structured fields `{ backend, error, grace_remaining_ms }`. After grace, throw; the middleware catches and returns 503 `ratelimit.backend_unavailable`.
9. **Implement `AdminBansStore` (Postgres).** In `packages/control-plane/src/admin/bans-store.ts`, upsert/query `admin_bans` using the partial index. Ban check is a single indexed lookup on `(identity, identity_type)`.
10. **Wire tRPC middleware.** Author `packages/control-plane/src/middleware/rate-limit.ts` per §API And Transport Changes. Iterate Spec-021 §Rate Limit Values and apply `rateLimitProcedure({ endpoint: ... })` to every matching procedure.
11. **Wire WS per-frame middleware.** Author `packages/control-plane/src/middleware/ws-rate-limit.ts` and export a `onFrame`-hook signature that Plan-008's relay consumes. Depends on Plan-008 exposing the hook (see Preconditions).
12. **Wire admin bans routes.** In `packages/control-plane/src/admin/bans-routes.ts`, register `POST /admin/bans`, `GET /admin/bans`, `DELETE /admin/bans/:id`. Auth middleware verifies PASETO v4.public token (per ADR-010); authorization delegates to Cedar (per ADR-012) with policies `admin.ratelimit.ban.{create|list|revoke}`.
13. **Reconcile contracts drift.** Three reconciliations in `docs/architecture/contracts/api-payload-contracts.md`:
    - **(a) `RateLimitResponse` (§Error Responses, lines ~79-84):** extend the 4-field shape to 5 fields (add `resetAt: string`) so it matches error-contracts.md §Rate Limiting.
    - **(b) `RateLimitCheckRequest` (§GDPR And Rate Limiting, lines ~1415-1419):** extend the 3-field shape to 5 fields — add `identityType: RateLimitIdentityType` (import the new type from `packages/contracts/src/rate-limiter.ts`) and `tier?: 'anonymous' | 'authenticated' | 'elevated'`, so the doc matches the `RateLimiter` contract authored in Step 1.
    - **(c) `RateLimitCheckResponse` (§GDPR And Rate Limiting, lines ~1420-1424):** extend the 3-field shape to 4 fields — add `limit: number`. Plus: add `AdminBanCreateRequest`/`AdminBanCreateResponse`/`AdminBanListResponse` under a new §Admin APIs section. In `docs/architecture/contracts/error-contracts.md`, add error codes `admin.forbidden` (403), `admin.ban_not_found` (404), `admin.ban_already_exists` (409 — returned when two admins race-issue a ban for the same `(identity, identity_type)`; see §Risks And Blockers), `ratelimit.backend_unavailable` (503).
14. **Author Postgres migration.** `packages/control-plane/src/migrations/XXXX-rate-limit-tables.sql` creates `admin_bans` and `rate_limit_escalations` with the schemas from §Data And Storage Changes. Use the numeric prefix that follows Plan-008's last migration (exact NNNN assigned in Session 4's BL-054 propagation pass).
15. **Emit Prometheus metrics.** Counters `ratelimit_trip_total{endpoint,tier}`, `ratelimit_block_total{window_size ∈ {5m,1h}}`, `admin_ban_total{action ∈ {issue,revoke}}`, `ratelimit_backend_error_total{backend}`. Expose via the `/metrics` endpoint owned by BL-060 / self-host secure-defaults.
16. **Ops alert integration.** The 10-in-1-hour escalation trigger emits a `ratelimit.escalated` domain event (via Plan-006 event taxonomy) with severity `warn`. Alert routing is owned by Plan-020 (observability). This plan only emits the event.

## Parallelization Notes

- Steps 1–2 (contracts) must land first; everything else orbits them.
- Steps 3, 4 (two `RateLimiter` implementations) can run in parallel once contracts land.
- Steps 6, 7 (two escalation stores) can run in parallel, both independent of steps 3, 4.
- Steps 8 (fail-open), 9 (admin bans store) can run in parallel with 3–7.
- Steps 10, 11 (tRPC + WS middleware) depend on steps 1, 3–8; can run in parallel with each other.
- Step 12 (admin routes) depends on step 9.
- Step 13 (contracts doc reconciliation) has no code dependency; can happen first.
- Steps 14–16 (migration, metrics, alert wiring) are independent tail-end tasks.

## Test And Verification Plan

- **Unit tests** (`packages/control-plane/src/rate-limit/*.test.ts`):
  - `CloudflareWorkersRateLimiter` parses `{ success: true|false }` correctly; shadow DO fallback returns safe-degrade values when DO is unreachable.
  - `PostgresRateLimiter` sliding-window is accurate under clock skew (fake timers, advance by window - 1s, confirm last request allowed; advance by window + 1s, confirm first ages out).
  - `PostgresEscalationStore` + `DurableObjectEscalationStore` both hit the 3/5-min and 10/1-hr thresholds correctly.
  - Fail-open wrapper: simulate `RateLimiter.check()` throwing; confirm allow for 60s, then throw; confirm warning log fields.
  - `AdminBansStore`: issue → findActive returns ban; revoke → findActive returns null; expired ban auto-filtered via partial index.
- **Integration tests** (`packages/control-plane/integration/*.test.ts`):
  - Spin up Postgres testcontainer, run full migrations, hammer an endpoint 61 times in 60s, assert the 61st returns HTTP 429 with correct headers and `Retry-After`.
  - Spin up Cloudflare `unstable_dev` worker with `rate_limit` binding (mocked via `@cloudflare/workers-types` helpers); hammer the same endpoint, assert 429 behavior identical to the Postgres path.
  - Three violations in 5 min → 15-min block asserted via `active_block_until` inspection in Postgres and DO storage read.
  - Ten violations in 1 hr → 1-hr block + `ratelimit.escalated` event emitted (intercept event bus).
  - Admin API: non-admin PASETO token → 403 `admin.forbidden`; admin token → 201 ban issued; revoke → 204; subsequent request from banned identity → 403.
  - WS frame-rate: open connection, send 61 frames in 60s, assert connection receives close frame with code 4029 and `retryAfter` payload.
- **Contract tests:**
  - Both `RateLimiter` implementations pass the same "contract test suite" — a shared test file that drives each through identical scenarios. This is the primary guarantee that "both implementations must enforce identical limits and expose the same programmatic interface" (Spec-021 §Deployment-Aware Abstraction).
- **Metrics verification:**
  - Drive each scenario above, scrape `/metrics`, confirm counters increment as expected.

## Rollout Order

1. Land `RateLimiter` + `AdminBansStore` contracts in `packages/contracts/` (step 1, 2).
2. Land Postgres migration for `admin_bans` + `rate_limit_escalations` (step 14).
3. Land `PostgresRateLimiter` + `PostgresEscalationStore` + `AdminBansStore` implementations (steps 4, 6, 9). Ship the contract test suite.
4. Land `CloudflareWorkersRateLimiter` + `DurableObjectEscalationStore` (steps 3, 7). Contract test suite must pass against both.
5. Land fail-open wrapper (step 8) and `RateLimiterFactory` (step 5). Wire `AIS_RATELIMIT_BACKEND` into the control-plane bootstrap.
6. Land tRPC middleware, apply to every Spec-021 endpoint (step 10).
7. Land WS per-frame middleware (step 11) — requires Plan-008's frame hook; gate this step on Plan-008 readiness.
8. Land admin bans routes (step 12) and Cedar policies (step 12).
9. Reconcile contracts drift (step 13), author migration numbering (step 14), emit metrics (step 15), wire ops alert event (step 16).
10. Deploy to staging. Monitor `ratelimit_trip_total`, `ratelimit_block_total`, `admin_ban_total`, `ratelimit_backend_error_total` for 24h. False-positive-rate target < 0.1% (per BL-044 exit criteria).
11. Flip enforcement on in production.

## Rollback Or Fallback

- **False-positive storm:** set `AIS_RATELIMIT_FAILOPEN_SECONDS=999999` to effectively disable enforcement without a redeploy (fail-open grace becomes the entire rate-limit state). Log retention captures which identity tripped.
- **Admin revocation:** any admin can `DELETE /admin/bans/:id` to lift an individual ban.
- **Backend outage:** fail-open for 60s (default grace) covers transient Postgres / DO outages. After grace, 503s surface to clients; clients retry with backoff per their own logic.
- **Rollback from v1 → pass-through:** the middleware can be uninstalled by commenting out the `.use(rateLimitProcedure(...))` on each procedure. The `RateLimiter` contract + backends remain deployed but no longer enforce. This is a code change; not a runtime toggle. Deliberate: a runtime-kill switch for rate limiting is a DoS footgun.

## Risks And Blockers

- **Cloudflare `rate_limit` binding period cap.** The binding only supports 10s or 60s periods ([Cloudflare: Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)). Escalation windows (5 min, 1 hr) must live in the DO layer. Plan accounts for this via separation of counter and escalation concerns.
- **`rate-limiter-flexible` v11.0.0 recency.** Published 2026-04-03 ([GitHub release](https://github.com/animir/node-rate-limiter-flexible/releases/tag/v11.0.0)). Breaking changes in v11: `RLWrapperBlackAndWhite` now extends `RateLimiterCompatibleAbstract` (we do not use black/white wrappers). No breakage expected. Pin to `^11.0.0` in `package.json`.
- **Clock skew across CF edge locations.** The Cloudflare `rate_limit` binding is per-location per-key by design ([Cloudflare Rate Limit binding docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)), so a highly mobile attacker rotating through locations can get `L × limit` requests for `L` locations before any single location trips. Accepted for V1 (the attack amplification is linear in location count and `limit` is already a per-minute budget; the escalation DO catches cumulative abuse). Mitigation is post-V1: route rate-limit checks through a global DO for truly consolidated state (trade-off: global DO adds 10–50ms latency to every request).
- **Cedar policy authoring for admin endpoints.** ADR-012 establishes Cedar; this plan depends on an admin-role model being available in Cedar at implementation time. If Plan-018 ships without an admin-role Postgres column, Plan-021 cannot wire admin authorization. Mitigation: file a BL-xxx dependency explicitly in Session 4's BL-054 propagation pass.
- **Plan-008 frame hook.** Plan-008 does not currently declare a per-frame receive hook. Plan-021 cannot wire WS per-frame rate limiting until Plan-008 exposes it. Mitigation: BL-054's Session 4 propagation pass must add a Preconditions entry to Plan-008's header — "Per-frame receive hook required for Plan-021's `wsRateLimit` middleware." Plan-021 declares this dependency upfront (see Preconditions).
- **`admin_bans` concurrency.** Two concurrent admins both issuing a ban for the same identity must not produce two active rows. The `UNIQUE INDEX idx_admin_bans_one_active ON admin_bans (identity, identity_type) WHERE revoked_at IS NULL` partial index (see §Data And Storage Changes) rejects the second insert with a unique-violation error. The admin-bans store catches this specific error code (`23505`) and returns a 409 `admin.ban_already_exists` response, so the losing admin gets a deterministic error rather than a silent no-op. Accepted as-is.
- **Cloudflare shadow-DO round-trip.** Every rate check consults the DO even on success (to return `remaining`/`resetAt`). This doubles the CF rate-limit check cost (~1-5ms DO lookup added to the free binding). For the hot path (60/min messages), 2ms × 60 = 120ms/min added compute per participant per minute. Accepted for V1.

## Done Checklist

- [ ] `RateLimiter` interface lives in `packages/contracts/src/rate-limiter.ts` with the shape defined in §API And Transport Changes.
- [ ] `CloudflareWorkersRateLimiter` + `PostgresRateLimiter` both pass the shared contract test suite covering every endpoint from Spec-021 §Rate Limit Values.
- [ ] `RateLimiterFactory` selects backend from `AIS_RATELIMIT_BACKEND` env var; throws on unknown value at startup.
- [ ] Postgres `admin_bans` + `rate_limit_escalations` tables ship via migration and are documented in `docs/architecture/schemas/shared-postgres-schema.md`.
- [ ] `DurableObjectEscalationStore` class is declared in the CF worker's DO registry and handles 5-min / 1-hr windows via `alarm()`-driven trim.
- [ ] tRPC middleware `rateLimitProcedure` is wired on every approved endpoint per Spec-021 §Rate Limit Values.
- [ ] WS per-frame rate check `wsRateLimit` is wired in Plan-008 relay's frame receive hook (gated on Plan-008's hook existing).
- [ ] Escalation ladder trips at 3 violations / 5 min → 15-min block, 10 / 1 hr → 1-hr block + `ratelimit.escalated` event; permanent bans only via admin API.
- [ ] Admin API (`POST /admin/bans`, `GET /admin/bans`, `DELETE /admin/bans/:id`) requires PASETO v4.public auth and passes Cedar `admin.ratelimit.ban.*` authorization.
- [ ] Fail-open grace is configurable via `AIS_RATELIMIT_FAILOPEN_SECONDS` (default 60); exceeds-grace returns 503 `ratelimit.backend_unavailable`.
- [ ] 429 responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` computed as `max(0, ceil((resetAt - now) / 1000))`.
- [ ] Contracts drift reconciled in api-payload-contracts.md: `RateLimitResponse` extended to the 5-field canonical form (adds `resetAt`); `RateLimitCheckRequest` extended to include `identityType` and optional `tier`; `RateLimitCheckResponse` extended to include `limit`; `AdminBanCreateRequest`/`AdminBanCreateResponse`/`AdminBanListResponse` added under §Admin APIs.
- [ ] Error codes `admin.forbidden` (403), `admin.ban_not_found` (404), `ratelimit.backend_unavailable` (503) are added to error-contracts.md.
- [ ] Prometheus metrics `ratelimit_trip_total`, `ratelimit_block_total`, `admin_ban_total`, `ratelimit_backend_error_total` are exported via `/metrics`.
- [ ] Local daemon IPC path is NOT rate-limited (Spec-021 §Scope exclusion confirmed in code — no middleware is wired on the daemon host).
- [ ] KeyPackage upload limit is not wired (V1.1+ per Spec-021's `KeyPackage uploads (V1.1+)` row and ADR-010's MLS deferral).
- [ ] Postgres backend enforces `sslmode=verify-full` for self-host deployments per [Spec-027 row 5](../specs/027-self-host-secure-defaults.md#required-behavior); `require` is refused at config-parse time with error naming [CVE-2024-10977](https://www.postgresql.org/support/security/CVE-2024-10977/) rationale; `verify-ca` accepted only with loud banner + `security.default.override=postgres_sslmode=verify-ca` log event.

## Tier Placement

Tier 6 per [cross-plan-dependencies.md §5 Canonical Build Order](../architecture/cross-plan-dependencies.md#5-canonical-build-order). Strictly **downstream of Plan-008** (this plan consumes Plan-008's tRPC router and WS frame hook) and **upstream of Plan-025** (Plan-025 is the self-hostable Node relay that instantiates `PostgresRateLimiter` inside its compose-deployed process).

## References

- [Spec-021: Rate Limiting Policy](../specs/021-rate-limiting-policy.md)
- [ADR-014: tRPC Control-Plane API](../decisions/014-trpc-control-plane-api.md)
- [ADR-020: V1 Deployment Model And OSS License](../decisions/020-v1-deployment-model-and-oss-license.md)
- [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md)
- [ADR-012: Cedar Approval Policy Engine](../decisions/012-cedar-approval-policy-engine.md)
- [Deployment Topology §Rate Limiting By Deployment](../architecture/deployment-topology.md)
- [Cloudflare Workers: Rate Limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [rate-limiter-flexible v11.0.0 release](https://github.com/animir/node-rate-limiter-flexible/releases/tag/v11.0.0)
- [tRPC v11 middlewares](https://trpc.io/docs/server/middlewares)
