# Plan-018: Rate Limiting Policy

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `018` |
| **Slug** | `rate-limiting-policy` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude Opus 4.7` |
| **Spec** | [Spec-019: Rate Limiting Policy](../specs/019-rate-limiting-policy.md) |
| **Required ADRs** | [ADR-013: Control Plane API](../decisions/013-control-plane-api.md); [ADR-019: V1 Deployment Model And OSS License](../decisions/019-v1-deployment-model-and-oss-license.md); [ADR-014: V1 Feature Scope Definition](../decisions/014-v1-feature-scope-definition.md); [ADR-010: Tokens, Passkeys And The Remote Channel](../decisions/010-tokens-passkeys-and-the-remote-channel.md) |
| **Dependencies** | the control-plane host (the stable `axum` router the middleware layers onto; `wrangler.jsonc` deployment config extended); the sign-in, token-refresh and device-linking routes the middleware wraps ([Plan-015](./015-hosted-account-and-identity.md), [Plan-025](./025-remote-control.md) Phase 5). Non-blocking context, not dependencies: Plan-005 daemon-IPC scope exclusion (§Non-Goals); Plan-025's Compose relay, `sidekicks-control-plane`'s native program, as a downstream consumer (see §Cross-Plan Obligations) |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |

## Goal

Ship Spec-019's count on the person's own relay — the Workers relay in their own Cloudflare account, or the self-hosted relay: the sign-in routes (sign-in, token refresh and device linking) counted per source address, on the Workers relay in a per-identity Durable Object that counts each address once worldwide and on the self-hosted relay in the relay program's memory, behind a single `RateLimiter` contract and one admission check both transports call. An over-limit request is answered with 429 and `Retry-After`. Both deployments enforce the same limit with the same headers and the same refusal body.

## Scope

- `RateLimiter` contract owned by this plan at `crates/sidekicks-control-plane/src/rate_limit/limiter.rs`, with the typed `RateLimitEndpointGroup` key enum derived from the [Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) and the check request/response types: only the relay's control plane checks a limit, and the daemon never does. The wire devices read lives in `crates/sidekicks-contracts/src/rate_limiter.rs`: the canonical `RateLimitResponse` body (D-018-3) as a serde type, its generated TypeScript type and Ajv check at `packages/contracts/src/rate-limiter.ts`.
- The `RateLimiter` implementations:
  - `CloudflareWorkersRateLimiter` — the per-identity `RateLimitIdentityDurableObject` is the counter: one atomic check-and-consume per request, one global count per source address (D-018-1).
  - `InMemoryRateLimiter` — the self-hosted relay's counter, a sliding window per source address in the relay program's memory (D-018-2).
- `RateLimiterFactory` — selects the implementation from the deployment's configuration (T18.2-5).
- One admission stage (D-018-1): `check_admission` runs `RateLimiter::check`, whose sliding-window counter is the only stage; a trip is a 429 with the window's `Retry-After`, and a counter error fails that one request like any backend error. Every rate-limited route calls only `check_admission`. The relay's channel carries no rate limit: it forwards each device's frames as fast as the machine drains them, and backpressure on the channel bounds both directions.
- The `axum` middleware `rate_limit_layer(endpoint)` wired per the §Endpoint Wiring Ownership table (D-018-3).
- `Retry-After` on every 429 ([Spec-019 §Overflow Response](../specs/019-rate-limiting-policy.md#overflow-response)); an allowed response carries no rate-limit header.

## Non-Goals

- **Local daemon IPC rate limiting.** [Spec-019 §Scope](../specs/019-rate-limiting-policy.md#scope) explicitly excludes the daemon path (trusted by socket reachability). This plan consumes that exclusion; no IPC-side middleware is authored, and Cargo's dependency graph holds it: `sidekicks-daemon` does not depend on `sidekicks-control-plane` (T18.3-3).
- **A count on any other route.** A route a credential reaches is called only by the person's own machines and devices, each authenticating as the person ([Spec-019 §Non-Goals](../specs/019-rate-limiting-policy.md#non-goals)), so the middleware wraps the sign-in routes and nothing else.
- **Per-model / per-provider token-level throttling.** Out of [Spec-019 §Non-Goals](../specs/019-rate-limiting-policy.md#non-goals).
- **Billing metering.** Nothing is billed: the relay serves its one owner.
- **Admin credentials for more than one person, and a service principal.** The relay has one owner, and this plan adds no admin surface.
- **Custom rate-limit algorithms beyond sliding window.** Fixed-window and token-bucket are not implemented; [Spec-019 §Implementation Notes](../specs/019-rate-limiting-policy.md#implementation-notes) prefers sliding windows.
- **Bans and automatic escalation.** A limit refuses only for its own window: no identity is blocked beyond it, and nothing is banned. A stolen device's token is answered by revoking that device through Remote Control's own control ([Spec-027](../specs/027-remote-control.md)); the relay holds, for each machine, one live connection per device key and flags a key that keeps displacing itself there.

## Preconditions

The plan builds on:

- The control plane's stable router (the router host, and [Plan-015](./015-hosted-account-and-identity.md) T6.6's signed-in procedure) that `rate_limit_layer` layers onto (CP-018-1).

## Target Areas

- `crates/sidekicks-contracts/src/rate_limiter.rs` — **created by this plan.** The wire devices read: the `RateLimitResponse` 429 body as a serde type, and the two codes a sign-in route refuses with, `relay.rateLimited` and `relay.sourceAddressUnresolvable` (the 400 of §Identity resolution). Its generated TypeScript type and Ajv check sit at `packages/contracts/src/rate-limiter.ts`.
- `crates/sidekicks-control-plane/src/rate_limit/` — **created by this plan.**
  - `limiter.rs` — `RateLimitEndpointGroup`, `RateLimitCheckRequest`/`RateLimitCheckResponse` and the `RateLimiter` trait; the Worker and the Compose relay, `sidekicks-control-plane`'s native program, are their only users.
  - `endpoint_groups.rs` — canonical endpoint-group → `{ limit, period_seconds }` table transcribed from the Spec-019 registry — the one source of the limit for both implementations (T18.2-1).
  - `cloudflare_limiter.rs` — the Workers implementation over the per-identity Durable Object (D-018-1), with the Worker-side stub resolver. It and the Durable Object compile only for the Worker target (`wasm32`), where `worker` is a dependency; the Compose relay's native target never links them.
  - `identity_durable_object.rs` — the `RateLimitIdentityDurableObject` type (Workers only).
  - `in_memory_limiter.rs` — `InMemoryRateLimiter`, the self-hosted relay's in-memory counter (T18.2-4).
  - `factory.rs` — the implementation selector.
  - `enforcement_pipeline.rs` — `create_admission_check`, which returns `check_admission` (D-018-1).
- `crates/sidekicks-control-plane/tests/fixtures/rate_limiter_scenarios.json` — **created by this plan:** the one JSON scenario table of the I-018-2 parity proof, read by the Rust test against the in-memory counter and by the Workers test against the real Durable Object (T18.2-6).
- `crates/sidekicks-control-plane/src/middleware/rate_limit.rs` — **created by this plan.** The `axum` middleware `rate_limit_layer`.
- `crates/sidekicks-control-plane/src/server/router.rs` — **extended by this plan:** the router's shared state carries `check_admission`, and each host's entry puts the caller's `SourceAddress` in the request's extensions as the deployment's edge reports it. `ControlPlaneRefusal` answers [ADR-013](../decisions/013-control-plane-api.md)'s refusal body, `{code, category, message}` with the code's own fields beside them, so a 429's body is the `RateLimitResponse`. An internal failure answers 500 with the fixed message `Unexpected internal error`, the wording of error-contracts.md's `system.internalError`, so a caller never reads the relay's own error text; request paths hold no panicking call, since a panic in the Worker answers 500 and resets the instance.
- `crates/sidekicks-control-plane/src/worker.rs` — **created by this plan:** the Worker entry module, `#[event(fetch)]`, which calls the router through `tower-service` (`router().call(request)`), and the home of the `#[durable_object]` `RateLimitIdentityDurableObject` the deployed script exports. `wrangler.jsonc`'s `main` names the shim `worker-build` writes for it.
- `crates/sidekicks-control-plane/src/server/host.rs` — **extended by this plan, inside the CP-018-1 stable-mount seam:** `ControlPlaneEnv` gains the `RATE_LIMIT_IDENTITY` binding; the Worker's entry supplies `SourceAddress` from `CF-Connecting-IP` and `check_admission` over the `Workers` factory; an internal failure, such as a counter error, is logged and the caller reads only a 500. No route is wired here; T18.3-3 does that.
- `docs/architecture/contracts/api-payload-contracts.md` — carries the `RateLimitResponse` (symbol anchor: `interface RateLimitResponse` under §Error Responses), and the `RateLimitCheckRequest` and `RateLimitCheckResponse`. T18.1-2 verifies shape parity against the typed exports at implementation time and lands only drift fixes.
- `docs/architecture/contracts/error-contracts.md` — carries the canonical body under §Rate Limiting. T18.1-3 verifies code-table parity at implementation time and lands only drift fixes.
- `docs/architecture/deployment-topology.md` §Rate Limiting By Deployment — the Workers relay counts in the per-identity Durable Object, the self-hosted relay in its program's memory (D-018-1, D-018-2).
- `wrangler.jsonc` (Workers, the Worker `sidekicks-control-plane`, production `sidekicks-control-plane-production`; extended at Phase-2 landing) — `main` names the `worker-build` shim; declare (a) under `durable_objects.bindings` `{ "name": "RATE_LIMIT_IDENTITY", "class_name": "RateLimitIdentityDurableObject" }`, again under `env.production` since an environment inherits no Durable Object binding, and (b) a `migrations` entry adding `RateLimitIdentityDurableObject` to `new_sqlite_classes`.

