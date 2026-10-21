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

Ship Spec-019's count on the person's own relay — the Workers relay in their own Cloudflare account, or the self-hosted relay: the sign-in routes (sign-in, token refresh and device linking) counted per source address by one sliding-window counter over one table, `counted_requests`, in the account's one schema. On the Workers relay the table sits in the account object's SQLite storage, which counts each address once worldwide; on the self-hosted relay it sits in the account's SQLite file. Each host reaches the counter through one admission check, and an over-limit request is answered with 429 and `Retry-After`. Both deployments enforce the same limit with the same headers and the same refusal body.

## Scope

- The counter, owned by this plan at `crates/sidekicks-control-plane/src/rate_limit/limiter.rs`: the typed `RateLimitEndpointGroup` key enum derived from the [Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry), the check request and response types, and `check` and `prune` over the account store, the same code on both hosts. Only the relay's control plane checks a limit, and the daemon never does. The wire devices read lives in `crates/sidekicks-contracts/src/rate_limiter.rs`: the canonical `RateLimitResponse` body (D-018-3) as a serde type, its generated TypeScript type and Ajv check at `packages/contracts/src/rate-limiter.ts`.
- The `counted_requests` table in the account's one schema ([Hosted Account Schema](../architecture/schemas/hosted-account-schema.md)), which `crates/sidekicks-control-plane/src/account_store.rs` builds with every other table.
- One admission check per host (D-018-1, D-018-2), the only stage before a counted route: on the Workers relay, `AccountObjectAdmission` runs the counter inside the account object, which serves the counted routes, over its SQLite storage; on the Compose relay, `AccountFileAdmission` runs it over the account's SQLite file. A trip is a 429 with the window's `Retry-After`, and a counter error fails that one request like any backend error. The relay's channel carries no rate limit: it forwards each device's frames as fast as the machine drains them, and backpressure on the channel bounds both directions.
- The `axum` middleware `rate_limit`, applied per the §Endpoint Wiring Ownership table (D-018-3).
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

- The control plane's stable router (the router host, and [Plan-015](./015-hosted-account-and-identity.md) T6.6's signed-in procedure) that the `rate_limit` middleware layers onto (CP-018-1).

## Target Areas

- `crates/sidekicks-contracts/src/rate_limiter.rs` — **created by this plan.** The wire devices read: the `RateLimitResponse` 429 body as a serde type, and the two codes a sign-in route refuses with, `relay.rateLimited` and `relay.sourceAddressUnresolvable` (the 400 of §Identity resolution). Its generated TypeScript type and Ajv check sit at `packages/contracts/src/rate-limiter.ts`.
- `crates/sidekicks-control-plane/src/rate_limit/` — **created by this plan.**
  - `limiter.rs` — `RateLimitEndpointGroup`, `RateLimitCheckRequest`/`RateLimitCheckResponse`, and the counter's `check`, `prune` and `find_next_cleanup_at` over the account store, with `read_wall_clock`, which reads the time through `time` on both targets.
  - `endpoint_groups.rs` — canonical endpoint-group → `{ limit, period }` table transcribed from the Spec-019 registry — the one source of the limit (T18.2-1).
  - `enforcement_pipeline.rs` — the `AdmissionCheck` trait and its two hosts: `AccountObjectAdmission`, the count inside the account object with its cleanup alarm (wasm32 only), and `AccountFileAdmission`, the Compose relay's count over its file with its one cleanup task (native only).
  - `layer.rs` — the `axum` middleware `rate_limit`, its `CountedRoute` state and `canonicalize_identity` (D-018-4).
