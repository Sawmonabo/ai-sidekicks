# Plan-019: Rate Limiting Policy

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `019` |
| **Slug** | `rate-limiting-policy` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude Opus 4.7` |
| **Spec** | [Spec-019: Rate Limiting Policy](../specs/019-rate-limiting-policy.md) |
| **Required ADRs** | [ADR-014: tRPC Control-Plane API](../decisions/014-trpc-control-plane-api.md); [ADR-020: V1 Deployment Model And OSS License](../decisions/020-v1-deployment-model-and-oss-license.md); [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md); [ADR-010: Tokens, Passkeys And The Remote Channel](../decisions/010-tokens-passkeys-and-the-remote-channel.md) |
| **Dependencies** | the shipped control-plane host (the stable tRPC middleware-mount surface consumed here; `wrangler.toml` deployment config extended); [Plan-028](./028-remote-control.md) (the relay's per-frame admission seam, consumed on the Workers path); Plan-016 (`AuthenticatedIdentityContext` — the `ctx.userId` producer for identity resolution). Non-blocking context, not dependencies: Plan-006 daemon-IPC scope exclusion (§Non-Goals); the Plan-018 metric-name doc contract (CP-019-4 — no code consumed); Plan-028's self-host relay node as a downstream consumer (see §Cross-Plan Obligations) |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |

## Goal

Ship the Spec-019 rate-limiting enforcement layer for the person's own relay — the Workers relay in their own Cloudflare account, or the self-hosted relay — across the control-plane tRPC surface and the WebSocket relay data path, as a single `RateLimiter` contract with deployment-aware implementations (Cloudflare-native `rate_limit` binding + a per-identity Durable Object for the Workers relay, which holds the authoritative window and counts the credential routes once worldwide; `rate-limiter-flexible` v11.0.0 with a Postgres backend for the self-hosted relay), one admission check both transports call, a per-device frame quota counted in the relay's memory, and canonical `rate_limit_*` telemetry. Enforcement must be identical in both deployment modes (identical limits, identical headers, identical error envelopes) so that protocol-level changes land once and ship to both.

## Scope

- `RateLimiter` contract owned by this plan at `packages/control-plane/src/rate-limit/rate-limiter.ts`, with the typed `RateLimitEndpointGroup` key union derived from the [Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) and the identity-type, tier and check request/response types: only the relay's control plane checks a limit, and the daemon never does. The wire the daemon and devices read lives in `packages/contracts`: the canonical `RateLimitResponse` envelope + Zod schema (D-019-6) and the in-band `rate_limited` frame's schema in `rate-limiter.ts`, and the `ratelimit.backend_unavailable` code in `error.ts`.
- The `RateLimiter` implementations:
  - `CloudflareWorkersRateLimiter` — wraps `env.<LIMITER>.limit({ key })` per the Cloudflare `rate_limit` binding, with the per-identity `RateLimitIdentityDO` consulted on every check for authoritative window values, and serving as the counter itself for the credential-route groups (eager-DO, D-019-3).
  - `PostgresRateLimiter` — wraps `rate-limiter-flexible` v11.0.0's `RateLimiterPostgres` store (self-host), one instance per endpoint group (D-019-4).
- `RateLimiterFactory` — runtime selector via env var `AIS_RATELIMIT_BACKEND={cloudflare|postgres}`, fails loudly on unknown **or absent** value; also reads `AIS_RATELIMIT_MODE={enforce|observe}` once at construction (D-019-16).
- One admission stage (D-019-3): `checkAdmission` runs `RateLimiter.check()`, whose sliding-window counter is the only stage; a trip is a 429 with the window's `Retry-After`. tRPC procedures and raw routes call only `checkAdmission`; device relay frames are admitted by the device quota.
- tRPC v11 middleware `rateLimitProcedure({ endpoint, identityKeyFn? })` wired per the §Endpoint Wiring Ownership table (D-019-6 — not every spec row is wired by this plan).
- WebSocket per-frame admission consumed by [Plan-028](./028-remote-control.md)'s relay on both deployments: each device's frames counted in the relay's memory against the `ws.message` quota (6,000 a minute); a device over it gets one in-band `rate_limited` frame and a 60-second pause with the connection kept open (D-019-9).
- Fail-open grace period controlled by `AIS_RATELIMIT_FAILOPEN_SECONDS` env var (default 60s); after grace, fail-closed with HTTP 503; degraded responses carry `degraded: true` and suppress all `X-RateLimit-*` headers.
- Retry-After and standard rate-limit headers on every 429 ([Spec-019 §Overflow Response](../specs/019-rate-limiting-policy.md#overflow-response)); on allowed responses headers attach only when `remaining < 25%` of the limit ([Spec-019 §Default Behavior](../specs/019-rate-limiting-policy.md#default-behavior)).
- Prometheus-compatible metrics, canonical snake spelling (D-019-8): `rate_limit_trip_total{endpoint,tier}`, `rate_limit_backend_error_total{backend}`, `rate_limit_failclosed_total{backend}`. Registration + emission only; exposition is downstream (D-019-15).

## Non-Goals

- **Local daemon IPC rate limiting.** [Spec-019 §Scope](../specs/019-rate-limiting-policy.md#scope) explicitly excludes the daemon path (trusted by socket reachability). This plan consumes that exclusion; no IPC-side middleware is authored, and a structural import-boundary test enforces it (I-019-1 verification companion).
- **A scrape endpoint on the Workers relay.** Workers offers no scrape surface, so the Workers relay writes the same bounded counters as structured log lines, which the person reads in their own Cloudflare dashboard (D-019-15). The self-hosted relay serves Spec-024 row 9b's `/metrics` on loopback. The person's everyday view of the relay is the relay block of `sidekicks daemon status`.
- **Per-model / per-provider token-level throttling.** Out of [Spec-019 §Non-Goals](../specs/019-rate-limiting-policy.md#non-goals).
- **Billing metering.** Nothing is billed: the relay serves its one owner.
- **Admin credentials for more than one person, and a service principal.** The relay has one owner. Only the person's own daemon and devices call it, each authenticating as the person, so no `system service` principal or tier exists, and this plan adds no admin surface.
- **Custom rate-limit algorithms beyond sliding window.** Fixed-window and token-bucket are not implemented; [Spec-019 §Implementation Notes](../specs/019-rate-limiting-policy.md#implementation-notes) prefers sliding windows.
- **Bans and automatic escalation.** A limit refuses only for its own window: no identity is blocked beyond it, and nothing is banned. A stolen device's token is answered by revoking that device through Remote Control's own control ([Spec-028](../specs/028-remote-control.md)); the relay holds one live connection per device key and flags a key that keeps displacing itself.
- **Wiring the dormant rows.** `artifact.publish` is **dormant** — no control-plane method string or tRPC procedure for artifact publication is registered anywhere in the corpus, publication being a client↔daemon call, so the row arms only when a network-reachable publication surface is introduced, as [Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) states (no backlog item); `approval.resolve` is **dormant** — an answer is taken by the owning machine's daemon, locally or from another linked device through that device's end-to-end encrypted channel, which the relay cannot read, and Spec-019 excludes the daemon IPC path from rate limiting, so no wiring surface exists (the row arms when the local daemon becomes reachable over the network or an answer leaves the owning machine's daemon for a surface the control plane or the relay can read, as [Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) states — no backlog item). See §Endpoint Wiring Ownership.

## Preconditions

- [x] Spec-019 is approved and carries the §Canonical Endpoint Group Registry, the check shape and the WS overflow semantics (D-019-4/6/9).
- [x] ADR-014 (tRPC control-plane API) is accepted — establishes the tRPC router surface; the concrete middleware-mount seam is the control-plane host's (see CP-019-1).
- [x] ADR-020 (deployment model) is accepted — declares both rate-limiter backends in scope.
- [x] ADR-010 (PASETO v4.public) is accepted — provides the token primitive behind `AuthenticatedIdentityContext` (user identity resolution for the middleware).
- [ ] The control-plane surfaces are shipped: the stable middleware-mount surface (PASETO middleware + router host) that `rateLimitProcedure` mounts onto.
- [ ] [Plan-028](./028-remote-control.md) Phase 3 exposes the relay's per-frame admission seam (CP-019-5). Gates the **Workers** half of Phase 3 WS wiring only; the self-host path is independently wired on the self-host relay node and is not gated on this precondition (D-019-2).
- [ ] Plan-016 ships `AuthenticatedIdentityContext` (the `ctx.userId` producer).

## Target Areas

- `packages/contracts/src/rate-limiter.ts` — **created by this plan.** The wire the daemon and devices read: the `RateLimitResponse` 429 envelope + `RateLimitResponseSchema` (Zod), and the schema of the in-band `rate_limited` frame the relay sends a device over its quota (the shape registered in api-payload-contracts §Relay Rate-Limit Signaling).
- `packages/contracts/src/error.ts` — **extended by this plan:** the `ratelimit.backend_unavailable` code (503), which clients read.
- `packages/control-plane/src/rate-limit/` — **created by this plan.**
  - `rate-limiter.ts` — `RateLimitIdentityType`, `RateLimitTier`, `RateLimitEndpointGroup`, `RateLimitCheckRequest`/`RateLimitCheckResponse` and the `RateLimiter` interface; the control plane and the self-host relay node, which imports the control plane's limiter, are their only users.
  - `endpoint-limits.ts` — canonical endpoint-group → `{ limit, period }` config module transcribed from the Spec-019 registry (single source for both backends and wrangler parity).
  - `cloudflare-rate-limiter.ts` — Cloudflare-binding implementation (eager-DO, D-019-3).
  - `identity-durable-object.ts` — the `RateLimitIdentityDO` class and its Worker-side stub resolver (Workers only).
  - `postgres-rate-limiter.ts` — `rate-limiter-flexible` Postgres implementation.
  - `factory.ts` — runtime backend selector + observe-mode read.
  - `enforcement-pipeline.ts` — `createAdmissionCheck`, which returns `checkAdmission` (the limiter check with the trip-telemetry seam, D-019-3).
  - `fail-open.ts` — grace-period wrapper (wraps any `RateLimiter` with fail-open/fail-closed logic + `degraded` marker).
  - `metrics.ts` — `RateLimitMetrics` registry wrapper (the canonical families, emission-time label guard).
  - `rate-limiter-contract-suite.ts` — exported shared contract suite (`describeRateLimiterContract`), the I-019-2 parity proof the self-host relay node re-runs.
- `packages/control-plane/src/middleware/rate-limit.ts` — **created by this plan.** tRPC middleware `rateLimitProcedure`.
- `packages/control-plane/src/middleware/ws-rate-limit.ts` — **created by this plan.** The device frame quota, consumed through the relay's per-frame seam (Workers) and the self-host relay node (self-host).
- `packages/control-plane/src/server/host.ts` — **extended by this plan (export-only edit):** re-export `RateLimitIdentityDO` from the Worker entry module (Cloudflare requires DO classes exported from the deployed script), inside the CP-019-1 stable-mount seam.
- `packages/control-plane/package.json` — **extended by this plan:** `rate-limiter-flexible: ^11.0.0`, `prom-client` dependencies.
- `eslint.config.mjs` — a `no-restricted-imports` entry scoped to `packages/runtime-daemon/**` that keeps the daemon from importing the relay's rate-limit code (T21.3-6).
- `docs/architecture/contracts/api-payload-contracts.md` — carries the `RateLimitResponse` (symbol anchor: `interface RateLimitResponse` under §Error Responses); the `RateLimitCheckRequest` and `RateLimitCheckResponse` (window arm with the window fields; fail-open degraded arm: `{allowed: true, degraded: true, graceEndsAt}`, no window fields) under §GDPR And Rate Limiting; `"ratelimit"` in the illustrative `ErrorNamespace` union; and the in-band refusal frame under §Relay Rate-Limit Signaling. T21.1-4 verifies shape parity against the typed exports at implementation time and lands only drift fixes.
- `docs/architecture/contracts/error-contracts.md` — carries the canonical envelope and the §Rate Limiting enforcement-layer code `ratelimit.backend_unavailable` (503). T21.1-5 verifies code-table parity at implementation time and lands only drift fixes.
- `docs/architecture/deployment-topology.md` §Rate Limiting By Deployment — the Workers application-layer cell reads as the binding counter + per-identity window-authority DO split, with the credential routes counted in the DO (D-019-3).
- `wrangler.toml` (Workers; extended at Phase-2 landing) — declare (a) `[[ratelimits]]` bindings one per binding-backed endpoint group (D-019-4), (b) `[[durable_objects.bindings]]` `{ name = "RATE_LIMIT_IDENTITY", class_name = "RateLimitIdentityDO" }`, (c) a `[[migrations]]` entry adding `RateLimitIdentityDO` to `new_sqlite_classes`, and (d) `[vars] AIS_RATELIMIT_BACKEND = "cloudflare"` + `AIS_RATELIMIT_MODE`.

## Data And Storage Changes

This plan owns no table: every piece of rate-limit state is ephemeral and bounded by its window (I-019-5). Erasure needs no step here — the per-identity DO deletes its own storage once its windows pass, the binding counters are non-addressable and expire within their declared period, and each `ratelimit_*` key expires with its window.

### Postgres: `ratelimit_*` namespace tables (self-host only — not owned, not in the control plane's one schema)

`rate-limiter-flexible` auto-creates its counter tables on first use. `PostgresRateLimiter` configures each `RateLimiterPostgres` with a `keyPrefix` namespacing into `ratelimit_*` and leaves table creation to the library. These tables are not in the control plane's one schema; they hold only sliding-window counters, each key expiring with its window (I-019-5).

### Durable Object: `RateLimitIdentityDO` (Workers only)

- One DO instance per `(identity, identity_type)` pair, keyed by `idFromName(`${identityType}:${identity}`)`.
- Persisted state (survives worker restart) via DO's built-in storage API: per-group window state — the in-window request times for each endpoint group — which gives the authoritative `remaining`/`resetAt` (eager-DO, D-019-3); for the credential-route groups, which bypass the binding, the window is the counter of record (T21.2-5 step e).
- **Single-alarm scheduling:** Cloudflare permits one scheduled alarm per object and `setAlarm` overrides. On every state change, re-arm to the earliest per-group window expiry. `alarm()` drops expired per-group window state and re-arms if live state remains; once every window has expired it calls `storage.deleteAll()` (no per-identity residue survives) and the DO idles out with no alarm. Every registry window is 60 seconds, so an identity's state is gone within a minute of its last request.
- RPC surface = `recordAllowed`, which folds an allowed request into per-group window state and returns authoritative `remaining`/`resetAt` in the same round-trip; `readWindow`, which returns a group's `resetAt` for a refusal the binding made; and `checkAndConsume`, the atomic per-group check+consume that IS the counter for the credential-route groups (T21.2-5 step e: refuses over-threshold; one global count in place of the per-location binding). The Worker-side stub resolver lives in the same module.

### Cloudflare `[[ratelimits]]` bindings (Workers only)

- One binding per **60s-window** sliding-window endpoint group from the Spec-019 registry, except the classes that declare none: the credential-route groups, which count in the DO instead so a caller meets one global count (the T21.2-5 step-e `checkAndConsume` branch); `ws.message`, whose device quota is counted in the relay's memory (§WebSocket per-frame admission); `presence.heartbeat`, which the machine counts ([Plan-028](./028-remote-control.md)); and the **dormant rows** (`approval.resolve`, `artifact.publish`) — named as a class rather than one instance so the carve-out stays correct the next time a row goes dormant ([Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) dormant-row semantics). Each binding declared with `period: 60` (or `period: 10` for sub-minute limits) and `limit: <threshold>` per the registry.
- Example (partial):
  ```toml
  [[ratelimits]]
  name = "GENERAL_API_LIMITER"
  namespace_id = "1001" # string containing a positive integer, unique per namespace
  simple = { limit = 100, period = 60 }
  ```
- `namespace_id` integers are allocated sequentially per binding; the allocation table lives in `endpoint-limits.ts` so IDs never collide across deploys.
- The binding exposes only `limit({ key }) → { success }`; declared `limit`/`period` values are NOT runtime-readable. `endpoint-limits.ts` is the canonical config source for both the wrangler block and the in-code values, with a unit test asserting wrangler.toml parity.

### `RateLimitResponse` canonical shape

The 429 envelope has one shape, the same in error-contracts.md §Rate Limiting and api-payload-contracts.md §Error Responses:

```ts
interface RateLimitResponse {
  code: "rate_limited";
  retryAfter: number; // seconds until retry is allowed
  limit: number; // total allowed requests in the window
  remaining: number; // requests remaining in the current window
  resetAt: string; // ISO 8601 timestamp when the limit resets
}
```

Code-level home: `packages/contracts/src/rate-limiter.ts` (T21.1-1) exports the interface + `RateLimitResponseSchema` so its consumers assert against a typed export instead of a doc shape. The api-payload-contracts.md shape is anchored by symbol (`interface RateLimitResponse` under §Error Responses); T21.1-4 verifies doc-vs-export parity at implementation time. Every refusal carries both timing fields, so `RateLimitResponseSchema` requires both and an envelope missing either fails parse (T21.1-6).

## API And Transport Changes

### `RateLimiter` contract (new, owned by this plan)

```ts
// packages/control-plane/src/rate-limit/rate-limiter.ts
export type RateLimitIdentityType = "user" | "ip"; // D-019-17

export type RateLimitTier = "anonymous" | "authenticated";

// Union of the Key column of Spec-019 §Canonical Endpoint Group Registry (D-019-6).
export type RateLimitEndpointGroup =
  | "general.api"
  | "auth.endpoint"
  | "unauthenticated.request"
  | "presence.heartbeat"
  | "approval.resolve"
  | "artifact.publish"
  | "health.check"
  | "ws.message";

export interface RateLimitCheckRequest {
  identity: string; // canonical form per §Identity And Tier Resolution
  identityType: RateLimitIdentityType;
  endpoint: RateLimitEndpointGroup;
  tier?: RateLimitTier;
  context?: Record<string, unknown>;
}

// The window arm reports authoritative backend window state; the
// degraded arm is minted ONLY by the fail-open wrapper during grace and
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
    }
  | { allowed: true; degraded: true; graceEndsAt: string };

export interface RateLimiter {
  check(req: RateLimitCheckRequest): Promise<RateLimitCheckResponse>;
}
```

- The interface intentionally collapses `rate-limiter-flexible` v11.0.0's `RateLimiterCompatibleAbstract` surface (`consume, get, set, delete, penalty, reward, block, getKey`) into a single `check()` because the Cloudflare `rate_limit` binding exposes only `limit({ key })` returning `{ success }`. The Workers `check()` consults the DO inside the call (D-019-3), so the shared contract suite proves both backends through that one method.
- `RateLimiter` and its check types live in the control plane's package: only the relay's control plane and the self-host relay node check a limit, and the daemon never does ([Spec-019 §Scope](../specs/019-rate-limiting-policy.md#scope)). The `RateLimitResponse` envelope and the `rate_limited` frame, which the daemon and devices read, ship in `packages/contracts/src/rate-limiter.ts` as interface + Zod schema per the `runtime-node.ts` wire-shape convention.

### Admission pipeline (D-019-3)

```ts
// packages/control-plane/src/rate-limit/enforcement-pipeline.ts
export interface AdmissionResult {
  admitted: boolean; // false = a counter trip: 429 with the envelope and headers built from `check`
  check: RateLimitCheckResponse;
}

export type AdmissionCheck = (req: RateLimitCheckRequest) => Promise<AdmissionResult>;

export function createAdmissionCheck(deps: {
  limiterFor: (endpoint: RateLimitEndpointGroup) => RateLimiter;
  onTrip?: (labels: { endpoint: RateLimitEndpointGroup; tier: RateLimitTier }) => void; // fires on EVERY refusal, observe + enforce alike — T21.4-1 binds rate_limit_trip_total (the D-019-16 soak input)
}): AdmissionCheck; // what middleware and raw routes consume as `checkAdmission`
```

One stage on every enforced transport (I-019-1): tRPC procedures and raw routes call `checkAdmission`, whose only stage is the sliding-window counter inside `limiter.check()`; device relay frames are admitted by the device quota (§WebSocket per-frame admission). Observe mode (D-019-16) is applied by the consumers: checks run and telemetry emits — `onTrip` fires on every refusal regardless of mode, so `rate_limit_trip_total` counts would-be 429s during the observe soak — but refusals are not enforced.

### Identity and tier resolution (D-019-4, D-019-14)

- **Typed identity pair.** `identityKeyFn` returns `{ identity: string; identityType: RateLimitIdentityType }`; absent the override, resolution is `ctx.userId` → `{ identity: userId, identityType: 'user' }`, else `{ identity: clientIp, identityType: 'ip' }`. The pair always travels together; no bare-string identities.
- **Canonical identity forms (D-019-14):** `user` = UserId UUID string; `ip` = IPv4 exact dotted-quad / IPv6 normalized to its /64 prefix (lowercase, compressed).
- **Client IP provenance.** Workers: the Cloudflare-set `CF-Connecting-IP` header. Self-host: leftmost-untrusted-hop `X-Forwarded-For`, honored ONLY under explicit Fastify trust-proxy configuration for the Caddy hop (the self-host relay node propagates the header; the `trustProxy` setting is its server bootstrap). An anonymous-tier request with no resolvable IP is refused 400 rather than rate-limited into a shared bucket.
- **Tier resolution (D-019-4):** auth state yields `anonymous` | `authenticated`. Caller-supplied tier values are never trusted.

### tRPC middleware surface (mounts onto the control-plane host per CP-019-1)

```ts
// packages/control-plane/src/middleware/rate-limit.ts
export const rateLimitProcedure = (opts: {
  endpoint: RateLimitEndpointGroup;
  identityKeyFn?: (ctx: Ctx) => { identity: string; identityType: RateLimitIdentityType };
}) =>
  t.middleware(async ({ ctx, next }) => {
    const { identity, identityType } = resolveIdentity(ctx, opts.identityKeyFn); // D-019-14
    const tier = tierFromAuthState(ctx);
    const admission = await ctx.checkAdmission({
      identity,
      identityType,
      endpoint: opts.endpoint,
      tier,
    });
    if (!admission.admitted && ctx.rateLimitMode === "enforce") {
      throw tooManyRequests(rateLimitResponseFrom(admission.check)); // 429 + canonical envelope + headers
    }
    return next({ ctx: { ...ctx, rateLimitHeaders: headersFrom(admission) } });
  });
```

- Usage on a procedure: `t.procedure.use(rateLimitProcedure({ endpoint: 'auth.endpoint' }))`. The tRPC v11 middleware chaining model is documented in [tRPC v11 middlewares](https://trpc.io/docs/server/middlewares) (uses `.use()` with opts `{ ctx, path, type, input, getRawInput, next }`).
- Header policy: every rate-limit header on every 429; on allowed responses, headers attach only when `remaining < 25%` of the limit; no headers while `degraded` is set ([Spec-019 §Default Behavior](../specs/019-rate-limiting-policy.md#default-behavior)).

### WebSocket per-frame admission (consumed on Workers and self-host per CP-019-5)

```ts
// packages/control-plane/src/middleware/ws-rate-limit.ts
export const wsRateLimit =
  (
    mode: "enforce" | "observe",
    deviceQuota: DeviceFrameQuota, // in memory; one count per live device connection: 6,000 frames per 60 s, then a 60 s pause
  ) =>
  (conn: WsConnection, frame: WsFrame): WsAdmissionOutcome => {
    if (conn.side === "machine") return { proceed: true }; // a machine's frames are bounded by the channel's backpressure, not by this row
    const quota = deviceQuota.count(conn.deviceId, frame.receivedAt); // records a trip on rate_limit_trip_total{endpoint="ws.message",tier="authenticated"} in both modes
    if (mode === "observe" || quota.within) return { proceed: true }; // observe: D-019-16 soak — the would-be pause is recorded, never enforced
    return quota.firstOfPause
      ? { proceed: false, sendFrame: rateLimitedFrame(quota) } // one refusal frame, retryAfter 60
      : { proceed: false }; // the rest of the pause: dropped with no further frame
  };
```

- **Quota semantics (D-019-9):** every frame a device sends on its connection counts, whatever it carries — the relay reads only frame sizes and times. Over 6,000 frames in a sliding 60 seconds, the device gets one in-band `rate_limited` frame (`retryAfter: 60`; shape registered in [api-payload-contracts.md §Relay Rate-Limit Signaling](../architecture/contracts/api-payload-contracts.md#relay-rate-limit-signaling)) and the relay drops that device's frames for 60 seconds with no further frame. The quota never closes the connection: closing would turn a one-frame overflow into a reconnect storm. The relay reports the refusal to the machine, whose `sidekicks daemon status` adds it to that device's rejected-frame count. The count lives in the relay's memory and ends with the connection; the relay holds one live connection per device key, so one count is one device. Single-signal contract: the hook returns the outcome; the CALLER (relay frame handler) performs the send — the hook never writes to the connection.
- **Observe mode (D-019-16):** `mode` is factory-provided at construction (`createRateLimiterFactory` reads `AIS_RATELIMIT_MODE` once — T21.2-7), mirroring the tRPC middleware's `ctx.rateLimitMode`. In observe, over-quota frames still return `{ proceed: true }` — the trip is recorded on `rate_limit_trip_total{endpoint,tier}`, but no `rate_limited` frame is sent and no pause starts.
- **What is counted:** `ws.message` is the only group this hook meters. `presence.heartbeat` and `approval.resolve` are never reachable here as themselves: a heartbeat and an answer each ride inside a device's end-to-end encrypted channel ([Spec-028](../specs/028-remote-control.md)) and reach this hook as frames like any other.
- Zero-knowledge constraint (CP-019-5): the seam exposes frame sizes and times and the connection's side and device id only.

### Standard headers on 429 responses

429 responses must set:

- `X-RateLimit-Limit: <limit>`
- `X-RateLimit-Remaining: 0`
- `X-RateLimit-Reset: <unix-timestamp-seconds>`
- `Retry-After: <seconds>` — formula: `max(0, ceil((resetAt - now) / 1000))`. For the Postgres sliding-window backend, `resetAt` is "the time the oldest counted request ages out of the window" (the oldest in-window hit's timestamp plus the window duration). For the Cloudflare backend, `resetAt` is the DO-tracked authoritative window state (eager-DO, D-019-3).

## Invariants

| ID | Invariant | Verified by |
| --- | --- | --- |
| I-019-1 | Every enforced transport admits through one stage: tRPC procedures and raw routes through `checkAdmission`, whose only stage is the sliding-window counter, and device relay frames through the in-memory device quota. The daemon IPC path is reachable by no admission stage. | T21.3-2 pipeline unit tests; T21.3-4 quota unit tests; the daemon's `no-restricted-imports` lint rule (T21.3-6). |
| I-019-2 | Both `RateLimiter` backends enforce identical limits and expose identical `check()` semantics for every canonical endpoint group; backend selection is configuration-only. | `rate-limiter-contract-suite.ts` (T21.2-9) green against both backends in CI; the self-host relay node re-runs it (CP-019-3). |
| I-019-4 | Backend failure yields fail-open for at most the configured grace per wrapper scope, then 503 `ratelimit.backend_unavailable`; degraded responses carry no window fields at all (the degraded union arm) and serialize zero rate-limit headers. | T21.2-8 fail-open unit rows (grace expiry → throw; degraded header suppression); T21.4-3 grace-expiry 503 integration row. |
| I-019-5 | Rate-limit state is ephemeral and bounded by its window: sliding-window counters live in binding state, `ratelimit_*` keys or the per-identity DO's window state; device frame counts live in the relay's memory and end with the connection; no table this plan owns holds rate-limit state. | DO restart-persistence and full-expiry eviction tests (T21.2-4); the T21.3-4 closed-connection row. |
| I-019-7 | The check request/response and the 429 `RateLimitResponse` envelope have exactly one canonical shape — identical in [Spec-019 §Interfaces And Contracts](../specs/019-rate-limiting-policy.md#interfaces-and-contracts), error-contracts.md, api-payload-contracts.md, and code: the check shapes in `packages/control-plane/src/rate-limit/rate-limiter.ts`, the envelope in `packages/contracts/src/rate-limiter.ts`. | T21.1-4/T21.1-5 parity verification at implementation; T21.1-6 schema tests (the full envelope parses; an envelope missing a field or half-timed is rejected); cross-doc drift checked at review. |
| I-019-8 | Rate-limit metric labels are compile-time-enumerable, PII-free, and emission-time-enforced per [Plan-018 §Prometheus /metrics Exposition (Spec-024 row 9)](./018-observability-and-failure-recovery.md#prometheus-metrics-exposition-spec-024-row-9); total series across the plan's families < 50. | T21.4-1 unit tests (out-of-allow-list label throws per family; series-count assertion). |

## Cross-Plan Obligations

| ID | Direction | Counterparty | Obligation | Anchor |
| --- | --- | --- | --- | --- |
| CP-019-1 | consumes ← | the control-plane host | The stable tRPC middleware-mount surface that `rateLimitProcedure` mounts onto; the host authors no rate-limit **middleware** task — `rateLimitProcedure` authorship stays here. The DO class export is an export-only edit inside the same stable-mount seam. | [Plan-019 §Target Areas](#target-areas) |
| CP-019-3 | provides → | [Plan-028](./028-remote-control.md)'s self-host relay node | `RateLimiter` contract + `PostgresRateLimiter` (constructor: injected `pg.Pool` + `endpoint-limits`) + `createAdmissionCheck` + `wsRateLimit`, instantiated not re-implemented; the `AIS_RATELIMIT_BACKEND` / `AIS_RATELIMIT_FAILOPEN_SECONDS` / `AIS_RATELIMIT_MODE` env contract; the exported contract suite at `packages/control-plane/src/rate-limit/rate-limiter-contract-suite.ts` (the relay node re-runs it). | [Spec-024](../specs/024-self-host-secure-defaults.md) rows 5 / 9 |
| CP-019-4 | consumes ← | Plan-018 | §Prometheus /metrics Exposition label invariants (doc contract only — no Plan-018 code consumed). Reciprocal: the canonical `rate_limit_*` family set is the sole registry for those families (D-019-8). | [Plan-018 §Prometheus /metrics Exposition](./018-observability-and-failure-recovery.md#prometheus-metrics-exposition-spec-024-row-9) |
| CP-019-5 | consumes ← | [Plan-028](./028-remote-control.md) Phase 3 (the relay) | The per-frame admission seam on the zero-knowledge relay (frame sizes and times, the connection's side and device id only) into which `wsRateLimit` injects on the Workers path. | Plan-028 §Phase 3 — The relay |

### Endpoint wiring ownership (D-019-6)

`rateLimitProcedure` is NOT applied by iterating the spec registry; ownership is explicit:

| Endpoint group (canonical key) | Procedure owner | Wiring owner + mechanism |
| --- | --- | --- |
| `general.api` fallback | the shipped control-plane routers | Plan-019 T21.3-6 |
| `presence.heartbeat` | the machine ([Plan-028](./028-remote-control.md)) | Counted by the machine, the end that reads the method: each device sends its heartbeat inside its end-to-end encrypted channel to each machine ([Spec-028](../specs/028-remote-control.md)), so the relay forwards it as a `ws.message` frame and never sees a heartbeat; the machine counts it inside the device's sealed connection, admits 10 a minute per connected device, drops the excess and keeps the last heartbeat per device |
| `health.check` | the control-plane host (+ the self-host relay node) | Plan-019 T21.3-6 (Workers); the relay node's own bootstrap (self-host) |
| `approval.resolve` | — (dormant) | No wiring surface: an answer is taken by the owning machine's daemon — locally, which Spec-019 excludes from rate limiting (§Scope, §Non-Goals, AC), or from another linked device through that device's encrypted channel, which the relay forwards as `ws.message` frames without reading. Row stays priced/reserved; it arms when the local daemon becomes reachable over the network or an answer leaves the owning machine's daemon for a surface the control plane or the relay can read ([Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry)), wired then by the surface-owning plan at the registry price (the `artifact.publish` reserved-row posture; no backlog item) |
| `artifact.publish` | — (dormant) | No wiring surface: **no control-plane method string or tRPC procedure for artifact publication is registered anywhere in the corpus** — [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) shapes the `ArtifactPublish` family and binds its ingest sibling to the **local IPC transport**, [Spec-012 §Interfaces And Contracts](../specs/012-artifacts-files-and-attachments.md#interfaces-and-contracts) places publication at the client↔daemon boundary, Plan-012 T14.5 registers `artifact.*` under Plan-006's daemon JSON-RPC registry, and Spec-019 excludes daemon IPC from rate limiting (§Scope, §Non-Goals, AC). No network-reachable counterpart exists: a device reads a session's artifacts from the machine that holds them, through Remote Control's method proxy. Row stays priced/reserved; it arms when a network-reachable publication surface is introduced ([Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry)), wired then by the surface-owning plan at the registry price (the `approval.resolve` reserved-row posture; no backlog item) |
| `ws.message` | the relay ([Plan-028](./028-remote-control.md)), both deployments | Plan-019 T21.3-4 via CP-019-5 (Workers); the relay node's own bootstrap (self-host) |
| `auth.endpoint` / `unauthenticated.request` | Plan-016 auth + the host's unauthenticated procedures | Plan-019 T21.3-6 (fallback buckets + auth group over shipped procedures) |

## Design Decisions

| ID | Decision |
| --- | --- |
| D-019-2 | Workers WS frame seam = CP-019-5 on [Plan-028](./028-remote-control.md)'s relay: a per-frame admission seam exposing frame sizes and times and the connection's side and device id only (the relay's zero-knowledge property preserved). Self-host path independent (the relay node's own bootstrap). |
| D-019-3 | Eager-DO on Workers: the per-identity `RateLimitIdentityDO` is consulted on every binding-backed check and holds the authoritative per-group window the headers report (`remaining`/`resetAt`); for the credential-route groups it is the counter itself, one global count per identity (T21.2-5 step e). The sliding-window counter runs inside `RateLimiter.check()` on both backends, and `checkAdmission` wraps it with the trip telemetry. DO cost priced + accepted in §Risks. |
| D-019-4 | The tiers `anonymous` and `authenticated`, both at the registry's base limit: every caller with credentials is the person, so no caller holds a multiple of another's limit. One limiter per endpoint group — one binding on Workers, one `RateLimiterPostgres` instance on self-host; tier comes from auth state and is never caller-supplied; no service principal exists. |
| D-019-6 | [Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) is the single limit enumeration with canonical keys; `general.api`/`unauthenticated.request` fallback buckets; the §Endpoint Wiring Ownership table assigns every row; every dormant row arms when a network-reachable surface for it exists (the registry's dormant-row semantics), never through a backlog item. |
| D-019-8 | Canonical rate-limit metric families (snake spelling per Spec-024; labels per this plan): `rate_limit_trip_total{endpoint,tier}`, `rate_limit_backend_error_total{backend}`, `rate_limit_failclosed_total{backend}`. They are relay-side only: the daemon has no enforcer and registers no rate-limit family, so Spec-024 row 9a's daemon families carry none, and row 9b lists these. |
| D-019-9 | WS overflow = the per-device quota: a device over 6,000 frames in 60 seconds gets one in-band `rate_limited` frame (`retryAfter: 60`), then 60 seconds in which its frames are dropped with no further frame; the quota never closes the connection. The count is in the relay's memory, one per live device connection; a machine's frames are never counted. The frame is registered in api-payload-contracts §Relay Rate-Limit Signaling. |
| D-019-14 | Typed identity pair from `identityKeyFn`; canonical forms (user UUID; IPv4 exact / IPv6 /64); IP provenance = `CF-Connecting-IP` (Workers) / `X-Forwarded-For` under explicit trust-proxy (self-host relay node); missing IP on anonymous endpoint → 400. |
| D-019-15 | Metrics on the Workers relay = structured log lines carrying the same bounded counters, read in the person's own Cloudflare dashboard, since Workers has no scrape surface; self-host exposition = the relay node's `GET /metrics` on loopback; Plan-019 ships registration + emission only (injectable registry). |
| D-019-16 | `AIS_RATELIMIT_MODE={enforce\|observe}` read once at factory construction (deploy-time; no runtime kill switch). Rollout soak = 24h observe mode in production (no staging environment exists); FP-rate gate < 0.1% measured as would-be-429s issued to identities whose logged request rate never exceeded the configured limit ÷ total would-be-429s (plan-local target). Observe suppresses every rate-limit refusal: the 429, and the device quota's frame and pause. |
| D-019-17 | `RateLimitIdentityType` carries `user` and `ip`: no registry row keys on a session, since the control plane keeps no session record. The device quota needs no identity type: it is counted in the relay's memory and never stored. |

## Implementation Phase Sequence

### Phase 1 — Contracts + Doc Parity

**Goal:** land the typed contract surface and the contracts-doc parity check so every later phase builds against canonical shapes.

**Precondition:** the Spec-019 registry rows are registered. No code preconditions beyond the shipped contracts package.

#### Tasks

- [ ] **T21.1-1 — `packages/control-plane/src/rate-limit/rate-limiter.ts` and `packages/contracts/src/rate-limiter.ts`.** In the control plane's file, author `RateLimitIdentityType` (D-019-17), `RateLimitTier`, `RateLimitEndpointGroup` (registry-key union, D-019-6), `RateLimitCheckRequest`, `RateLimitCheckResponse` (union — window arm with the window fields; fail-open degraded arm: `{allowed: true, degraded: true, graceEndsAt}`, no window fields), and the `RateLimiter` interface. In contracts, author the `RateLimitResponse` wire envelope + `RateLimitResponseSchema` (Zod; both timing fields required, [Spec-019 §Overflow Response](../specs/019-rate-limiting-policy.md#overflow-response)) and the `rate_limited` frame's schema, add `ratelimit.backend_unavailable` (503) to `packages/contracts/src/error.ts`, and re-export from `packages/contracts/src/index.ts`.
  - **Spec coverage:** Spec-019 §Interfaces And Contracts (RateLimitCheck shape), Spec-019 §Deployment-Aware Abstraction (same programmatic interface both backends), Spec-019 §Implementation Notes (single RateLimiter interface), Spec-019 §Rate Limit Tiers (standard RateLimitResponse envelope)
  - **Verifies invariant:** I-019-7
  - **Consumes:** [Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) (a doc contract); zod (workspace dep).
- [ ] **T21.1-4 — api-payload-contracts.md parity verification.** Verify, field-for-field, that each shape the contracts doc carries — the `interface RateLimitResponse` (timing pair required) under §Error Responses; the `RateLimitCheckRequest` and `RateLimitCheckResponse` (window arm with the window fields; degraded arm: `{allowed: true, degraded: true, graceEndsAt}`) under §GDPR And Rate Limiting; `"ratelimit"` in the illustrative `ErrorNamespace` union; the in-band refusal frame under §Relay Rate-Limit Signaling (D-019-9) — matches the T21.1-1 typed exports, and land ONLY drift fixes. No-drift outcome = no doc edit; record the parity check in the PR description.
  - **Spec coverage:** Spec-019 §Interfaces And Contracts (api-payload-contracts holds the typed request/response schemas), Spec-019 §Rate Limit Tiers (standard envelope), Spec-019 §WebSocket Overflow Response (the refusal frame's shape)
  - **Verifies invariant:** I-019-7
  - **Consumes:** api-payload-contracts.md §Spec-019 sections; error-contracts.md §Rate Limiting envelope; T21.1-1 exports (same Phase).
- [ ] **T21.1-5 — error-contracts.md parity verification.** The §Rate Limiting table carries the enforcement-layer code `ratelimit.backend_unavailable` (503 — fail-closed after grace) beside the canonical envelope. This task verifies every code the implementation emits resolves to a registered row and lands ONLY drift fixes. No-drift outcome = no doc edit; record the parity check in the PR description.
  - **Spec coverage:** Spec-019 §Interfaces And Contracts (error-contracts holds error response schemas and error codes), Spec-019 §Fallback Behavior (503 after grace)
  - **Verifies invariant:** I-019-7 (registry side)
  - **Consumes:** error-contracts.md §Rate Limiting table.
- [ ] **T21.1-6 — Schema tests.** In `packages/contracts/src/__tests__/`, `RateLimitResponseSchema` parses the full envelope and rejects an envelope missing `retryAfter` or `resetAt`; in the control plane's rate-limit tests, the `RateLimitEndpointGroup` union matches the registry's keys.
  - **Spec coverage:** Spec-019 §Overflow Response (canonical envelope), Spec-019 §Interfaces And Contracts (check shape)
  - **Verifies invariant:** I-019-7
  - **Consumes:** T21.1-1 exports (same Phase).

### Phase 2 — Backends

**Goal:** both `RateLimiter` implementations, the per-identity Durable Object, factory, fail-open wrapper, and the parity proof (shared contract suite).

**Precondition:** Phase 1 shipped.

#### Tasks

- [ ] **T21.2-1 — `endpoint-limits.ts`.** Canonical endpoint-group → `{ limit, periodSeconds, namespaceId }` table transcribed from the Spec-019 registry; exported as the single config source for both backends, wrangler authoring, and header values. Unit test parses the repo's wrangler.toml (when present) and asserts every `[[ratelimits]]` binding's `simple = { limit, period }` + `namespace_id` matches this module (drift guard).
  - **Spec coverage:** Spec-019 §Canonical Endpoint Group Registry (registry table header — single enumeration), Spec-019 §Deployment-Aware Abstraction (identical limits)
  - **Verifies invariant:** I-019-2
  - **Consumes:** `RateLimitEndpointGroup` ← T21.1-1.
- [ ] **T21.2-4 — `identity-durable-object.ts`.** `RateLimitIdentityDO` class (per-group window storage + single-alarm scheduling per §Data And Storage Changes; RPC = `recordAllowed` eager window record-and-read + `readWindow` + `checkAndConsume` credential-route counter) + the Worker-side stub resolver (`idFromName(`${identityType}:${identity}`)`). Export the DO class from `packages/control-plane/src/server/host.ts` (export-only edit, CP-019-1 seam). DO-restart persistence test (storage survives; alarm re-arms) + full-expiry eviction test (alarm `deleteAll`s storage once every window has passed — I-019-5) + credential-route counter row (the 21st `auth.endpoint` consume from one address in 60 s refused atomically whichever location sent it, `resetAt` = window expiry).
  - **Spec coverage:** Spec-019 §Deployment-Aware Abstraction (credential routes counted once in the per-identity Durable Object), Spec-019 §State And Data Implications (counters not persisted beyond their window)
  - **Verifies invariant:** I-019-5
  - **Consumes:** Cloudflare DO runtime (`@cloudflare/workers-types` for types); wrangler DO binding + migration declaration (§Target Areas wrangler deliverable).
- [ ] **T21.2-5 — `cloudflare-rate-limiter.ts`.** `CloudflareWorkersRateLimiter implements RateLimiter`, eager-DO (D-019-3): (a) select the endpoint group's binding (D-019-4); (b) `env.<LIMITER>.limit({ key })`; (c) on `success: false`, deny with `remaining: 0` and the `resetAt` the DO's `readWindow` returns for that group; (d) on `success: true`, `recordAllowed` — fold the allowed request into the DO's per-group window and return its authoritative `remaining`/`resetAt` in the same round-trip (success-recording is what keeps the window state authoritative — eager-DO, D-019-3); (e) the credential-route groups — the rows that sign-in, token refresh and device linking resolve to, `auth.endpoint` among them (§Cloudflare bindings): skip (a)–(d) and call DO `checkAndConsume({ key, group, limit, windowSeconds })` — the Worker passes the registry threshold and the DO atomically evaluates + consumes the per-group window, refusing over-threshold with authoritative `remaining`/`resetAt`. Because the DO for an identity is one object worldwide, this is one global count, and the 10–50 ms round trip lands only on these rare routes. DO round-trip failure falls through to the fail-open wrapper semantics.
  - **Spec coverage:** Spec-019 §Deployment-Aware Abstraction (Workers = Cloudflare `rate_limit` binding; credential routes counted once in the DO, not in the per-location binding), Spec-019 AC4 (one global count on the credential routes)
  - **Verifies invariant:** I-019-2
  - **Consumes:** `RateLimiter` ← T21.1-1; `endpoint-limits.ts` ← T21.2-1; `RateLimitIdentityDO` ← T21.2-4; `[[ratelimits]]` bindings (wrangler deliverable).
- [ ] **T21.2-6 — `postgres-rate-limiter.ts`.** `PostgresRateLimiter implements RateLimiter` wrapping `RateLimiterPostgres`, one instance per endpoint group (D-019-4), `pg.Pool` constructor-injected (`storeClient` — never constructed; the self-host relay node is the production instantiator, CP-019-3), points/duration from `endpoint-limits.ts`, `keyPrefix` namespacing into `ratelimit_*` with library-managed creation. Each check consumes one point; a trip denies with `remaining: 0` and the window's `resetAt`. Add `rate-limiter-flexible: ^11.0.0` to `packages/control-plane/package.json`; contract suite asserts `semver.gte(installedVersion, '11.0.0')` (documented-pin → enforced-pin). Postgres TLS posture (`sslmode=verify-full`; refusal table per Spec-024 row 5, CVE-2024-10977 — fixed in PG 17.1/16.5/15.9/14.14/13.17/12.21) is enforced where the connection string is parsed: the self-host relay node's config loader (Spec-024 row-5 ownership). This class documents the requirement on the injected pool and the contract suite exercises a `parsePostgresConfig()` refusal-table assertion; it does not parse connection strings.
  - **Spec coverage:** Spec-019 §Deployment-Aware Abstraction (self-host = rate-limiter-flexible + Postgres), Spec-019 §Implementation Notes (sliding window), Spec-019 AC3 (identical limits, via shared suite)
  - **Verifies invariant:** I-019-2, I-019-5
  - **Consumes:** `RateLimiter` ← T21.1-1; `endpoint-limits.ts` ← T21.2-1; `rate-limiter-flexible@^11.0.0` (npm); `pg.Pool` (injected — the self-host relay node is the production provider; test provider per T21.2-9's harness note).
- [ ] **T21.2-7 — `factory.ts`.** `createRateLimiterFactory(config)` with the discriminated config (`{ kind: 'workers'; env } | { kind: 'node'; pool }`), returning `{ forEndpoint(endpoint: RateLimitEndpointGroup): RateLimiter; mode: 'enforce' | 'observe' }`. Backend resolution: `cloudflare` / `postgres`; ABSENT or unknown `AIS_RATELIMIT_BACKEND` throws at startup naming the env var (no implicit default — self-host declares via `.env`, Workers via wrangler `[vars]`). `AIS_RATELIMIT_MODE` read once here (D-019-16; absent → `enforce`). On Workers, values come from the injected `env`, never `process.env`. Table-driven tests: `cloudflare` → CF registry; `postgres` → PG registry; `undefined`/`''`/`'redis'` → throw; `observe` mode surfaces on the factory.
  - **Spec coverage:** Spec-019 §Deployment-Aware Abstraction (swap via deployment configuration), Spec-019 §Implementation Notes (configuration selects the backend at startup)
  - **Verifies invariant:** I-019-2
  - **Consumes:** T21.2-5 + T21.2-6 (same Phase).
- [ ] **T21.2-8 — `fail-open.ts`.** Grace wrapper per the fail-open rule: try/catch around `check()`; on backend error start the grace window (`AIS_RATELIMIT_FAILOPEN_SECONDS`, default 60; monotonic clock); during grace return the degraded union arm `{ allowed: true, degraded: true, graceEndsAt: <now + grace_remaining> }` (the arm carries no window fields — nothing is sentinel-fabricated) + structured warn log `{ backend, error, grace_remaining_ms }`; consumers suppress all `X-RateLimit-*` headers when `degraded` is set; after grace, throw → middleware maps to 503 `ratelimit.backend_unavailable`, increments `rate_limit_failclosed_total{backend}` (emission point lands with T21.4-1), and emits ONE structured error log at the grace-expiry transition. Grace scope = per wrapper instance (per process on self-host / per isolate on Workers) — the per-isolate deviation is ACCEPTED and recorded in §Risks. Unit rows: allow-for-grace then throw; degraded → zero headers; transition log exactly once.
  - **Spec coverage:** Spec-019 §Fallback Behavior (bounded-grace fail-open + warning log; fail-closed 503 after grace), Spec-019 §Default Behavior (degraded header suppression)
  - **Verifies invariant:** I-019-4
  - **Consumes:** `RateLimiter` ← T21.1-1; `ratelimit.backend_unavailable` ← T21.1-5.
- [ ] **T21.2-9 — `rate-limiter-contract-suite.ts` + runners.** Export `describeRateLimiterContract(makeLimiter: () => Promise<RateLimiter>)` — scenario set: under-limit allow; at-limit deny; header-source fields present + internally consistent; a denial reports the window's `resetAt` and the first check after it is allowed; window expiry re-allow; per-endpoint-group isolation. Runners: `postgres-rate-limiter.contract.test.ts` (PGlite, repo precedent — testcontainer fallback only if `rate-limiter-flexible` proves PGlite-incompatible, recorded at implementation) and `cloudflare-rate-limiter.contract.test.ts` (hand-rolled `env.<LIMITER>.limit()` fake honoring `endpoint-limits.ts` + DO-storage fake — `@cloudflare/workers-types` is types-only; fidelity caveat recorded: local emulation does not reproduce production per-edge-location counting; I-019-2 parity is asserted at the contract level, not edge-distribution level). The Cloudflare runner also runs the credential-route rows with the binding fake asserting it is never called.
  - **Spec coverage:** Spec-019 §Deployment-Aware Abstraction (identical limits — the parity proof), Spec-019 AC3
  - **Verifies invariant:** I-019-2
  - **Consumes:** all Phase-2 tasks; the self-host relay node re-runs this suite (CP-019-3).

### Phase 3 — Enforcement Wiring

**Goal:** the admission check, both transport middlewares, and the wiring of shipped procedures.

**Precondition:** Phase 2 shipped. CP-019-5 (the Workers frame seam) gates only the Workers half of T21.3-4's consumption — the middleware module itself + self-host path are not gated.

#### Tasks

- [ ] **T21.3-2 — `rate-limit/enforcement-pipeline.ts`.** `createAdmissionCheck` per §API And Transport Changes — returns `checkAdmission`: `limiter.check` for the request's endpoint, with the `onTrip` seam firing on every refusal in observe and enforce alike (T21.4-1 binds `rate_limit_trip_total{endpoint,tier}` — the D-019-16 soak input). Unit tests: an allowed check → `admitted: true` with the window state; a counter trip → `admitted: false` carrying the check the 429 envelope is built from; a degraded check → admitted; `onTrip` fires for would-be 429s with no mode dependence.
  - **Spec coverage:** Spec-019 §Overflow Response (429 + Retry-After on refusal)
  - **Verifies invariant:** I-019-1
  - **Consumes:** `RateLimiter` via factory ← T21.2-7.
- [ ] **T21.3-3 — `middleware/rate-limit.ts`.** `rateLimitProcedure` per §API And Transport Changes: typed identity pair (D-019-14), tier from auth state (D-019-4), observe-mode pass-through (D-019-16), 25%-threshold header attachment + degraded suppression, 429 with the canonical envelope. Unit tests: identity fallback chain (user → ip; missing IP on anonymous endpoint → 400); tier never caller-supplied; observe mode emits telemetry and never denies; header policy rows (remaining < 25% of limit → headers attach; remaining ≥ 25% → none; degraded → none; 429 → every header).
  - **Spec coverage:** Spec-019 §Default Behavior (threshold-approach headers, remaining < 25%), Spec-019 §Overflow Response (429; Retry-After; standard headers), Spec-019 §Rate Limit Tiers (tier from auth state)
  - **Verifies invariant:** I-019-1, I-019-7
  - **Consumes:** `checkAdmission` ← T21.3-2; the CP-019-1 mount surface ← the control-plane host (§Preconditions); `AuthenticatedIdentityContext` (`ctx.userId`) ← Plan-016.
- [ ] **T21.3-4 — `middleware/ws-rate-limit.ts`.** `wsRateLimit` per §API And Transport Changes: the device's in-memory `ws.message` quota (`DeviceFrameQuota`: a sliding 60-second count per live device connection, 6,000 frames, a 60-second pause after a trip, freed with the connection); one in-band `rate_limited` frame (shape from T21.1-4, `retryAfter: 60`) at the first refused frame of a pause and none after it; the connection is never closed for the quota; observe-mode pass-through (D-019-16; factory-provided `mode`); a machine connection's frames are never counted; single-signal outcome contract (caller performs the send). Unit tests: the 6,001st device frame in 60 s → frame outcome + connection-stays-open; the next frames in the pause → dropped with no frame; the first frame after the pause → admitted; a machine connection sending 10,000 frames → all admitted; observe mode → `{ proceed: true }` over quota with the trip still recorded; a closed connection frees its count; the hook reads only the connection's side and device id and the frame's time.
  - **Spec coverage:** Spec-019 §WebSocket Overflow Response (the device quota, its refusal frame and pause), Spec-019 §Canonical Endpoint Group Registry (ws.message registry row), Spec-019 AC5
  - **Verifies invariant:** I-019-1, I-019-5
  - **Consumes:** factory `mode` ← T21.2-7; the CP-019-5 seam ← Plan-028's relay (Workers consumption; §Preconditions); the self-host relay node (self-host consumption, CP-019-3).
- [ ] **T21.3-6 — Wire shipped procedures + the daemon's import boundary.** Apply `rateLimitProcedure` per the §Endpoint Wiring Ownership table to the shipped procedures: `health.check`, the `general.api`/`unauthenticated.request` fallback buckets, and `auth.endpoint` over the shipped auth procedures — inside the CP-019-1 mount seam (export-only host edit). Bind `wsRateLimit` into the CP-019-5 frame seam for the device quota on every frame a device sends ([`Spec-028`](../specs/028-remote-control.md)). `presence.heartbeat` is **neither** a tRPC procedure **nor** a frame the relay can tell apart — each device sends its heartbeat inside its end-to-end encrypted channel to each machine ([`Spec-028`](../specs/028-remote-control.md)), where the relay counts it as one more `ws.message` frame; the machine counts it at its 10/min row's price ([Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry)), per device, drops the excess and keeps the last heartbeat per device ([Plan-028](./028-remote-control.md); §Endpoint Wiring Ownership `presence.heartbeat` row). Add a `no-restricted-imports` entry to `eslint.config.mjs`, scoped to `packages/runtime-daemon/**`, whose patterns refuse any import of the control plane's `middleware` and `rate-limit` modules, so `rateLimitProcedure` and `wsRateLimit` cannot reach the daemon; type-only `packages/contracts` imports stay allowed. `pnpm lint` enforces it.
  - **Spec coverage:** Spec-019 AC1 (general.api), Spec-019 AC2 (auth.endpoint), Spec-019 AC6 (daemon exclusion), Spec-019 §Scope (daemon scope exclusion), Spec-019 §Canonical Endpoint Group Registry (presence.heartbeat — counted by the machine, not wired here: it rides the device's encrypted channel, which the relay cannot read)
  - **Verifies invariant:** I-019-1 (daemon-exclusion companion)
  - **Consumes:** `rateLimitProcedure` ← T21.3-3; `wsRateLimit` ← T21.3-4; the CP-019-5 seam ← Plan-028's relay; the shipped control-plane procedure surfaces; `artifact.publish` and `approval.resolve` have no wiring surface and stay dormant per the [Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) dormant-row semantics; `presence.heartbeat` is counted by the machine (Plan-028).

### Phase 4 — Observability + Rollout Verification

**Goal:** canonical telemetry registration + emission and the AC-anchored verification suite.

**Precondition:** Phase 3 shipped.

#### Tasks

- [ ] **T21.4-1 — `rate-limit/metrics.ts`.** `RateLimitMetrics` class wrapping an injected `prom-client` `Registry`; register the canonical families (D-019-8); emission map: trip → the T21.3-2 pipeline `onTrip` seam and the T21.3-4 quota trip (the quota trip carries `endpoint="ws.message"`, `tier="authenticated"`, since only a linked device holds a connection; both fire in observe + enforce — the deny paths go dark in observe and MUST NOT own this counter); failclosed → post-grace 503 path; backend_error → fail-open catch. Emission-time label-allow-list guard throws on out-of-list values (Plan-018 invariants). Add `prom-client` to `packages/control-plane/package.json`. Workers disposition: the same bounded counters written as structured log lines (D-019-15); self-host exposition = the relay node's `GET /metrics` (CP-019-3). Unit tests: each emission point increments exactly its family; out-of-allow-list label throws; total series across families < 50 (I-019-8).
  - **Spec coverage:** Spec-024 §Required Behavior (row 9b relay family set — Plan-019's counters)
  - **Verifies invariant:** I-019-8
  - **Consumes:** `onTrip` ← T21.3-2 and the quota trip ← T21.3-4; [Plan-018 §Prometheus /metrics Exposition (Spec-024 row 9)](./018-observability-and-failure-recovery.md#prometheus-metrics-exposition-spec-024-row-9) label invariants (doc contract, CP-019-4); `prom-client` (npm).
- [ ] **T21.4-3 — AC-anchored integration verification (`packages/control-plane/integration/`).** Named rows, all metric assertions via in-process registry reads (D-019-15): (1) AC1: 101st `general.api` request in 60s → 429 + every rate-limit header, `Retry-After` per formula; (2) AC2: 21st `auth.endpoint` request from one IP → 429 + `Retry-After`, and the first request after the window frees → allowed; (3) AC4: on the Cloudflare runner, 21 `auth.endpoint` requests from one address split across two simulated edge locations → the 21st refused; (4) AC5 — WS: 6,001 frames from one device in 60s → the 6,001st answered by one in-band frame, the next 60 s of that device's frames dropped with no further frame, connection alive, and the refusal reported to the machine (D-019-9); (5) grace-expiry → 503 + `rate_limit_failclosed_total` increment + one transition log; (6) per-scenario counter deltas (trip/backend_error/failclosed families).
  - **Spec coverage:** Spec-019 AC1, Spec-019 AC2, Spec-019 AC4, Spec-019 AC5, Spec-019 AC6 (via T21.3-6's lint rule), Spec-019 §Example Flows (the runaway-device example; the auth-endpoint example)
  - **Verifies invariant:** I-019-1, I-019-4
  - **Consumes:** all prior phases; the PGlite/testcontainer harness per T21.2-9.

## Parallelization Notes

- Phase 1 lands first; T21.1-1 is the root contract; T21.1-4/-5 (doc parity verification) and T21.1-6 follow it in parallel.
- Phase 2: T21.2-1 first; then T21.2-4 (the DO) and T21.2-6 (the Postgres limiter) in parallel; T21.2-5 after T21.2-4; T21.2-7/T21.2-8 after the limiters; T21.2-9 last (drives everything).
- Phase 3: T21.3-2 → T21.3-3, with T21.3-4 in parallel to both; T21.3-6 after all three.
- Phase 4: T21.4-1 → T21.4-3.

## Test And Verification Plan

The per-task test obligations live in each `#### Tasks` row above. Summary by layer:

- **Unit (`packages/control-plane/src/rate-limit/*.test.ts`, `src/middleware/*.test.ts`):** factory table rows; fail-open grace + degraded suppression + transition log; DO single-alarm re-arm, restart persistence, full-expiry eviction and the credential-route counter; pipeline `onTrip` rows; middleware identity/tier/header/observe rows; WS quota, pause and observe rows; metrics label guard + series count.
- **Contracts (`packages/contracts/src/__tests__/`):** full envelope acceptance / rejection of an envelope missing a field or half-timed (T21.1-6). The registry-key union snapshot runs with the control plane's rate-limit tests (T21.1-6).
- **Contract parity suite (`rate-limiter-contract-suite.ts`):** the I-019-2 proof, run against both backends in CI and re-run by the self-host relay node (T21.2-9; CP-019-3).
- **Integration (`packages/control-plane/integration/`):** the AC-anchored rows of T21.4-3.
- **Structural:** the daemon's import boundary is an ESLint `no-restricted-imports` rule (T21.3-6), checked by `pnpm lint`; no test parses sources for it.

## Rollout Order

1. Land Phase 1 (contracts + doc parity).
2. Land Phase 2 backends; contract suite green against both.
3. Land Phase 3 wiring (tRPC; the WS Workers half gated on CP-019-5, self-host rides the relay node).
4. Land Phase 4 telemetry + verification suite.
5. Pre-enable soak (D-019-16; no staging environment exists — ADR-023's `environment: production` is a release gate, and the host's dev-environment allow-list refuses `'staging'`): deploy with `AIS_RATELIMIT_MODE=observe` for 24h. Monitor `rate_limit_trip_total`, `rate_limit_backend_error_total`, `rate_limit_failclosed_total`. Gate: false-positive rate < 0.1%, measured as would-be-429s issued to identities whose structured-log request rate never exceeded the configured limit for that endpoint group ÷ total would-be-429s (plan-local target).
6. Flip `AIS_RATELIMIT_MODE=enforce` in production; first 24h enforced runs with the same monitoring + §Rollback levers armed.

## Rollback Or Fallback

- **False-positive storm:** set `AIS_RATELIMIT_MODE=observe` and redeploy/restart (deploy-time configuration change, not a request-time toggle — D-019-16); rate-limit enforcement stops, full telemetry continues; log retention captures which identity tripped. There is deliberately no in-band runtime kill switch (DoS footgun).
- **Backend outage:** fail-open for 60s (default grace) covers transient Postgres / DO outages. After grace, 503s surface to clients with `rate_limit_failclosed_total` visibility; clients retry with backoff per their own logic.
- **Rollback to pass-through:** the middleware can be uninstalled by removing the `.use(rateLimitProcedure(...))` on each procedure. The `RateLimiter` contract + backends remain deployed but no longer enforce. This is a code change; observe mode (above) is the operational lever.

## Risks And Blockers

- **Cloudflare `rate_limit` binding period cap.** The binding only supports 10s or 60s periods ([Cloudflare: Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)). Every registry window is 60 s, so the binding covers the per-minute rows that are not credential routes, and authoritative window state lives in the DO layer (D-019-3).
- **`rate-limiter-flexible` v11.0.0 recency.** Published 2026-04-03 ([GitHub release](https://github.com/animir/node-rate-limiter-flexible/releases/tag/v11.0.0)). Breaking changes in v11: `RLWrapperBlackAndWhite` now extends `RateLimiterCompatibleAbstract` (we do not use black/white wrappers). No breakage expected. Pinned `^11.0.0` in `packages/control-plane/package.json` with a semver floor assertion in the contract suite (T21.2-6).
- **Clock skew across CF edge locations.** The Cloudflare `rate_limit` binding is per-location per-key by design, so a highly mobile caller rotating through locations can get `L × limit` requests for `L` locations before any single location trips. On the credential routes — sign-in, token refresh and device linking, the routes worth guessing at — the counter itself is the identity's DO, one object worldwide (T21.2-5 step e), so rotation buys nothing there, at a 10–50 ms round trip those rare routes absorb. On the other rows, sub-threshold-per-location rotation is accepted residual risk.
- **Eager-DO round-trip cost.** Every Workers rate check on a binding-backed row consults the DO (authoritative `remaining`/`resetAt`). This doubles the CF rate-limit check cost (~1-5ms DO lookup added to the free binding). For the busiest binding-backed row (`general.api`, 100/min), 2ms × 100 = 200ms/min added compute per user per minute at the ceiling. Device frames never consult the DO: the device quota is counted in the relay's memory. Accepted (D-019-3 — the lazy alternative breaks header accuracy).
- **Per-isolate grace scope (Workers).** The fail-open grace window is in-memory per Workers isolate; isolate churn during a sustained backend outage re-opens grace per cold isolate, so fail-closed convergence on Workers is per-isolate, not fleet-wide. ACCEPTED; mitigant: `rate_limit_backend_error_total{backend}` + `rate_limit_failclosed_total{backend}` alerting catches the sustained-outage case; persisting grace state would require the very backend that is failing.

## Done Checklist

- [ ] The `RateLimiter` interface, its check types and `RateLimitEndpointGroup` live in `packages/control-plane/src/rate-limit/rate-limiter.ts`; `RateLimitResponse`/`RateLimitResponseSchema` and the `rate_limited` frame's schema live in `packages/contracts/src/rate-limiter.ts`, and `ratelimit.backend_unavailable` in `packages/contracts/src/error.ts`; all with the shapes defined in §API And Transport Changes.
- [ ] `CloudflareWorkersRateLimiter` + `PostgresRateLimiter` both pass the shared contract suite (`rate-limiter-contract-suite.ts`) covering every sliding-window registry row.
- [ ] `RateLimiterFactory` selects backend from `AIS_RATELIMIT_BACKEND`; throws on unknown OR absent value at startup; reads `AIS_RATELIMIT_MODE` once at construction.
- [ ] `RateLimitIdentityDO` is exported from the Worker entry module, declared in wrangler `[[durable_objects.bindings]]` + `[[migrations]]`, holds the per-group windows with single-alarm scheduling and full-expiry `deleteAll` self-eviction (I-019-5), and counts the credential-route groups once worldwide (Spec-019 AC4).
- [ ] Every enforced transport admits through one stage (I-019-1): tRPC procedures and raw routes through `checkAdmission`, device frames through the device quota.
- [ ] `rateLimitProcedure` is wired on every endpoint group the §Endpoint Wiring Ownership table assigns to this plan; the dormant rows are covered by the dormant-row item below.
- [ ] WS per-frame admission implements the device quota: one in-band `rate_limited` frame when a device passes 6,000 frames in 60 s, then a 60-second pause with no further frame; the connection is never closed for the quota; a machine connection is never counted; Workers consumption via CP-019-5, self-host via the relay node.
- [ ] Fail-open grace is configurable via `AIS_RATELIMIT_FAILOPEN_SECONDS` (default 60); degraded responses carry `degraded: true` and zero `X-RateLimit-*` headers; post-grace returns 503 `ratelimit.backend_unavailable` with `rate_limit_failclosed_total` + one transition log.
- [ ] 429s include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` computed as `max(0, ceil((resetAt - now) / 1000))`; allowed responses attach headers only when `remaining < 25%` of the limit.
- [ ] api-payload-contracts.md parity verified against the typed exports (`RateLimitResponse`, timing pair required; `RateLimitCheckRequest`; `RateLimitCheckResponse` (window arm + `limit`; degraded arm `graceEndsAt`); `ErrorNamespace` + `ratelimit`; the §Relay Rate-Limit Signaling frame; T21.1-4 lands only drift fixes).
- [ ] Error code `ratelimit.backend_unavailable` (503) is registered in error-contracts.md and every code the implementation emits resolves to a registered row (T21.1-5).
- [ ] Canonical metric families `rate_limit_trip_total{endpoint,tier}`, `rate_limit_backend_error_total{backend}`, `rate_limit_failclosed_total{backend}` are registered + emitted with the label guard (series < 50); self-host exposition rides the relay node; the Workers relay writes them as structured log lines (D-019-15).
- [ ] Local daemon IPC path is NOT rate-limited — enforced by the daemon's `no-restricted-imports` lint rule, not by review.
- [ ] The dormant registry rows are not wired and no surface has armed them — `approval.resolve` gated on the two conditions that could make it network-reachable (the local daemon reachable over the network; an answer leaving the owning machine's daemon for a surface the control plane or the relay can read), **`artifact.publish` on a network-reachable publication surface** ([Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) dormant-row semantics).
- [ ] Postgres TLS posture documented on the injected pool: `sslmode=verify-full` enforced at the relay node's config-parse locus per [Spec-024 row 5](../specs/024-self-host-secure-defaults.md#required-behavior) ([CVE-2024-10977](https://www.postgresql.org/support/security/CVE-2024-10977/), fixed in PG 17.1/16.5/15.9/14.14/13.17/12.21); the contract suite exercises the refusal-table assertion.

## Dependencies

Strictly **downstream of the control-plane host** for the CP-019-1 tRPC mount, and downstream of [Plan-028](./028-remote-control.md)'s relay for the CP-019-5 frame seam, and **upstream of the self-host relay node** (which instantiates `PostgresRateLimiter` + `createAdmissionCheck` + `wsRateLimit` inside its compose-deployed process, CP-019-3). Additionally, it registers its metric families against Plan-018's §Prometheus /metrics Exposition contract (doc-contract compliance only, no code consumed; CP-019-4) with self-host exposition mounted on the relay node. Plan-019's place in the build order is the dispatch group [cross-plan-dependencies §Dispatch groups](../architecture/cross-plan-dependencies.md#dispatch-groups) lists it in.

## References

- [Spec-019: Rate Limiting Policy](../specs/019-rate-limiting-policy.md)
- [ADR-014: tRPC Control-Plane API](../decisions/014-trpc-control-plane-api.md)
- [ADR-020: V1 Deployment Model And OSS License](../decisions/020-v1-deployment-model-and-oss-license.md)
- [ADR-010: Tokens, Passkeys And The Remote Channel](../decisions/010-tokens-passkeys-and-the-remote-channel.md)
- [Plan-018: Observability And Failure Recovery](./018-observability-and-failure-recovery.md) (metrics contract)
- [Spec-024: Self-Host Secure Defaults](../specs/024-self-host-secure-defaults.md) (rows 5, 9)
- [Deployment Topology §Rate Limiting By Deployment](../architecture/deployment-topology.md#rate-limiting-by-deployment)
- [Cloudflare Workers: Rate Limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Cloudflare Durable Objects: Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [rate-limiter-flexible v11.0.0 release](https://github.com/animir/node-rate-limiter-flexible/releases/tag/v11.0.0)
- [tRPC v11 middlewares](https://trpc.io/docs/server/middlewares)
- [PostgreSQL CVE-2024-10977](https://www.postgresql.org/support/security/CVE-2024-10977/)