## Data And Storage Changes

This plan owns no table: every piece of rate-limit state is ephemeral and bounded by its window (I-018-3). Erasure needs no step here — the per-identity DO deletes its own storage once its windows pass, and the self-hosted relay's counts live only in its program's memory, each dropped once its window has passed.

### Durable Object: `RateLimitIdentityDurableObject` (Workers only)

- One DO instance per source address, keyed by `id_from_name` of the address in its canonical form (D-018-4).
- Persisted state (survives worker restart) in the object's own SQLite table, one row per counted request with typed columns (the endpoint group, `at`, and that group's window length, so the alarm prunes without the endpoint-group registry) — the counter of record, which gives the authoritative `remaining`/`reset_at` (D-018-1). Each check runs, in order and synchronously through `sql.exec`: `DELETE` the expired rows, `SELECT COUNT(*), MIN(at)` for the group, refuse or `INSERT`, then `set_alarm`.
- **Single-alarm scheduling:** Cloudflare permits one scheduled alarm per object and `set_alarm` overrides. On every state change, re-arm with `ScheduledTime::new(js_sys::Date)` to the earliest per-group window expiry, where a group's window expires one full window after its newest counted request, so an idle address costs one alarm wake rather than one per request. `alarm()` deletes expired rows and re-arms if live rows remain; once every window has expired it calls `delete_all()` (no per-identity residue survives) and the DO idles out with no alarm. Every registry window is 60 seconds, so an address's state is gone within a minute of its last request.
- Request surface = `check_and_consume`, the atomic per-group check and consume, a JSON request through the stub's `fetch_with_request`, the caller bounding its wait: it refuses over-threshold and returns the authoritative `remaining`/`reset_at` in the same round trip. A refused request is not recorded, so a caller that keeps knocking never pushes its own window later. The Worker-side stub resolver lives in `cloudflare_limiter.rs` (§Target Areas).