- `crates/sidekicks-control-plane/src/account_store.rs` — **extended by this plan:** the `counted_requests` table and its two indexes in the one schema it builds, and the `AccountStore` calls the counter makes (`execute`, `query`), over the account object's `SqlStorage` on the Worker and the Compose relay's `rusqlite` connection.
- `crates/sidekicks-control-plane/tests/fixtures/rate_limiter_scenarios.json` — **created by this plan:** the one JSON scenario table of the I-018-2 proof, read by the Rust test against the counter over an account file and by the Workers test against the account object (T18.2-4).
- `crates/sidekicks-control-plane/src/server/router.rs` — **extended by this plan:** the router's state is the host's `AdmissionCheck`, which a counted route hands the middleware, and each host's entry puts the caller's `SourceAddress` and its `RequestId` in the request's extensions as the deployment's edge reports them. `ControlPlaneRefusal` answers [ADR-013](../decisions/013-control-plane-api.md)'s refusal body, `{code, category, message}` with the code's own fields beside them, so a 429's body is the `RateLimitResponse`. An internal failure is logged with its request id and answers 500 with the fixed message `Unexpected internal error`, the wording of error-contracts.md's `system.internalError`, so a caller never reads the relay's own error text; request paths hold no panicking call, since a panic in the Worker answers 500 and resets the instance.
- `crates/sidekicks-control-plane/src/worker.rs` — **created by this plan:** the Worker entry module, `#[event(fetch)]`, which serves the host, and the home of the `#[durable_object]` `AccountObject` the deployed script exports, which serves the account's routes and counts the sign-in routes' requests in its storage, and whose alarm drops counted requests past their window. `wrangler.jsonc`'s `main` names the shim `worker-build` writes for it.
- `crates/sidekicks-control-plane/src/server/host.rs` — **extended by this plan, inside the CP-018-1 stable-mount seam:** the Worker's host reads `SourceAddress` from `CF-Connecting-IP` and `RequestId` from `cf-ray`, and forwards every account route to the account object, which builds the account router once per instance over `AccountObjectAdmission`; the forward reads the `ACCOUNT` binding, so a missing binding fails only a forwarded route; an internal failure, such as a counter error, is logged with that id and the caller reads only a 500. The Compose relay's program does the same from Caddy's headers (§Request ids). No route is wired here; T18.3-3 does that.
- `docs/architecture/contracts/api-payload-contracts.md` — carries the `RateLimitResponse` (symbol anchor: `interface RateLimitResponse` under §Error Responses), and the `RateLimitCheckRequest` and `RateLimitCheckResponse`. T18.1-2 verifies shape parity against the typed exports at implementation time and lands only drift fixes.
- `docs/architecture/contracts/error-contracts.md` — carries the canonical body under §Rate Limiting. T18.1-3 verifies code-table parity at implementation time and lands only drift fixes.
- `docs/architecture/deployment-topology.md` §Rate Limiting By Deployment — both relays count in `counted_requests`: the Workers relay in the account object's storage, the self-hosted relay in its SQLite file (D-018-1, D-018-2).
- `packages/control-plane/wrangler.jsonc`, beside the package's `package.json` (Workers, the Worker `sidekicks-control-plane`, production `sidekicks-control-plane-production`; extended at Phase-2 landing) — `main` names the `worker-build` shim; declare (a) under `durable_objects.bindings` `{ "name": "ACCOUNT", "class_name": "AccountObject" }`, again under `env.production` since an environment inherits no Durable Object binding, and (b) a `migrations` entry adding `AccountObject` to `new_sqlite_classes`.

## Data And Storage Changes

This plan owns one table of the account's one schema, `counted_requests`: every piece of rate-limit state is a row of it, ephemeral and bounded by its window (I-018-3). Erasure needs no step here — a row names a source address and no user, and goes within a window of the request it counts.

### The `counted_requests` table

- One row per request a sign-in route counted: its endpoint group, the caller's source address in canonical form (D-018-4), and `expires_at_ms`, the Unix millisecond it leaves its window, since a window frees to the millisecond. An index on `(endpoint_group, identity, expires_at_ms)` serves the check, and one on `expires_at_ms` the cleanup.
- Each check runs, in order and with nothing awaited between: `DELETE` every row past its window, `SELECT COUNT(*), MIN(expires_at_ms)` for the group and address, then refuse or `INSERT`. On the Workers relay the account object runs them in one `transactionSync` step, so nothing else runs between the read and the write and a failure rolls the step back; on the Compose relay they run in one transaction on the process's one connection. The window's `remaining` and `reset_at` come from the same read: `reset_at` is the earliest `expires_at_ms` of the address's rows, or this request's own when it is the first. A refused request is not recorded, so a caller that keeps knocking never pushes its own window later.

### Cleanup

- **Workers relay: one alarm.** Cloudflare permits one alarm per object, and each `set_alarm` is a billed row written, so an admitted count sets it only when none is pending, with `ScheduledTime::new(js_sys::Date)` at the earliest instant an address's whole window empties (one window after its newest counted request). `alarm()` drops every row past its window and re-arms at the next such instant while rows remain. The object never calls `delete_all()`, which would drop the account's tables with the counter's.
- **Compose relay: one task.** The same shape: an admitted count starts one tokio task only when none is running, sleeping until the same instant; it drops every row past its window, sleeps again while rows remain, and ends once none is left. The count and the task's last prune each mark the task running or ended while they hold the file, so neither misses the other. Dropping the admission aborts it.

Every registry window is 60 seconds, so an address's rows are gone within a minute of its last request on either relay.

### The account object's count

The account object, named `account`, serves the account's routes, so a counted route's count runs where the route does: `check_admission` runs `check` in one step over the object's storage before the route. The Worker forwards each account request unchanged through the stub's `fetch_with_request` and waits at most 10 seconds, longer than the longest wait inside the object; a failed or late answer fails that one request with the logged 500. A late answer is not taken back: the object may have counted the request whose caller read a 500, which counts against that address until its window passes. A failed alarm read or set inside the object is logged with the request's id, and the count it already made is still answered.

### Request ids

A 500 is logged with the id of the request the edge gave it, so the relay's log line and the edge's own log meet. The Worker logs Cloudflare's `cf-ray` and passes it to the account object as `X-Request-Id`, so a failure raised inside the object logs the same id. The Compose relay's Caddyfile sets `header_up X-Request-Id {http.request.uuid}` in its `reverse_proxy` block (Caddy's per-request v4 UUID, also in its access log as `uuid`; `header_up` replaces any id a client sends), and the program logs `X-Request-Id`, or a fresh v4 UUID when it runs without Caddy.

### `RateLimitResponse` canonical shape

The 429 body has one shape, the same in error-contracts.md §Rate Limiting and api-payload-contracts.md §Error Responses:

```rust
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RateLimitResponse {
    pub code: RelayRateLimitedCode, // always "relay.rateLimited"
    pub category: RelayRateLimitedCategory, // always "resourceExhausted"
    pub message: String,
    pub retry_after: SafeInt<0>, // whole seconds until retry is allowed
    pub limit: SafeInt<0>, // total allowed requests in the window
    pub remaining: SafeInt<0>, // requests remaining in the current window
    pub reset_at: WireInstant, // the RFC 3339 instant the oldest counted request leaves the window
}
```

Code-level home: `crates/sidekicks-contracts/src/rate_limiter.rs`, which T18.1-1 creates, so its consumers assert against a typed export instead of a doc shape; devices read the generated TypeScript at `@ai-sidekicks/contracts/rate-limiter`. The api-payload-contracts.md shape is anchored by symbol (`interface RateLimitResponse` under §Error Responses); T18.1-2 verifies doc-vs-export parity at implementation time. Every refusal carries both timing fields, so the type holds both as required, non-`Option` fields (T18.1-4).

## API And Transport Changes

### The counter (new, owned by this plan)

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
    pub reset_at: WireInstant, // when the oldest counted request leaves the window
    pub limit: u32, // total threshold for this window
}

pub fn check<S: AccountStore>(
    store: &S,
    request: &RateLimitCheckRequest,
    now: Timestamp,
) -> Result<RateLimitCheckResponse, RateLimiterError>;