### `RateLimitResponse` canonical shape

The 429 body has one shape, the same in error-contracts.md §Rate Limiting and api-payload-contracts.md §Error Responses:

```rust
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RateLimitResponse {
    pub code: RateLimitedCode, // always "relay.rateLimited"
    pub category: RateLimitedCategory, // always "resourceExhausted"
    pub message: String,
    pub retry_after: u32, // seconds until retry is allowed
    pub limit: u32, // total allowed requests in the window
    pub remaining: u32, // requests remaining in the current window
    pub reset_at: String, // ISO 8601 instant when the limit resets
}
```

Code-level home: `crates/sidekicks-contracts/src/rate_limiter.rs`, which T18.1-1 creates, so its consumers assert against a typed export instead of a doc shape; devices read the generated TypeScript at `@ai-sidekicks/contracts/rate-limiter`. The api-payload-contracts.md shape is anchored by symbol (`interface RateLimitResponse` under §Error Responses); T18.1-2 verifies doc-vs-export parity at implementation time. Every refusal carries both timing fields, so the type holds both as required, non-`Option` fields (T18.1-4).

## API And Transport Changes

### `RateLimiter` contract (new, owned by this plan)

```rust
// crates/sidekicks-control-plane/src/rate_limit/limiter.rs
// One variant per Key of Spec-019 §Canonical Endpoint Group Registry (D-018-3).
pub enum RateLimitEndpointGroup {
    AuthEndpoint, // "auth.endpoint"
}

pub struct RateLimitCheckRequest {
    pub identity: String, // the caller's source address, canonical form per §Identity Resolution
    pub endpoint: RateLimitEndpointGroup,
}

pub struct RateLimitCheckResponse {
    pub allowed: bool,
    pub remaining: u32,
    pub reset_at: String, // ISO 8601
    pub limit: u32, // total threshold for this window
}

pub trait RateLimiter {
    async fn check(
        &self,
        request: &RateLimitCheckRequest,
    ) -> Result<RateLimitCheckResponse, RateLimiterError>;
}
```

- `RateLimiter` and its check types live in the control plane's crate: only the relay's control plane checks a limit, on the Worker and in the Compose relay's native program, and the daemon never does ([Spec-019 §Scope](../specs/019-rate-limiting-policy.md#scope)). The `RateLimitResponse` body, which devices read, lives in `crates/sidekicks-contracts/src/rate_limiter.rs` as a serde type per the `runtime_node/registration.rs` wire-shape convention.

### Admission pipeline (D-018-1)

```rust
// crates/sidekicks-control-plane/src/rate_limit/enforcement_pipeline.rs
pub struct AdmissionResult {
    pub admitted: bool, // false = a counter trip: 429 with the body and headers built from `check`
    pub check: RateLimitCheckResponse,
}

// what the middleware and every rate-limited route consume as `check_admission`
pub fn create_admission_check(factory: RateLimiterFactory) -> AdmissionCheck;
```

One stage on every enforced transport (I-018-1): every rate-limited route calls `check_admission`, whose only stage is the sliding-window counter inside `RateLimiter::check`; the relay's channel carries no rate limit. An error from `RateLimiter::check` propagates and fails that one request like any backend error.

### Identity resolution (D-018-4, D-018-5)

- **The source address is the identity.** The check keys on the caller's source address alone (D-018-5).
- **Canonical form (D-018-4):** IPv4 exact dotted-quad / IPv6 normalized to its /64 prefix (lowercase, compressed); an IPv4-mapped IPv6 address counts as its IPv4 address. The parse is `std::net`'s `IpAddr`, whose IPv6 text is the RFC 5952 compressed form and whose `to_ipv4_mapped` folds a mapped address: it needs no dependency and runs alike on the Worker's `wasm32` build and the Compose relay's native one, where a hand-written parser would be code the project keeps forever.
- **Client IP provenance.** Workers: the Cloudflare-set `CF-Connecting-IP` header. Compose relay: the rightmost `X-Forwarded-For` entry, read only from a request whose connection comes from the configured Caddy address (Caddy appends the address it saw). Each host puts the address it trusts in the request's `SourceAddress`; the middleware canonicalizes it. A request with no resolvable address is refused 400 with `relay.sourceAddressUnresolvable`, before anything is counted, rather than rate-limited into a shared bucket.

### The `axum` middleware (layered onto the control-plane router per CP-018-1)