// drops the rows past their window; answers when the next address's window empties
pub fn prune<S: AccountStore>(store: &S, now: Timestamp) -> Result<Option<Timestamp>, RateLimiterError>;
```

- The counter and its check types live in the control plane's crate: only the relay's control plane checks a limit, on the Worker and in the Compose relay's native program, and the daemon never does ([Spec-019 §Scope](../specs/019-rate-limiting-policy.md#scope)). The `RateLimitResponse` body, which devices read, lives in `crates/sidekicks-contracts/src/rate_limiter.rs` as a serde type per the `machine/registration.rs` wire-shape convention.

### Admission pipeline (D-018-1)

```rust
// crates/sidekicks-control-plane/src/rate_limit/enforcement_pipeline.rs
pub trait AdmissionCheck: Clone + Send + Sync + 'static {
    fn check_admission(
        &self,
        request: RateLimitCheckRequest,
        request_id: Option<RequestId>,
    ) -> impl Future<Output = Result<RateLimitCheckResponse, AdmissionError>> + Send;
}
```

One stage on every enforced transport (I-018-1): every rate-limited route calls `check_admission`, whose only stage is the counter; the relay's channel carries no rate limit. The account object's `AccountObjectAdmission` runs it over the object's storage; the Compose relay's `AccountFileAdmission` runs it on its file in `spawn_blocking`. An error from either propagates and fails that one request like any backend error.

### Identity resolution (D-018-4, D-018-5)

- **The source address is the identity.** The check keys on the caller's source address alone (D-018-5).
- **Canonical form (D-018-4):** IPv4 exact dotted-quad / IPv6 normalized to its /64 prefix (lowercase, compressed); an IPv4-mapped IPv6 address counts as its IPv4 address. The parse is `std::net`'s `IpAddr`, whose IPv6 text is the RFC 5952 compressed form and whose `to_canonical` folds a mapped address: it needs no dependency and runs alike on the Worker's `wasm32` build and the Compose relay's native one, where a hand-written parser would be code the project keeps forever.
- **Client IP provenance.** Workers: the Cloudflare-set `CF-Connecting-IP` header. Compose relay: the rightmost `X-Forwarded-For` entry, read only from a request whose connection comes from the configured Caddy address (Caddy appends the address it saw). Each host puts the address it trusts in the request's `SourceAddress`; the middleware canonicalizes it. A request with no resolvable address is refused 400 with `relay.sourceAddressUnresolvable`, before anything is counted, rather than rate-limited into a shared bucket.

### The `axum` middleware (layered onto the control-plane router per CP-018-1)

```rust
// crates/sidekicks-control-plane/src/rate_limit/layer.rs
pub async fn rate_limit<A: AdmissionCheck>(
    State(route): State<CountedRoute<A>>, // the host's admission check, endpoint group and clock
    request: Request,
    next: Next,
) -> Response {
    // D-018-4: no countable address is a 400 before anything is counted
    // a counter error is logged with the request's id and answered 500
    // a trip is a 429: the RateLimitResponse, its retry_after also sent as `Retry-After`
    // an allowed request runs its route, and its response carries no rate-limit header
}
```

- Usage on a route: `.route_layer(axum::middleware::from_fn_with_state(CountedRoute { admission, endpoint: RateLimitEndpointGroup::AuthEndpoint, clock: read_wall_clock }, rate_limit))`, the admission read from the router's state ([axum middleware](https://docs.rs/axum/latest/axum/middleware/index.html)). The clock is read through `time` with its `wasm-bindgen` feature on the Worker, never `std::time::SystemTime::now`, which panics on `wasm32-unknown-unknown`.
- Header policy: `Retry-After` on every 429, and none on an allowed response.
- The 429 body: `ControlPlaneRefusal` (in `server/router.rs`) answers [ADR-013](../decisions/013-control-plane-api.md)'s refusal body, `{code, category, message}` with the code's own fields beside them, so a 429 answers the `RateLimitResponse` (`{code: "relay.rateLimited", category: "resourceExhausted", message, retryAfter, limit, remaining, resetAt}`) and the 400 answers `{code: "relay.sourceAddressUnresolvable", category: "invalidArgument", message}`. The refusal sets the status and, on a 429, the `Retry-After` header on its own response.

### Retry-After on 429 responses

A 429 response must set:

- `Retry-After: <seconds>` — formula: `max(0, ceil((reset_at - now) / 1000))`. On both relays `reset_at` is "the time the oldest counted request ages out of the window", the earliest `expires_at_ms` of the address's rows in `counted_requests` (D-018-1).

## Invariants

| ID | Invariant | Verified by |
| --- | --- | --- |
| I-018-1 | Every enforced transport admits through one stage: every rate-limited route through `check_admission`, whose only stage is the counter. The daemon IPC path is reachable by no admission stage. | T18.3-2's middleware tests; Cargo's dependency graph: `sidekicks-daemon` does not depend on `sidekicks-control-plane` (T18.3-3). |
| I-018-2 | Both relays run the one counter over the same table, so they enforce the same limit with identical `check` semantics; only where the table lives differs. | The one JSON scenario table (T18.2-4), read by the Rust test against the counter over an account file and by the Workers test against the account object, both green in CI. |
| I-018-3 | Rate-limit state is ephemeral and bounded by its window: counted requests are rows of `counted_requests`, dropped by each check and by the cleanup (the account object's alarm, the Compose relay's task) once their window passes. | The account object's restart and alarm tests (T18.2-3); the Compose relay's cleanup test (T18.3-1). |
| I-018-4 | The check request/response and the 429 `RateLimitResponse` body have exactly one canonical shape — identical in [Spec-019 §Interfaces And Contracts](../specs/019-rate-limiting-policy.md#interfaces-and-contracts), error-contracts.md, api-payload-contracts.md, and code: the check shapes in `crates/sidekicks-control-plane/src/rate_limit/limiter.rs`, the body in `crates/sidekicks-contracts/src/rate_limiter.rs`. | T18.1-2/T18.1-3 parity verification at implementation; T18.1-4 decode test (the full body decodes; every field is required, non-`Option`); cross-doc drift checked at review. |

## Cross-Plan Obligations

| ID | Direction | Counterparty | Obligation | Anchor |
| --- | --- | --- | --- | --- |
| CP-018-1 | consumes ← | the control-plane host | The stable router that the `rate_limit` middleware layers onto; the host authors no rate-limit **middleware** task — the middleware's authorship stays here. This plan adds the account object to the Worker entry module, `src/worker.rs`, and supplies inside the same seam the state and request extensions the middleware reads (§Target Areas). | [Plan-018 §Target Areas](#target-areas) |
| CP-018-2 | provides → | [Plan-025](./025-remote-control.md)'s Compose relay, `sidekicks-control-plane`'s native program | The counter, `AccountFileAdmission` over the account's SQLite file and the `rate_limit` middleware, instantiated not re-implemented, in the same crate's native target; the program sets each request's `SourceAddress` and `RequestId` (§Request ids). The scenario table's Rust test runs against that counter over an account file. | [Plan-025 §Phase 3 — The relay and the channel](./025-remote-control.md#phase-3--the-relay-and-the-channel) |

### Endpoint wiring ownership (D-018-3)

The `rate_limit` middleware is NOT applied by iterating the spec registry; ownership is explicit:

| Endpoint group (canonical key) | Route owner | Wiring owner + mechanism |
| --- | --- | --- |
| `auth.endpoint` | the OAuth sign-in routes `/oauth/par`, `/oauth/authorize` with its sign-in page's `Create an account` arm, `/oauth/token` (the code's redemption and the refresh-token trade) and `/oauth/revoke`, and the four WebAuthn ceremony routes (`WebAuthnRegistrationOptionsIssue`, `WebAuthnRegistrationVerify`, `WebAuthnAuthenticationOptionsIssue`, `WebAuthnAuthenticationVerify`) ([Plan-015](./015-hosted-account-and-identity.md)), and the device-linking routes ([Plan-025](./025-remote-control.md) Phase 5) | Plan-018 T18.3-3 |

## Design Decisions

| ID | Decision |
| --- | --- |
| D-018-1 | The counter is one table, `counted_requests`, in the account's one schema, and one set of statements over the account store serves both relays. On the Workers relay the table sits in the account object's SQLite storage: one atomic check-and-count per request, one global count per source address, and the window the headers report (`remaining`/`reset_at`). Cloudflare advises one Durable Object per unit that needs coordination, never one global limiter object, and the account object is already one per account. The 10–50 ms object round trip lands only on the account's routes, which see a handful of requests per device per day. |
| D-018-2 | The self-hosted relay keeps the same table in the account's SQLite file and runs the same counter on it, each check in one transaction on its one connection; one cleanup task drops each row once its window has passed. |
| D-018-3 | [Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) is the single limit enumeration with canonical keys; the §Endpoint Wiring Ownership table assigns its row. |
| D-018-4 | Canonical source address (IPv4 exact / IPv6 /64); IP provenance = `CF-Connecting-IP` (Workers) / the rightmost `X-Forwarded-For` entry, read only from the configured Caddy address (Compose relay); missing address → 400. |
| D-018-5 | The check keys on the caller's source address alone: the sign-in routes are reached before the caller holds a credential. |

## Implementation Phase Sequence

### Phase 1 — Contracts + Doc Parity

**Goal:** land the typed contract surface and the contracts-doc parity check so every later phase builds against canonical shapes.

**Precondition:** none.

The phase builds on the contracts crate (Plan-001 Phase 1 T1.2).

#### Tasks

- **T18.1-1 — `crates/sidekicks-control-plane/src/rate_limit/limiter.rs` and `crates/sidekicks-contracts/src/rate_limiter.rs`.** In the control plane's file, author `RateLimitEndpointGroup` (registry-key enum, D-018-3), `RateLimitCheckRequest` and `RateLimitCheckResponse`. In contracts, author the `RateLimitResponse` wire body as a serde type (both timing fields required, [Spec-019 §Overflow Response](../specs/019-rate-limiting-policy.md#overflow-response)); its generated TypeScript is reached at its own subpath, `@ai-sidekicks/contracts/rate-limiter`, with nothing to re-export.
  - **Spec coverage:** Spec-019 §Interfaces And Contracts (RateLimitCheck shape), Spec-019 §One Counter On Both Relays (one counter on both deployments), Spec-019 §Overflow Response (standard RateLimitResponse body)
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

**Goal:** the counter and its table, the account object that runs it on the Workers relay, and the parity proof (one scenario table).

**Precondition:** Phase 1 shipped.

#### Tasks

- **T18.2-1 — `endpoint_groups.rs`.** Canonical endpoint-group → `{ limit, period }` table transcribed from the Spec-019 registry; the single config source for the counter and for header values.
  - **Spec coverage:** Spec-019 §Canonical Endpoint Group Registry (registry table header — single enumeration), Spec-019 §One Counter On Both Relays (the same limit)
  - **Verifies invariant:** I-018-2
  - **Consumes:** `RateLimitEndpointGroup` ← T18.1-1.
- **T18.2-2 — The counter and `counted_requests`.** The table and its indexes in `account_store.rs`'s one schema; `check`, `prune` and `find_next_cleanup_at` in `limiter.rs` per §Data And Storage Changes, over `AccountStore`, so the account object's `SqlStorage` and the Compose relay's `rusqlite` connection run the same statements. Its tests are the scenario table's (T18.2-4).
  - **Spec coverage:** Spec-019 §One Counter On Both Relays (one counter over one table), Spec-019 §Implementation Notes (sliding window), Spec-019 §State And Data Implications (counters not persisted beyond their window)
  - **Verifies invariant:** I-018-2, I-018-3
  - **Consumes:** `endpoint_groups.rs` ← T18.2-1; the account store's schema and calls.
- **T18.2-3 — The account object.** `AccountObject`, a `#[durable_object]` in the Worker entry module, `crates/sidekicks-control-plane/src/worker.rs`, its SQLite storage holding the account's schema, built fallibly on its first request or alarm: a counted route's request runs `check` and sets the cleanup alarm only when none is pending; `alarm()` runs `prune` and re-arms while rows remain (§Cleanup). A failure inside it is logged with the `X-Request-Id` the Worker sent and answered 500. Its tests stay TypeScript under `@cloudflare/vitest-plugin` against the Rust build: restart persistence (rows survive; the alarm stays armed), the alarm dropping every row past its window and leaving the account's tables, and the counter row (the 21st `auth.endpoint` count from one address in 60 s refused atomically whichever location sent it, `resetAt` = window expiry).
  - **Spec coverage:** Spec-019 §One Counter On Both Relays (the sign-in routes counted once in the account object), Spec-019 §State And Data Implications (counters not persisted beyond their window)
  - **Verifies invariant:** I-018-3
  - **Consumes:** the counter ← T18.2-2; Cloudflare DO runtime through `worker` 0.8.7; wrangler DO binding + migration declaration (§Target Areas wrangler deliverable).
- **T18.2-4 — The scenario table + runners.** `tests/fixtures/rate_limiter_scenarios.json` holds the one scenario set: under-limit allow; at-limit deny; header-source fields present + internally consistent; a denial reports the window's `resetAt` and a check at exactly that instant is allowed, one a millisecond earlier refused; window expiry re-allow after refusals inside the window (a refusal is never recorded); per-address isolation. Runners: a Rust test in `crates/sidekicks-control-plane/tests/it/` against the counter over an account file, its clock injected, and a test in the Workers project T18.4-1 adds, against the real account object under `workerd` rather than a storage fake, which would be code kept forever that proves less. Fidelity caveat: local `workerd` does not reproduce production edge distribution, so I-018-2 parity is asserted at the contract level, not the edge-distribution level. The Workers runner drives time by faking only `Date` with Vitest's fake timers, starting a day ahead of the real clock so no Durable Object alarm comes due mid-test; the fake clock reaches the Durable Object because the Workers project runs it in the test's own isolate, where the Rust build reads `Date` through `time` and `js_sys`.
  - **Spec coverage:** Spec-019 §One Counter On Both Relays (the same limit — the parity proof), Spec-019 §Acceptance Criteria
  - **Verifies invariant:** I-018-2
  - **Consumes:** all Phase-2 tasks.