```rust
// crates/sidekicks-control-plane/src/middleware/rate_limit.rs
async fn rate_limit(
    State(gate): State<RateLimitGate>, // the endpoint group and `check_admission`
    request: Request,
    next: Next,
) -> Result<Response, ControlPlaneRefusal> {
    let identity = canonical_identity_of(request.extensions().get::<SourceAddress>()) // D-018-4
        .ok_or_else(ControlPlaneRefusal::source_address_unresolvable)?; // 400
    let check_request = RateLimitCheckRequest { identity, endpoint: gate.endpoint };
    let admission = (gate.check_admission)(check_request).await?;
    if !admission.admitted {
        // the one retry_after, also sent as `Retry-After`
        return Err(ControlPlaneRefusal::rate_limited(&admission.check, now()));
    }
    Ok(next.run(request).await) // an allowed response carries no rate-limit header
}
```

- Usage on a route: `.route_layer(rate_limit_layer(RateLimitEndpointGroup::AuthEndpoint))`, where `rate_limit_layer` is `axum::middleware::from_fn_with_state` over `rate_limit` ([axum middleware](https://docs.rs/axum/latest/axum/middleware/index.html)). The clock is read through `time` with its `wasm-bindgen` feature on the Worker, never `std::time::SystemTime::now`, which panics on `wasm32-unknown-unknown`.
- Header policy: `Retry-After` on every 429, and none on an allowed response.
- The 429 body: `ControlPlaneRefusal` (in `server/router.rs`) answers [ADR-013](../decisions/013-control-plane-api.md)'s refusal body, `{code, category, message}` with the code's own fields beside them, so a 429 answers the `RateLimitResponse` (`{code: "relay.rateLimited", category: "resourceExhausted", message, retryAfter, limit, remaining, resetAt}`) and the 400 answers `{code: "relay.sourceAddressUnresolvable", category: "invalidArgument", message}`. The refusal sets the status and, on a 429, the `Retry-After` header on its own response.

### Retry-After on 429 responses

A 429 response must set:

- `Retry-After: <seconds>` — formula: `max(0, ceil((reset_at - now) / 1000))`. On both implementations `reset_at` is "the time the oldest counted request ages out of the window" (the oldest in-window hit's timestamp plus the window duration), read from the DO's SQLite rows on the Workers relay (D-018-1).

## Invariants

| ID | Invariant | Verified by |
| --- | --- | --- |
| I-018-1 | Every enforced transport admits through one stage: every rate-limited route through `check_admission`, whose only stage is the sliding-window counter. The daemon IPC path is reachable by no admission stage. | T18.3-1 pipeline unit tests; Cargo's dependency graph: `sidekicks-daemon` does not depend on `sidekicks-control-plane` (T18.3-3). |
| I-018-2 | Both `RateLimiter` implementations enforce the same limit and expose identical `check` semantics; selection is configuration-only. | The one JSON scenario table (T18.2-6), read by the Rust test against the in-memory counter and by the Workers test against the real Durable Object, both green in CI. |
| I-018-3 | Rate-limit state is ephemeral and bounded by its window: sliding-window counters live in the per-identity DO's SQLite rows or in the self-hosted relay's program memory; no table this plan owns holds rate-limit state. | DO restart-persistence and full-expiry eviction tests (T18.2-2); the in-memory counter's window-expiry test (T18.2-4). |
| I-018-4 | The check request/response and the 429 `RateLimitResponse` body have exactly one canonical shape — identical in [Spec-019 §Interfaces And Contracts](../specs/019-rate-limiting-policy.md#interfaces-and-contracts), error-contracts.md, api-payload-contracts.md, and code: the check shapes in `crates/sidekicks-control-plane/src/rate_limit/limiter.rs`, the body in `crates/sidekicks-contracts/src/rate_limiter.rs`. | T18.1-2/T18.1-3 parity verification at implementation; T18.1-4 decode test (the full body decodes; every field is required, non-`Option`); cross-doc drift checked at review. |

## Cross-Plan Obligations

| ID | Direction | Counterparty | Obligation | Anchor |
| --- | --- | --- | --- | --- |
| CP-018-1 | consumes ← | the control-plane host | The stable router that `rate_limit_layer` layers onto; the host authors no rate-limit **middleware** task — `rate_limit_layer` authorship stays here. This plan adds the Durable Object to the Worker entry module, `src/worker.rs`, and supplies inside the same seam the state and request extensions the middleware reads (§Target Areas). | [Plan-018 §Target Areas](#target-areas) |
| CP-018-2 | provides → | [Plan-025](./025-remote-control.md)'s Compose relay, `sidekicks-control-plane`'s native program | `RateLimiter` contract + the in-memory implementation + `create_admission_check`, instantiated not re-implemented, in the same crate's native target; the scenario table's Rust test runs against that in-memory counter. | [Plan-025 §Phase 3 — The relay and the channel](./025-remote-control.md#phase-3--the-relay-and-the-channel) |

### Endpoint wiring ownership (D-018-3)

`rate_limit_layer` is NOT applied by iterating the spec registry; ownership is explicit:

| Endpoint group (canonical key) | Route owner | Wiring owner + mechanism |
| --- | --- | --- |
| `auth.endpoint` | the OAuth sign-in routes `/oauth/par`, `/oauth/authorize` with its sign-in page's `Create an account` arm, `/oauth/token` (the code's redemption and the refresh-token trade) and `/oauth/revoke`, and the four WebAuthn ceremony routes (`WebAuthnRegistrationOptionsIssue`, `WebAuthnRegistrationVerify`, `WebAuthnAuthenticationOptionsIssue`, `WebAuthnAuthenticationVerify`) ([Plan-015](./015-hosted-account-and-identity.md)), and the device-linking routes ([Plan-025](./025-remote-control.md) Phase 5) | Plan-018 T18.3-3 |

## Design Decisions

| ID | Decision |
| --- | --- |
| D-018-1 | On the Workers relay the per-identity `RateLimitIdentityDurableObject` is the counter: one atomic check-and-consume per request, one global count per source address, and the window the headers report (`remaining`/`reset_at`). The 10–50 ms DO round trip lands only on the sign-in routes, which see a handful of requests per device per day. `check_admission` wraps `RateLimiter::check` on both implementations. |
| D-018-2 | The self-hosted relay is one program, so it counts in that program's memory: one sliding window per source address, dropped once its window has passed. |
| D-018-3 | [Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) is the single limit enumeration with canonical keys; the §Endpoint Wiring Ownership table assigns its row. |
| D-018-4 | Canonical source address (IPv4 exact / IPv6 /64); IP provenance = `CF-Connecting-IP` (Workers) / the rightmost `X-Forwarded-For` entry, read only from the configured Caddy address (Compose relay); missing address → 400. |
| D-018-5 | The check keys on the caller's source address alone: the sign-in routes are reached before the caller holds a credential. |

## Implementation Phase Sequence

### Phase 1 — Contracts + Doc Parity

**Goal:** land the typed contract surface and the contracts-doc parity check so every later phase builds against canonical shapes.

**Precondition:** none.

The phase builds on the contracts crate (Plan-001 Phase 1 T1.2).

#### Tasks

- **T18.1-1 — `crates/sidekicks-control-plane/src/rate_limit/limiter.rs` and `crates/sidekicks-contracts/src/rate_limiter.rs`.** In the control plane's file, author `RateLimitEndpointGroup` (registry-key enum, D-018-3), `RateLimitCheckRequest`, `RateLimitCheckResponse` and the `RateLimiter` trait. In contracts, author the `RateLimitResponse` wire body as a serde type (both timing fields required, [Spec-019 §Overflow Response](../specs/019-rate-limiting-policy.md#overflow-response)); its generated TypeScript is reached at its own subpath, `@ai-sidekicks/contracts/rate-limiter`, with nothing to re-export.
  - **Spec coverage:** Spec-019 §Interfaces And Contracts (RateLimitCheck shape), Spec-019 §Deployment-Aware Abstraction (same programmatic interface in both deployments), Spec-019 §Implementation Notes (single RateLimiter interface), Spec-019 §Overflow Response (standard RateLimitResponse body)
  - **Verifies invariant:** I-018-4
  - **Consumes:** [Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) (a doc contract); `serde` (workspace dependency).
- **T18.1-2 — api-payload-contracts.md parity verification.** Verify, field-for-field, that each shape the contracts doc carries — the `interface RateLimitResponse` (timing pair required) under §Error Responses; the `RateLimitCheckRequest` and `RateLimitCheckResponse` — matches the T18.1-1 typed exports, and land ONLY drift fixes. No-drift outcome = no doc edit; record the parity check in the PR description.
  - **Spec coverage:** Spec-019 §Interfaces And Contracts (api-payload-contracts holds the typed request/response schemas), Spec-019 §Overflow Response (standard body)
  - **Verifies invariant:** I-018-4
  - **Consumes:** api-payload-contracts.md's rate-limit shapes; error-contracts.md §Rate Limiting body; T18.1-1 exports (same Phase).
- **T18.1-3 — error-contracts.md parity verification.** The §Rate Limiting table carries the canonical body. This task verifies every code the implementation emits resolves to a registered row and lands ONLY drift fixes. No-drift outcome = no doc edit; record the parity check in the PR description.
  - **Spec coverage:** Spec-019 §Interfaces And Contracts (error-contracts holds error response schemas and error codes)
  - **Verifies invariant:** I-018-4 (registry side)
  - **Consumes:** error-contracts.md §Rate Limiting table.
- **T18.1-4 — Decode test.** A unit test in `crates/sidekicks-contracts/src/rate_limiter.rs` decodes the full body; `retryAfter` and `resetAt` are required, non-`Option` fields. The `RateLimitEndpointGroup` enum matching the registry's keys is held by the compiler, not a test: `endpoint_groups.rs` maps it with one exhaustive `match`, so `rustc` refuses a key with no limit, and a limit for no key has no variant to name.
  - **Spec coverage:** Spec-019 §Overflow Response (canonical body), Spec-019 §Interfaces And Contracts (check shape)
  - **Verifies invariant:** I-018-4
  - **Consumes:** T18.1-1 exports (same Phase).

### Phase 2 — Backends

**Goal:** both `RateLimiter` implementations, the per-identity Durable Object, the factory, and the parity proof (one scenario table).

**Precondition:** Phase 1 shipped.

#### Tasks

- **T18.2-1 — `endpoint_groups.rs`.** Canonical endpoint-group → `{ limit, period_seconds }` table transcribed from the Spec-019 registry; the single config source for both implementations and for header values.
  - **Spec coverage:** Spec-019 §Canonical Endpoint Group Registry (registry table header — single enumeration), Spec-019 §Deployment-Aware Abstraction (the same limit)
  - **Verifies invariant:** I-018-2
  - **Consumes:** `RateLimitEndpointGroup` ← T18.1-1.
- **T18.2-2 — `identity_durable_object.rs`.** `RateLimitIdentityDurableObject`, a `#[durable_object]` type (its SQLite table + single-alarm scheduling per §Data And Storage Changes; request = `check_and_consume`) + the Worker-side stub resolver (`id_from_name` of the canonical source address), declared in the Worker entry module, `crates/sidekicks-control-plane/src/worker.rs`. Its tests stay TypeScript under `@cloudflare/vitest-plugin` against the Rust build: DO-restart persistence test (rows survive; alarm re-arms) + full-expiry eviction test (alarm `delete_all()`s storage once every window has passed — I-018-3) + counter row (the 21st `auth.endpoint` consume from one address in 60 s refused atomically whichever location sent it, `resetAt` = window expiry).
  - **Spec coverage:** Spec-019 §Deployment-Aware Abstraction (sign-in routes counted once in the per-identity Durable Object), Spec-019 §State And Data Implications (counters not persisted beyond their window)
  - **Verifies invariant:** I-018-3
  - **Consumes:** Cloudflare DO runtime through `worker` 0.8.7; wrangler DO binding + migration declaration (§Target Areas wrangler deliverable).
- **T18.2-3 — `cloudflare_limiter.rs`.** `CloudflareWorkersRateLimiter`, a `RateLimiter` (D-018-1): send the address's DO `check_and_consume { group, limit, window_seconds }` — the Worker passes the registry threshold and the DO atomically evaluates and consumes the group's window, refusing over-threshold with authoritative `remaining`/`reset_at`. Because the DO for an address is one object worldwide, this is one global count. A DO round-trip failure, or no answer within the caller's bound, is returned as an error from `check`, so it fails that one request.
  - **Spec coverage:** Spec-019 §Deployment-Aware Abstraction (Workers = the per-identity Durable Object), Spec-019 §Fallback Behavior (a counter error fails that one request), Spec-019 §Acceptance Criteria (one global count on the sign-in routes)
  - **Verifies invariant:** I-018-2
  - **Consumes:** `RateLimiter` ← T18.1-1; `endpoint_groups.rs` ← T18.2-1; `RateLimitIdentityDurableObject` ← T18.2-2.
- **T18.2-4 — `InMemoryRateLimiter`.** The self-hosted relay's implementation of `RateLimiter` for the Compose relay's one program (D-018-2): one sliding window per source address in memory, its limit and period from `endpoint_groups.rs`. Each check consumes one; a trip denies with `remaining: 0` and the window's `reset_at`; an address's window is dropped once it has passed. The Compose relay, `sidekicks-control-plane`'s native program, is its production instantiator (CP-018-2). Its tests: the window-expiry row (an address's state is gone once its window has passed — I-018-3).
  - **Spec coverage:** Spec-019 §Deployment-Aware Abstraction (the self-hosted relay counts in its program's memory), Spec-019 §Implementation Notes (sliding window), Spec-019 §Acceptance Criteria (the same limit, via the shared scenario table)
  - **Verifies invariant:** I-018-2, I-018-3
  - **Consumes:** `RateLimiter` ← T18.1-1; `endpoint_groups.rs` ← T18.2-1.
- **T18.2-5 — `factory.rs`.** `RateLimiterFactory::new(config)` with the config enum (`Workers { env } | Compose`), whose `for_endpoint(endpoint: RateLimitEndpointGroup)` returns the `RateLimiter` for that group: `Workers` → `CloudflareWorkersRateLimiter` over the injected `env`, never a process environment; `Compose` → one `InMemoryRateLimiter` held for the factory's lifetime and returned on every call, since the admission check asks the factory per request and the Compose relay builds one factory at startup. Test: a behavior row, not a check of which type came back — 21 checks for one address, each through its own `for_endpoint` call on one `Compose` factory, refuse the 21st. The `Workers` kind's one global count is proven by T18.4-1 row (2).
  - **Spec coverage:** Spec-019 §Deployment-Aware Abstraction (swap via deployment configuration), Spec-019 §Implementation Notes (configuration selects the implementation at startup)
  - **Verifies invariant:** I-018-2
  - **Consumes:** T18.2-3 + T18.2-4 (same Phase).
- **T18.2-6 — The scenario table + runners.** `tests/fixtures/rate_limiter_scenarios.json` holds the one scenario set: under-limit allow; at-limit deny; header-source fields present + internally consistent; a denial reports the window's `resetAt` and a check at exactly that instant is allowed, one a millisecond earlier refused; window expiry re-allow after refusals inside the window (a refusal is never recorded); per-address isolation. Runners: a Rust test in `crates/sidekicks-control-plane/tests/it/` against the in-memory counter, its clock injected, and a test in the Workers project T18.4-1 adds (`cloudflare-limiter.workers.test.ts`), against the real `RateLimitIdentityDurableObject` under `workerd` rather than a storage fake, which would be code kept forever that proves less. Fidelity caveat: local `workerd` does not reproduce production edge distribution, so I-018-2 parity is asserted at the contract level, not the edge-distribution level. The Workers runner drives time by faking only `Date` with Vitest's fake timers, starting a day ahead of the real clock so no Durable Object alarm comes due mid-test; the fake clock reaches the Durable Object because the Workers project runs it in the test's own isolate, where the Rust build reads `Date` through `js_sys`.
  - **Spec coverage:** Spec-019 §Deployment-Aware Abstraction (the same limit — the parity proof), Spec-019 §Acceptance Criteria
  - **Verifies invariant:** I-018-2
  - **Consumes:** all Phase-2 tasks.

### Phase 3 — Enforcement Wiring

**Goal:** the admission check, the `axum` middleware, and the wiring of the sign-in routes.

**Precondition:** Phase 2 shipped.

#### Tasks

- **T18.3-1 — `rate_limit/enforcement_pipeline.rs`.** `create_admission_check` per §API And Transport Changes — returns `check_admission`: `RateLimiter::check` for the request's endpoint. Unit test: a limiter error propagates unchanged. The admit and refuse answers are proven through the real router by T18.3-2's tests and T18.4-1's rows, which run over `create_admission_check`.
  - **Spec coverage:** Spec-019 §Overflow Response (429 + Retry-After on refusal), Spec-019 §Fallback Behavior
  - **Verifies invariant:** I-018-1
  - **Consumes:** `RateLimiter` via factory ← T18.2-5.
- **T18.3-2 — `middleware/rate_limit.rs` (CREATE).** `rate_limit_layer` per §API And Transport Changes: the source address (D-018-4), 429 with the canonical body. It reads `SourceAddress` from the request's extensions and `check_admission` from the router's state (`server/router.rs`), which each host's entry supplies (§Target Areas). Unit tests: a request with no resolvable address → 400; an allowed request carries no rate-limit header, and a 429 carries `Retry-After`.
  - **Spec coverage:** Spec-019 §Default Behavior, Spec-019 §Overflow Response (429; Retry-After)
  - **Verifies invariant:** I-018-1, I-018-4
  - **Consumes:** `check_admission` ← T18.3-1; the CP-018-1 router ← the control-plane host (§Preconditions).
- **T18.3-3 — Wire the sign-in routes + the daemon's dependency boundary.** Apply `rate_limit_layer(RateLimitEndpointGroup::AuthEndpoint)` per the §Endpoint Wiring Ownership table as a `route_layer` on the OAuth sign-in routes (`/oauth/par`, `/oauth/authorize` with its `Create an account` arm, `/oauth/token` and `/oauth/revoke`), the device-linking routes and the four WebAuthn ceremony routes, inside the CP-018-1 mount seam (the Worker entry module, `src/worker.rs`, needs no edit). The daemon cannot reach `rate_limit_layer`: `sidekicks-daemon` does not depend on `sidekicks-control-plane`, so Cargo refuses any use of its `middleware` and `rate_limit` modules, and the wire types both read sit in `sidekicks-contracts`. The first route mounted here also proves the host's failure path, which no request reaches while the router is empty: an internal failure in it is logged with its request id and answered with the fixed message `Unexpected internal error`, never the failure's own text.
  - **Spec coverage:** Spec-019 §Acceptance Criteria (`auth.endpoint`; daemon exclusion), Spec-019 §Scope (daemon scope exclusion)
  - **Verifies invariant:** I-018-1 (daemon-exclusion companion)
  - **Consumes:** `rate_limit_layer` ← T18.3-2; the OAuth sign-in routes and their `Create an account` arm (Plan-015 T5.4) and the device-linking routes (Plan-025 Phase 5); the WebAuthn ceremony routes (Plan-015 Phase 6).

### Phase 4 — Verification

**Goal:** the AC-anchored verification suite.

**Precondition:** Phase 3 shipped.

#### Tasks

- **T18.4-1 — AC-anchored integration verification (rows (1) and (3) in a Rust test of `crates/sidekicks-control-plane/tests/it/`, row (2) in `rate-limit.workers.test.ts` in the Workers project).** Named rows: (1) the 21st `auth.endpoint` request from one address in 60 s → 429 with `Retry-After` per formula, and the first request after the window frees → allowed; (2) in the Workers test project this task adds, 21 `auth.endpoint` requests from one address through the Worker's own entry, each resolving the address's Durable Object by name as any edge location does → the 21st refused (local `workerd` runs one location: T18.2-6's fidelity caveat); (3) a counter error fails that one request, and the next request is counted.
  - **Files:** the Workers test project (CREATE — a TypeScript Vitest project carrying the `cloudflareTest()` plugin from `@cloudflare/vitest-plugin` with `wrangler: { configPath }` naming the crate's `wrangler.jsonc`, so row (2) and T18.2-2's object and alarm tests run in `workerd` against the Rust build with the `RATE_LIMIT_IDENTITY` Durable Object binding Phase 2 declares, `fsModuleCache: false` under Vitest 5; its npm manifest sits outside the crate root, since `worker-build` refuses a `package.json` with dependencies there, and lists `@cloudflare/vitest-plugin` as a devDependency). The plugin is Cloudflare's own Vitest integration for Workers; it runs the test inside the Workers runtime against the Worker's own bindings, which a Rust test cannot ([Cloudflare: Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/); [Testing Durable Objects](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/); [Known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)). Every test that needs no runtime binding is a Rust test run by nextest, the request-gate test among them.
  - **Spec coverage:** Spec-019 §Acceptance Criteria, Spec-019 §Fallback Behavior, Spec-019 §Example Flows (the auth-endpoint example)
  - **Verifies invariant:** I-018-1
  - **Consumes:** all prior phases.

## Parallelization Notes

- Phase 1 lands first; T18.1-1 is the root contract; T18.1-2/-3 (doc parity verification) and T18.1-4 follow it in parallel.
- Phase 2: T18.2-1 first; then T18.2-2 (the DO) and T18.2-4 (the in-memory counter) in parallel; T18.2-3 after T18.2-2; T18.2-5 after the limiters; T18.2-6 last (drives everything).
- Phase 3: T18.3-1 → T18.3-2; T18.3-3 after both.
- Phase 4: T18.4-1.

## Test And Verification Plan

The per-task test obligations live in each `#### Tasks` row above. Summary by layer:

- **Unit (`#[cfg(test)] mod tests` in `crates/sidekicks-control-plane/src/rate_limit/` and `src/middleware/`):** factory rows; the in-memory counter's window expiry; pipeline rows; middleware address and header rows.
- **Workers (TypeScript under `@cloudflare/vitest-plugin`, against the Rust build):** DO single-alarm re-arm, restart persistence, full-expiry eviction and the counter (T18.2-2); T18.4-1 row (2).
- **Contracts (`crates/sidekicks-contracts/src/rate_limiter.rs`):** the full body decodes (T18.1-4). The registry-key enum is held by the registry table's exhaustive `match`, which `rustc` checks (T18.1-4).
- **Parity (`tests/fixtures/rate_limiter_scenarios.json`):** the I-018-2 proof, one JSON scenario table read by the Rust test and the Workers test (T18.2-6; CP-018-2).
- **Integration (`crates/sidekicks-control-plane/tests/it/`):** the AC-anchored rows of T18.4-1, through the real router over the real counters.
- **Structural:** the daemon's dependency boundary is Cargo's (`sidekicks-daemon` does not depend on `sidekicks-control-plane`, T18.3-3); no test parses sources for it.

## Rollout Order

1. Land Phase 1 (contracts + doc parity).
2. Land Phase 2 implementations; the scenario table green against both.
3. Land Phase 3 wiring (`axum` middleware).
4. Land Phase 4 verification suite.

## Rollback Or Fallback

- **Counter outage:** a failing counter fails the sign-in requests it touches, like any backend error; no route a credential reaches is counted, so the person's signed-in devices keep working.
- **Rollback to pass-through:** the middleware can be uninstalled by removing the `.route_layer(rate_limit_layer(...))` on each route. This is a code change.

## Risks And Blockers

- **Durable Object round trip.** Every sign-in route request on the Workers relay waits on one DO round trip (10–50 ms). The routes see a handful of requests per device per day, so it is accepted (D-018-1).
- **Counts reset with the self-hosted relay's program.** The in-memory windows start empty when the relay program restarts.

## Done Checklist

- The `RateLimiter` trait, its check types and `RateLimitEndpointGroup` live in `crates/sidekicks-control-plane/src/rate_limit/limiter.rs`; `RateLimitResponse` lives in `crates/sidekicks-contracts/src/rate_limiter.rs`; all with the shapes defined in §API And Transport Changes.
- `CloudflareWorkersRateLimiter` and the in-memory counter both pass the one scenario table (`rate_limiter_scenarios.json`).
- `RateLimiterFactory` selects the implementation from the deployment's configuration.
- `RateLimitIdentityDurableObject` is a `#[durable_object]` in the Worker entry module, `src/worker.rs`, declared in `wrangler.jsonc`'s `durable_objects.bindings` + `migrations`, holds the per-group windows in its SQLite table with single-alarm scheduling and full-expiry `delete_all()` self-eviction (I-018-3), and counts each source address once worldwide (Spec-019 §Acceptance Criteria).
- Every enforced transport admits through one stage (I-018-1): every rate-limited route through `check_admission`.
- `rate_limit_layer` is wired on the sign-in, token-refresh and device-linking routes, and on nothing else.
- A counter error fails only the request it occurred on.
- 429s include `Retry-After` computed as `max(0, ceil((reset_at - now) / 1000))`; allowed responses carry no rate-limit header.
- api-payload-contracts.md parity verified against the typed exports (`RateLimitResponse`, timing pair required; `RateLimitCheckRequest`; `RateLimitCheckResponse`; T18.1-2 lands only drift fixes), and every code the implementation emits resolves to a registered error-contracts.md row (T18.1-3).
- Local daemon IPC path is NOT rate-limited — held by Cargo's dependency graph (`sidekicks-daemon` does not depend on `sidekicks-control-plane`), not by review.

## Dependencies

Strictly **downstream of the control-plane host** for the CP-018-1 router, and **upstream of the Compose relay, `sidekicks-control-plane`'s native program** (which instantiates the in-memory counter + `create_admission_check` inside its compose-deployed program, CP-018-2). T18.3-3 lands in `passkey-relying-party`, `devices-and-push` and `control-plane-account`, each for the routes it adds ([cross-plan-dependencies §Remote Control](../architecture/cross-plan-dependencies.md#remote-control)).

## References

- [Spec-019: Rate Limiting Policy](../specs/019-rate-limiting-policy.md)
- [ADR-013: Control Plane API](../decisions/013-control-plane-api.md)
- [ADR-019: V1 Deployment Model And OSS License](../decisions/019-v1-deployment-model-and-oss-license.md)
- [ADR-010: Tokens, Passkeys And The Remote Channel](../decisions/010-tokens-passkeys-and-the-remote-channel.md)
- [Deployment Topology §Rate Limiting By Deployment](../architecture/deployment-topology.md#rate-limiting-by-deployment)
- [Cloudflare Durable Objects: Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [axum middleware](https://docs.rs/axum/latest/axum/middleware/index.html)