### Phase 3 — Enforcement Wiring

**Goal:** the admission checks, the `axum` middleware, and the wiring of the sign-in routes.

**Precondition:** Phase 2 shipped.

#### Tasks

- **T18.3-1 — `rate_limit/enforcement_pipeline.rs`.** The `AdmissionCheck` trait per §API And Transport Changes and its two hosts: `AccountObjectAdmission`, the Worker's JSON call to the account object with its bounded wait (§The account object's count), and `AccountFileAdmission`, the count on the Compose relay's file in one transaction with its one cleanup task (§Cleanup). Test: once every window has passed on a paused clock, the file holds nothing counted and no cleanup task is left, and a count after the task ended starts another.
  - **Spec coverage:** Spec-019 §Overflow Response (429 + Retry-After on refusal), Spec-019 §Fallback Behavior, Spec-019 §State And Data Implications
  - **Verifies invariant:** I-018-1, I-018-3
  - **Consumes:** the counter ← T18.2-2; the account object ← T18.2-3.
- **T18.3-2 — `rate_limit/layer.rs` (CREATE).** The `rate_limit` middleware per §API And Transport Changes: the source address (D-018-4), 429 with the canonical body. It reads `SourceAddress` and `RequestId` from the request's extensions and the host's admission check and clock from its `CountedRoute`, built from the router's state (`server/router.rs`), which each host's entry supplies (§Target Areas). Tests, through a router over a real account file: a request with no countable address → 400 before anything is counted; an allowed request carries no rate-limit header, and the 21st is a 429 whose `Retry-After` equals its body's `retryAfter`; `Retry-After` is the wait in whole seconds rounded up (a reset 59,001 ms away reads 60) and never falls below 0; a counter error fails that one request with the fixed 500 body, and the next request is counted. The canonical identity is one case table: IPv4, a mapped address folded to IPv4, two addresses of one /64 as one identity, `127.1` and `01.2.3.4` refused.
  - **Spec coverage:** Spec-019 §Default Behavior, Spec-019 §Overflow Response (429; Retry-After), Spec-019 §Fallback Behavior
  - **Verifies invariant:** I-018-1, I-018-4
  - **Consumes:** `check_admission` ← T18.3-1; the CP-018-1 router ← the control-plane host (§Preconditions).
- **T18.3-3 — Wire the sign-in routes + the daemon's dependency boundary.** Apply the `rate_limit` middleware with `RateLimitEndpointGroup::AuthEndpoint` per the §Endpoint Wiring Ownership table as a `route_layer` on the OAuth sign-in routes (`/oauth/par`, `/oauth/authorize` with its `Create an account` arm, `/oauth/token` and `/oauth/revoke`), the device-linking routes and the four WebAuthn ceremony routes, inside the CP-018-1 mount seam: the account router the account object serves in the Worker entry module, `src/worker.rs`, and the Compose relay's router. The daemon cannot reach the middleware: `sidekicks-daemon` does not depend on `sidekicks-control-plane`, so Cargo refuses any use of its `rate_limit` module, and the wire types both read sit in `sidekicks-contracts`. The first route mounted here also proves the host's failure path through a real route: an internal failure in it is logged with its request id and answered with the fixed message `Unexpected internal error`, never the failure's own text.
  - **Spec coverage:** Spec-019 §Acceptance Criteria (`auth.endpoint`; daemon exclusion), Spec-019 §Scope (daemon scope exclusion)
  - **Verifies invariant:** I-018-1 (daemon-exclusion companion)
  - **Consumes:** the `rate_limit` middleware ← T18.3-2; the OAuth sign-in routes and their `Create an account` arm (Plan-015 T5.4) and the device-linking routes (Plan-025 Phase 5); the WebAuthn ceremony routes (Plan-015 Phase 6).

### Phase 4 — Verification

**Goal:** the AC-anchored verification suite.

**Precondition:** Phase 3 shipped.

#### Tasks

- **T18.4-1 — AC-anchored integration verification (rows (1) and (3) in a Rust test of `crates/sidekicks-control-plane/tests/it/`, row (2) in `rate-limit.workers.test.ts` in the Workers project).** Named rows: (1) the 21st `auth.endpoint` request from one address in 60 s → 429 with `Retry-After` per formula, and the first request after the window frees → allowed; (2) in the Workers test project this task adds, 21 `auth.endpoint` requests from one address through the Worker's own entry, each reaching the account object by name as any edge location does → the 21st refused (local `workerd` runs one location: T18.2-4's fidelity caveat); (3) a counter error fails that one request, and the next request is counted.
  - **Files:** the Workers test project (CREATE — a TypeScript Vitest project carrying the `cloudflareTest()` plugin from `@cloudflare/vitest-plugin` with `wrangler: { configPath }` naming `packages/control-plane/wrangler.jsonc`, so row (2) and T18.2-3's object and alarm tests run in `workerd` against the Rust build with the `ACCOUNT` Durable Object binding Phase 2 declares, `fsModuleCache: false` under Vitest 5; its npm manifest sits outside the crate root, since `worker-build` refuses a `package.json` with dependencies there, and lists `@cloudflare/vitest-plugin` as a devDependency). The plugin is Cloudflare's own Vitest integration for Workers; it runs the test inside the Workers runtime against the Worker's own bindings, which a Rust test cannot ([Cloudflare: Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/); [Testing Durable Objects](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/); [Known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)). Every test that needs no runtime binding is a Rust test run by nextest, the request-gate test among them.
  - **Spec coverage:** Spec-019 §Acceptance Criteria, Spec-019 §Fallback Behavior, Spec-019 §Example Flows (the auth-endpoint example)
  - **Verifies invariant:** I-018-1
  - **Consumes:** all prior phases.

## Parallelization Notes

- Phase 1 lands first; T18.1-1 is the root contract; T18.1-2/-3 (doc parity verification) and T18.1-4 follow it in parallel.
- Phase 2: T18.2-1 first; then T18.2-2 (the counter); T18.2-3 (the account object) after it; T18.2-4 last (drives everything).
- Phase 3: T18.3-1 → T18.3-2; T18.3-3 after both.
- Phase 4: T18.4-1.

## Test And Verification Plan

The per-task test obligations live in each `#### Tasks` row above. Summary by layer:

- **Unit (`#[cfg(test)] mod tests` in `crates/sidekicks-control-plane/src/rate_limit/`):** the canonical identity's case table (T18.3-2).
- **Workers (TypeScript under `@cloudflare/vitest-plugin`, against the Rust build):** the account object's alarm, restart persistence, cleanup and the counter (T18.2-3); T18.4-1 row (2).
- **Contracts (`crates/sidekicks-contracts/src/rate_limiter.rs`):** the full body decodes (T18.1-4). The registry-key enum is held by the registry table's exhaustive `match`, which `rustc` checks (T18.1-4).
- **Parity (`tests/fixtures/rate_limiter_scenarios.json`):** the I-018-2 proof, one JSON scenario table read by the Rust test and the Workers test (T18.2-4; CP-018-2).
- **Integration (`crates/sidekicks-control-plane/tests/it/`):** the middleware's rows (T18.3-2), the Compose relay's cleanup (T18.3-1), and the AC-anchored rows of T18.4-1, through the real router over a real account file.
- **Structural:** the daemon's dependency boundary is Cargo's (`sidekicks-daemon` does not depend on `sidekicks-control-plane`, T18.3-3); no test parses sources for it.

## Rollout Order

1. Land Phase 1 (contracts + doc parity).
2. Land Phase 2 implementations; the scenario table green against both.
3. Land Phase 3 wiring (the admission checks and the `axum` middleware).
4. Land Phase 4 verification suite.

## Rollback Or Fallback

- **Counter outage:** a failing counter fails the sign-in requests it touches, like any backend error; no route a credential reaches is counted, so the person's signed-in devices keep working.
- **Rollback to pass-through:** the middleware can be uninstalled by removing the `rate_limit` `.route_layer(...)` on each route. This is a code change.

## Risks And Blockers

- **Durable Object round trip.** Every sign-in route request on the Workers relay waits on one account-object round trip (10–50 ms). The routes see a handful of requests per device per day, so it is accepted (D-018-1).
- **Refused traffic reaches the account object.** A refused count still costs the account object one stub call and a few synchronous statements, and the owner's own calls wait in the same queue; a sustained flood of several hundred requests a second would bring `overloaded` errors. On the Free plan the daily request and row quotas, not where the counter lives, bound a flood.

## Done Checklist

- The counter, its check types and `RateLimitEndpointGroup` live in `crates/sidekicks-control-plane/src/rate_limit/limiter.rs`; `RateLimitResponse` lives in `crates/sidekicks-contracts/src/rate_limiter.rs`; all with the shapes defined in §API And Transport Changes.
- The counter passes the one scenario table (`rate_limiter_scenarios.json`) over an account file and in the account object.
- `AccountObject` is a `#[durable_object]` in the Worker entry module, `src/worker.rs`, declared in `wrangler.jsonc`'s `durable_objects.bindings` + `migrations`; it holds `counted_requests` in its SQLite storage with its one cleanup alarm (I-018-3), and counts each source address once worldwide (Spec-019 §Acceptance Criteria).
- Every enforced transport admits through one stage (I-018-1): every rate-limited route through `check_admission`.
- The `rate_limit` middleware is wired on the sign-in, token-refresh and device-linking routes, and on nothing else.
- A counter error fails only the request it occurred on.
- 429s include `Retry-After` computed as `max(0, ceil((reset_at - now) / 1000))`; allowed responses carry no rate-limit header.
- api-payload-contracts.md parity verified against the typed exports (`RateLimitResponse`, timing pair required; `RateLimitCheckRequest`; `RateLimitCheckResponse`; T18.1-2 lands only drift fixes), and every code the implementation emits resolves to a registered error-contracts.md row (T18.1-3).
- Local daemon IPC path is NOT rate-limited — held by Cargo's dependency graph (`sidekicks-daemon` does not depend on `sidekicks-control-plane`), not by review.

## Dependencies

Strictly **downstream of the control-plane host** for the CP-018-1 router, and **upstream of the Compose relay, `sidekicks-control-plane`'s native program** (which instantiates `AccountFileAdmission` over its account file inside its compose-deployed program, CP-018-2). T18.3-3 lands in `passkey-relying-party`, `devices-and-push` and `control-plane-account`, each for the routes it adds ([cross-plan-dependencies §Remote Control](../architecture/cross-plan-dependencies.md#remote-control)).

## References

- [Spec-019: Rate Limiting Policy](../specs/019-rate-limiting-policy.md)
- [ADR-013: Control Plane API](../decisions/013-control-plane-api.md)
- [ADR-019: V1 Deployment Model And OSS License](../decisions/019-v1-deployment-model-and-oss-license.md)
- [ADR-010: Tokens, Passkeys And The Remote Channel](../decisions/010-tokens-passkeys-and-the-remote-channel.md)
- [Deployment Topology §Rate Limiting By Deployment](../architecture/deployment-topology.md#rate-limiting-by-deployment)
- [Cloudflare Durable Objects: Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [axum middleware](https://docs.rs/axum/latest/axum/middleware/index.html)
