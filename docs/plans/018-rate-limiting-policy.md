# Plan-018: Rate Limiting Policy

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `018` |
| **Slug** | `rate-limiting-policy` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude Opus 4.7` |
| **Spec** | [Spec-019: Rate Limiting Policy](../specs/019-rate-limiting-policy.md) |
| **Required ADRs** | [ADR-013: tRPC Control-Plane API](../decisions/013-trpc-control-plane-api.md); [ADR-019: V1 Deployment Model And OSS License](../decisions/019-v1-deployment-model-and-oss-license.md); [ADR-014: V1 Feature Scope Definition](../decisions/014-v1-feature-scope-definition.md); [ADR-010: Tokens, Passkeys And The Remote Channel](../decisions/010-tokens-passkeys-and-the-remote-channel.md) |
| **Dependencies** | the shipped control-plane host (the stable tRPC middleware-mount surface consumed here; `wrangler.toml` deployment config extended); the sign-in, token-refresh and device-linking procedures the middleware wraps ([Plan-015](./015-hosted-account-and-identity.md), [Plan-025](./025-remote-control.md) Phase 5). Non-blocking context, not dependencies: Plan-005 daemon-IPC scope exclusion (§Non-Goals); Plan-025's self-host relay node as a downstream consumer (see §Cross-Plan Obligations) |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |

## Goal

Ship Spec-019's count on the person's own relay — the Workers relay in their own Cloudflare account, or the self-hosted relay: the sign-in routes (sign-in, token refresh and device linking) counted per source address, on the Workers relay in a per-identity Durable Object that counts each address once worldwide and on the self-hosted relay in the relay process's memory, behind a single `RateLimiter` contract and one admission check both transports call. An over-limit request is answered with 429 and `Retry-After`. Both deployments enforce the same limit with the same headers and the same refusal envelope.

## Scope

- `RateLimiter` contract owned by this plan at `packages/control-plane/src/rate-limit/limiter.ts`, with the typed `RateLimitEndpointGroup` key union derived from the [Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) and the check request/response types: only the relay's control plane checks a limit, and the daemon never does. The wire devices read lives in `packages/contracts`: the canonical `RateLimitResponse` envelope + Zod schema (D-018-3) in `rate-limiter.ts`.
- The `RateLimiter` implementations:
  - `CloudflareWorkersRateLimiter` — the per-identity `RateLimitIdentityDO` is the counter: one atomic check-and-consume per request, one global count per source address (D-018-1).
  - `InMemoryRateLimiter` — the self-hosted relay's counter, a sliding window per source address in the relay process's memory (D-018-2).
- `RateLimiterFactory` — selects the implementation from the deployment's configuration (T18.2-5).
- One admission stage (D-018-1): `checkAdmission` runs `RateLimiter.check()`, whose sliding-window counter is the only stage; a trip is a 429 with the window's `Retry-After`, and a counter error fails that one request like any backend error. tRPC procedures and raw routes call only `checkAdmission`. The relay's channel carries no rate limit: it forwards each device's frames as fast as the machine drains them, and backpressure on the channel bounds both directions.
- tRPC v11 middleware `rateLimitProcedure({ endpoint })` wired per the §Endpoint Wiring Ownership table (D-018-3).
- `Retry-After` on every 429 ([Spec-019 §Overflow Response](../specs/019-rate-limiting-policy.md#overflow-response)); an allowed response carries no rate-limit header.

## Non-Goals

- **Local daemon IPC rate limiting.** [Spec-019 §Scope](../specs/019-rate-limiting-policy.md#scope) explicitly excludes the daemon path (trusted by socket reachability). This plan consumes that exclusion; no IPC-side middleware is authored, and the daemon's `no-restricted-imports` lint rule enforces it (T18.3-3).
- **A count on any other route.** A route a credential reaches is called only by the person's own machines and devices, each authenticating as the person ([Spec-019 §Non-Goals](../specs/019-rate-limiting-policy.md#non-goals)), so the middleware wraps the sign-in routes and nothing else.
- **Per-model / per-provider token-level throttling.** Out of [Spec-019 §Non-Goals](../specs/019-rate-limiting-policy.md#non-goals).
- **Billing metering.** Nothing is billed: the relay serves its one owner.
- **Admin credentials for more than one person, and a service principal.** The relay has one owner, and this plan adds no admin surface.
- **Custom rate-limit algorithms beyond sliding window.** Fixed-window and token-bucket are not implemented; [Spec-019 §Implementation Notes](../specs/019-rate-limiting-policy.md#implementation-notes) prefers sliding windows.
- **Bans and automatic escalation.** A limit refuses only for its own window: no identity is blocked beyond it, and nothing is banned. A stolen device's token is answered by revoking that device through Remote Control's own control ([Spec-027](../specs/027-remote-control.md)); the relay holds one live connection per device key and flags a key that keeps displacing itself.

## Preconditions

The plan builds on:

- The control plane's stable middleware-mount surface (PASETO middleware + router host) that `rateLimitProcedure` mounts onto (CP-018-1).

## Target Areas

- `packages/contracts/src/rate-limiter.ts` — **created by this plan.** The wire devices read: the `RateLimitResponse` 429 envelope + `RateLimitResponseSchema` (Zod).
- `packages/control-plane/src/rate-limit/` — **created by this plan.**
  - `limiter.ts` — `RateLimitEndpointGroup`, `RateLimitCheckRequest`/`RateLimitCheckResponse` and the `RateLimiter` interface; the control plane and the self-host relay node, which imports the control plane's limiter, are their only users.
  - `endpoint-groups.ts` — canonical endpoint-group → `{ limit, periodSeconds }` config module transcribed from the Spec-019 registry — the one source of the limit for both implementations (T18.2-1).
  - `cloudflare-limiter.ts` — the Workers implementation over the per-identity Durable Object (D-018-1).
  - `identity-durable-object.ts` — the `RateLimitIdentityDO` class and its Worker-side stub resolver (Workers only).
  - the self-hosted relay's in-memory counter (T18.2-4).
  - `factory.ts` — the implementation selector.
  - `enforcement-pipeline.ts` — `createAdmissionCheck`, which returns `checkAdmission` (D-018-1).
  - `limiter-contract-suite.ts` — exported shared contract suite (`describeRateLimiterContract`), the I-018-2 parity proof the self-host relay node re-runs.
- `packages/control-plane/src/middleware/rate-limit.ts` — **created by this plan.** tRPC middleware `rateLimitProcedure`.
- `packages/control-plane/src/server/host.ts` — **extended by this plan (export-only edit):** re-export `RateLimitIdentityDO` from the Worker entry module (Cloudflare requires DO classes exported from the deployed script), inside the CP-018-1 stable-mount seam.
- `eslint.config.mjs` — a `no-restricted-imports` entry scoped to `packages/runtime-daemon/**` that keeps the daemon from importing the relay's rate-limit code (T18.3-3).
- `docs/architecture/contracts/api-payload-contracts.md` — carries the `RateLimitResponse` (symbol anchor: `interface RateLimitResponse` under §Error Responses), and the `RateLimitCheckRequest` and `RateLimitCheckResponse`. T18.1-2 verifies shape parity against the typed exports at implementation time and lands only drift fixes.
- `docs/architecture/contracts/error-contracts.md` — carries the canonical envelope under §Rate Limiting. T18.1-3 verifies code-table parity at implementation time and lands only drift fixes.
- `docs/architecture/deployment-topology.md` §Rate Limiting By Deployment — the Workers relay counts in the per-identity Durable Object, the self-hosted relay in its process's memory (D-018-1, D-018-2).
- `wrangler.toml` (Workers; extended at Phase-2 landing) — declare (a) `[[durable_objects.bindings]]` `{ name = "RATE_LIMIT_IDENTITY", class_name = "RateLimitIdentityDO" }` and (b) a `[[migrations]]` entry adding `RateLimitIdentityDO` to `new_sqlite_classes`.

## Data And Storage Changes

This plan owns no table: every piece of rate-limit state is ephemeral and bounded by its window (I-018-3). Erasure needs no step here — the per-identity DO deletes its own storage once its windows pass, and the self-hosted relay's counts live only in its process's memory, each dropped once its window has passed.

### Durable Object: `RateLimitIdentityDO` (Workers only)

- One DO instance per source address, keyed by `idFromName` of the address in its canonical form (D-018-4).
- Persisted state (survives worker restart) via DO's built-in storage API: the in-window request times for each endpoint group — the counter of record, which gives the authoritative `remaining`/`resetAt` (D-018-1).
- **Single-alarm scheduling:** Cloudflare permits one scheduled alarm per object and `setAlarm` overrides. On every state change, re-arm to the earliest per-group window expiry. `alarm()` drops expired per-group window state and re-arms if live state remains; once every window has expired it calls `storage.deleteAll()` (no per-identity residue survives) and the DO idles out with no alarm. Every registry window is 60 seconds, so an address's state is gone within a minute of its last request.
- RPC surface = `checkAndConsume`, the atomic per-group check and consume: it refuses over-threshold and returns the authoritative `remaining`/`resetAt` in the same round trip. The Worker-side stub resolver lives in the same module.

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

Code-level home: `packages/contracts/src/rate-limiter.ts`, which T18.1-1 creates, exports the interface + `RateLimitResponseSchema` so its consumers assert against a typed export instead of a doc shape. The api-payload-contracts.md shape is anchored by symbol (`interface RateLimitResponse` under §Error Responses); T18.1-2 verifies doc-vs-export parity at implementation time. Every refusal carries both timing fields, so `RateLimitResponseSchema` requires both and an envelope missing either fails parse (T18.1-4).

## API And Transport Changes

### `RateLimiter` contract (new, owned by this plan)

```ts
// packages/control-plane/src/rate-limit/limiter.ts
// Union of the Key column of Spec-019 §Canonical Endpoint Group Registry (D-018-3).
export type RateLimitEndpointGroup = "auth.endpoint";

export interface RateLimitCheckRequest {
  identity: string; // the caller's source address, canonical form per §Identity Resolution
  endpoint: RateLimitEndpointGroup;
}

export interface RateLimitCheckResponse {
  allowed: boolean;
  remaining: number;
  resetAt: string; // ISO 8601
  limit: number; // total threshold for this window
}

export interface RateLimiter {
  check(req: RateLimitCheckRequest): Promise<RateLimitCheckResponse>;
}
```

- `RateLimiter` and its check types live in the control plane's package: only the relay's control plane and the self-host relay node check a limit, and the daemon never does ([Spec-019 §Scope](../specs/019-rate-limiting-policy.md#scope)). The `RateLimitResponse` envelope, which devices read, will ship in `packages/contracts/src/rate-limiter.ts` as interface + Zod schema per the `runtime-node/registration.ts` wire-shape convention.

### Admission pipeline (D-018-1)

```ts
// packages/control-plane/src/rate-limit/enforcement-pipeline.ts
export interface AdmissionResult {
  admitted: boolean; // false = a counter trip: 429 with the envelope and headers built from `check`
  check: RateLimitCheckResponse;
}

export type AdmissionCheck = (req: RateLimitCheckRequest) => Promise<AdmissionResult>;

export function createAdmissionCheck(deps: {
  limiterFor: (endpoint: RateLimitEndpointGroup) => RateLimiter;
}): AdmissionCheck; // what middleware and raw routes consume as `checkAdmission`
```

One stage on every enforced transport (I-018-1): tRPC procedures and raw routes call `checkAdmission`, whose only stage is the sliding-window counter inside `limiter.check()`; the relay's channel carries no rate limit. An error from `limiter.check()` propagates and fails that one request like any backend error.

### Identity resolution (D-018-4, D-018-5)

- **The source address is the identity.** The check keys on the caller's source address alone (D-018-5).
- **Canonical form (D-018-4):** IPv4 exact dotted-quad / IPv6 normalized to its /64 prefix (lowercase, compressed).
- **Client IP provenance.** Workers: the Cloudflare-set `CF-Connecting-IP` header. Self-host: leftmost-untrusted-hop `X-Forwarded-For`, honored ONLY under explicit Fastify trust-proxy configuration for the Caddy hop (the self-host relay node propagates the header; the `trustProxy` setting is its server bootstrap). A request with no resolvable address is refused 400 rather than rate-limited into a shared bucket.

### tRPC middleware surface (mounts onto the control-plane host per CP-018-1)

```ts
// packages/control-plane/src/middleware/rate-limit.ts
export const rateLimitProcedure = (opts: { endpoint: RateLimitEndpointGroup }) =>
  t.middleware(async ({ ctx, next }) => {
    const identity = resolveIdentity(ctx); // D-018-4
    const admission = await ctx.checkAdmission({ identity, endpoint: opts.endpoint });
    if (!admission.admitted) {
      throw tooManyRequests(rateLimitResponseFrom(admission.check)); // 429 + canonical envelope + headers
    }
    return next(); // an allowed response carries no rate-limit header
  });
```

- Usage on a procedure: `t.procedure.use(rateLimitProcedure({ endpoint: 'auth.endpoint' }))`. The tRPC v11 middleware chaining model is documented in [tRPC v11 middlewares](https://trpc.io/docs/server/middlewares) (uses `.use()` with opts `{ ctx, path, type, input, getRawInput, next }`).
- Header policy: `Retry-After` on every 429, and none on an allowed response.

### Retry-After on 429 responses

A 429 response must set:

- `Retry-After: <seconds>` — formula: `max(0, ceil((resetAt - now) / 1000))`. On both implementations `resetAt` is "the time the oldest counted request ages out of the window" (the oldest in-window hit's timestamp plus the window duration), read from the DO's window state on the Workers relay (D-018-1).

## Invariants

| ID | Invariant | Verified by |
| --- | --- | --- |
| I-018-1 | Every enforced transport admits through one stage: tRPC procedures and raw routes through `checkAdmission`, whose only stage is the sliding-window counter. The daemon IPC path is reachable by no admission stage. | T18.3-1 pipeline unit tests; the daemon's `no-restricted-imports` lint rule (T18.3-3). |
| I-018-2 | Both `RateLimiter` implementations enforce the same limit and expose identical `check()` semantics; selection is configuration-only. | `limiter-contract-suite.ts` (T18.2-6) green against both implementations in CI; the self-host relay node re-runs it (CP-018-2). |
| I-018-3 | Rate-limit state is ephemeral and bounded by its window: sliding-window counters live in the per-identity DO's window state or in the self-hosted relay's process memory; no table this plan owns holds rate-limit state. | DO restart-persistence and full-expiry eviction tests (T18.2-2); the in-memory counter's window-expiry test (T18.2-4). |
| I-018-4 | The check request/response and the 429 `RateLimitResponse` envelope have exactly one canonical shape — identical in [Spec-019 §Interfaces And Contracts](../specs/019-rate-limiting-policy.md#interfaces-and-contracts), error-contracts.md, api-payload-contracts.md, and code: the check shapes in `packages/control-plane/src/rate-limit/limiter.ts`, the envelope in `packages/contracts/src/rate-limiter.ts`. | T18.1-2/T18.1-3 parity verification at implementation; T18.1-4 schema tests (the full envelope parses; an envelope missing a field or half-timed is rejected); cross-doc drift checked at review. |

## Cross-Plan Obligations

| ID | Direction | Counterparty | Obligation | Anchor |
| --- | --- | --- | --- | --- |
| CP-018-1 | consumes ← | the control-plane host | The stable tRPC middleware-mount surface that `rateLimitProcedure` mounts onto; the host authors no rate-limit **middleware** task — `rateLimitProcedure` authorship stays here. The DO class export is an export-only edit inside the same stable-mount seam. | [Plan-018 §Target Areas](#target-areas) |
| CP-018-2 | provides → | [Plan-025](./025-remote-control.md)'s self-host relay node | `RateLimiter` contract + the in-memory implementation + `createAdmissionCheck`, instantiated not re-implemented; the exported contract suite at `packages/control-plane/src/rate-limit/limiter-contract-suite.ts` (the relay node re-runs it). | [Plan-025 §Phase 3 — The relay and the channel](./025-remote-control.md#phase-3--the-relay-and-the-channel) |

### Endpoint wiring ownership (D-018-3)

`rateLimitProcedure` is NOT applied by iterating the spec registry; ownership is explicit:

| Endpoint group (canonical key) | Procedure owner | Wiring owner + mechanism |
| --- | --- | --- |
| `auth.endpoint` | the sign-in and token-refresh procedures, the four WebAuthn ceremony routes (`WebAuthnRegistrationOptionsIssue`, `WebAuthnRegistrationVerify`, `WebAuthnAuthenticationOptionsIssue`, `WebAuthnAuthenticationVerify`) and the device-code page's `Create an account` arm ([Plan-015](./015-hosted-account-and-identity.md)), and the device-linking procedures ([Plan-025](./025-remote-control.md) Phase 5) | Plan-018 T18.3-3 |

## Design Decisions

| ID | Decision |
| --- | --- |
| D-018-1 | On the Workers relay the per-identity `RateLimitIdentityDO` is the counter: one atomic check-and-consume per request, one global count per source address, and the window the headers report (`remaining`/`resetAt`). The 10–50 ms DO round trip lands only on the sign-in routes, which see a handful of requests per device per day. `checkAdmission` wraps `RateLimiter.check()` on both implementations. |
| D-018-2 | The self-hosted relay is one process, so it counts in that process's memory: one sliding window per source address, dropped once its window has passed. |
| D-018-3 | [Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) is the single limit enumeration with canonical keys; the §Endpoint Wiring Ownership table assigns its row. |
| D-018-4 | Canonical source address (IPv4 exact / IPv6 /64); IP provenance = `CF-Connecting-IP` (Workers) / `X-Forwarded-For` under explicit trust-proxy (self-host relay node); missing address → 400. |
| D-018-5 | The check keys on the caller's source address alone: the sign-in routes are reached before the caller holds a credential. |

## Implementation Phase Sequence

### Phase 1 — Contracts + Doc Parity

**Goal:** land the typed contract surface and the contracts-doc parity check so every later phase builds against canonical shapes.

**Precondition:** none.

The phase builds on the shipped contracts package.

#### Tasks

- **T18.1-1 — `packages/control-plane/src/rate-limit/limiter.ts` and `packages/contracts/src/rate-limiter.ts`.** In the control plane's file, author `RateLimitEndpointGroup` (registry-key union, D-018-3), `RateLimitCheckRequest`, `RateLimitCheckResponse` and the `RateLimiter` interface. In contracts, author the `RateLimitResponse` wire envelope + `RateLimitResponseSchema` (Zod; both timing fields required, [Spec-019 §Overflow Response](../specs/019-rate-limiting-policy.md#overflow-response)); the module is reached at its own subpath, `@ai-sidekicks/contracts/rate-limiter`, with nothing to re-export.
  - **Spec coverage:** Spec-019 §Interfaces And Contracts (RateLimitCheck shape), Spec-019 §Deployment-Aware Abstraction (same programmatic interface in both deployments), Spec-019 §Implementation Notes (single RateLimiter interface), Spec-019 §Overflow Response (standard RateLimitResponse envelope)
  - **Verifies invariant:** I-018-4
  - **Consumes:** [Spec-019 §Canonical Endpoint Group Registry](../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) (a doc contract); zod (workspace dep).
- **T18.1-2 — api-payload-contracts.md parity verification.** Verify, field-for-field, that each shape the contracts doc carries — the `interface RateLimitResponse` (timing pair required) under §Error Responses; the `RateLimitCheckRequest` and `RateLimitCheckResponse` — matches the T18.1-1 typed exports, and land ONLY drift fixes. No-drift outcome = no doc edit; record the parity check in the PR description.
  - **Spec coverage:** Spec-019 §Interfaces And Contracts (api-payload-contracts holds the typed request/response schemas), Spec-019 §Overflow Response (standard envelope)
  - **Verifies invariant:** I-018-4
  - **Consumes:** api-payload-contracts.md's rate-limit shapes; error-contracts.md §Rate Limiting envelope; T18.1-1 exports (same Phase).
- **T18.1-3 — error-contracts.md parity verification.** The §Rate Limiting table carries the canonical envelope. This task verifies every code the implementation emits resolves to a registered row and lands ONLY drift fixes. No-drift outcome = no doc edit; record the parity check in the PR description.
  - **Spec coverage:** Spec-019 §Interfaces And Contracts (error-contracts holds error response schemas and error codes)
  - **Verifies invariant:** I-018-4 (registry side)
  - **Consumes:** error-contracts.md §Rate Limiting table.
- **T18.1-4 — Schema tests.** In `packages/contracts/src/__tests__/`, `RateLimitResponseSchema` parses the full envelope and rejects an envelope missing `retryAfter` or `resetAt`; in the control plane's rate-limit tests, the `RateLimitEndpointGroup` union matches the registry's keys.
  - **Spec coverage:** Spec-019 §Overflow Response (canonical envelope), Spec-019 §Interfaces And Contracts (check shape)
  - **Verifies invariant:** I-018-4
  - **Consumes:** T18.1-1 exports (same Phase).

### Phase 2 — Backends

**Goal:** both `RateLimiter` implementations, the per-identity Durable Object, the factory, and the parity proof (shared contract suite).

**Precondition:** Phase 1 shipped.

#### Tasks

- **T18.2-1 — `endpoint-groups.ts`.** Canonical endpoint-group → `{ limit, periodSeconds }` table transcribed from the Spec-019 registry; exported as the single config source for both implementations and for header values.
  - **Spec coverage:** Spec-019 §Canonical Endpoint Group Registry (registry table header — single enumeration), Spec-019 §Deployment-Aware Abstraction (the same limit)
  - **Verifies invariant:** I-018-2
  - **Consumes:** `RateLimitEndpointGroup` ← T18.1-1.
- **T18.2-2 — `identity-durable-object.ts`.** `RateLimitIdentityDO` class (per-group window storage + single-alarm scheduling per §Data And Storage Changes; RPC = `checkAndConsume`) + the Worker-side stub resolver (`idFromName` of the canonical source address). Export the DO class from `packages/control-plane/src/server/host.ts` (export-only edit, CP-018-1 seam). DO-restart persistence test (storage survives; alarm re-arms) + full-expiry eviction test (alarm `deleteAll`s storage once every window has passed — I-018-3) + counter row (the 21st `auth.endpoint` consume from one address in 60 s refused atomically whichever location sent it, `resetAt` = window expiry).
  - **Spec coverage:** Spec-019 §Deployment-Aware Abstraction (sign-in routes counted once in the per-identity Durable Object), Spec-019 §State And Data Implications (counters not persisted beyond their window)
  - **Verifies invariant:** I-018-3
  - **Consumes:** Cloudflare DO runtime (`@cloudflare/workers-types` for types); wrangler DO binding + migration declaration (§Target Areas wrangler deliverable).
- **T18.2-3 — `cloudflare-limiter.ts`.** `CloudflareWorkersRateLimiter implements RateLimiter` (D-018-1): call the address's DO `checkAndConsume({ group, limit, windowSeconds })` — the Worker passes the registry threshold and the DO atomically evaluates and consumes the group's window, refusing over-threshold with authoritative `remaining`/`resetAt`. Because the DO for an address is one object worldwide, this is one global count. A DO round-trip failure is thrown from `check()`, so it fails that one request.
  - **Spec coverage:** Spec-019 §Deployment-Aware Abstraction (Workers = the per-identity Durable Object), Spec-019 §Fallback Behavior (a counter error fails that one request), Spec-019 §Acceptance Criteria (one global count on the sign-in routes)
  - **Verifies invariant:** I-018-2
  - **Consumes:** `RateLimiter` ← T18.1-1; `endpoint-groups.ts` ← T18.2-1; `RateLimitIdentityDO` ← T18.2-2.
- **T18.2-4 — `InMemoryRateLimiter`.** The self-hosted relay's implementation of `RateLimiter` for the self-hosted relay's one process (D-018-2): one sliding window per source address in memory, its limit and period from `endpoint-groups.ts`. Each check consumes one; a trip denies with `remaining: 0` and the window's `resetAt`; an address's window is dropped once it has passed. The self-host relay node is its production instantiator (CP-018-2). Its tests: the window-expiry row (an address's state is gone once its window has passed — I-018-3).
  - **Spec coverage:** Spec-019 §Deployment-Aware Abstraction (the self-hosted relay counts in its process's memory), Spec-019 §Implementation Notes (sliding window), Spec-019 §Acceptance Criteria (the same limit, via the shared suite)
  - **Verifies invariant:** I-018-2, I-018-3
  - **Consumes:** `RateLimiter` ← T18.1-1; `endpoint-groups.ts` ← T18.2-1.
- **T18.2-5 — `factory.ts`.** `createRateLimiterFactory(config)` with the discriminated config (`{ kind: 'workers'; env } | { kind: 'node' }`), returning `{ forEndpoint(endpoint: RateLimitEndpointGroup): RateLimiter }`: `workers` → `CloudflareWorkersRateLimiter` over the injected `env`, never `process.env`; `node` → `InMemoryRateLimiter`. Table-driven tests: each kind yields its implementation.
  - **Spec coverage:** Spec-019 §Deployment-Aware Abstraction (swap via deployment configuration), Spec-019 §Implementation Notes (configuration selects the implementation at startup)
  - **Verifies invariant:** I-018-2
  - **Consumes:** T18.2-3 + T18.2-4 (same Phase).
- **T18.2-6 — `limiter-contract-suite.ts` + runners.** Export `describeRateLimiterContract(makeLimiter: () => Promise<RateLimiter>)` — scenario set: under-limit allow; at-limit deny; header-source fields present + internally consistent; a denial reports the window's `resetAt` and the first check after it is allowed; window expiry re-allow; per-address isolation. Runners: one against the in-memory counter, and `cloudflare-rate-limiter.contract.test.ts` (DO-storage fake — `@cloudflare/workers-types` is types-only; fidelity caveat recorded: local emulation does not reproduce production edge distribution; I-018-2 parity is asserted at the contract level, not edge-distribution level).
  - **Spec coverage:** Spec-019 §Deployment-Aware Abstraction (the same limit — the parity proof), Spec-019 §Acceptance Criteria
  - **Verifies invariant:** I-018-2
  - **Consumes:** all Phase-2 tasks; the self-host relay node re-runs this suite (CP-018-2).

### Phase 3 — Enforcement Wiring

**Goal:** the admission check, the tRPC middleware, and the wiring of the sign-in routes.

**Precondition:** Phase 2 shipped.

#### Tasks

- **T18.3-1 — `rate-limit/enforcement-pipeline.ts`.** `createAdmissionCheck` per §API And Transport Changes — returns `checkAdmission`: `limiter.check` for the request's endpoint. Unit tests: an allowed check → `admitted: true` with the window state; a counter trip → `admitted: false` carrying the check the 429 envelope is built from; a limiter error propagates.
  - **Spec coverage:** Spec-019 §Overflow Response (429 + Retry-After on refusal), Spec-019 §Fallback Behavior
  - **Verifies invariant:** I-018-1
  - **Consumes:** `RateLimiter` via factory ← T18.2-5.
- **T18.3-2 — `middleware/rate-limit.ts` (CREATE).** `rateLimitProcedure` per §API And Transport Changes: the source address (D-018-4), 429 with the canonical envelope. Unit tests: a request with no resolvable address → 400; an allowed request carries no rate-limit header, and a 429 carries `Retry-After`.
  - **Spec coverage:** Spec-019 §Default Behavior, Spec-019 §Overflow Response (429; Retry-After)
  - **Verifies invariant:** I-018-1, I-018-4
  - **Consumes:** `checkAdmission` ← T18.3-1; the CP-018-1 mount surface ← the control-plane host (§Preconditions).
- **T18.3-3 — Wire the sign-in routes + the daemon's import boundary.** Apply `rateLimitProcedure({ endpoint: 'auth.endpoint' })` per the §Endpoint Wiring Ownership table to the sign-in, token-refresh and device-linking procedures, the four WebAuthn ceremony routes and the device-code page's `Create an account` arm, inside the CP-018-1 mount seam (export-only host edit), and call `checkAdmission` from any of them served as a raw route. Add a `no-restricted-imports` entry to `eslint.config.mjs`, scoped to `packages/runtime-daemon/**`, whose patterns refuse any import of the control plane's `middleware` and `rate-limit` modules, so `rateLimitProcedure` cannot reach the daemon; type-only `packages/contracts` imports stay allowed. `pnpm lint` enforces it.
  - **Spec coverage:** Spec-019 §Acceptance Criteria (`auth.endpoint`; daemon exclusion), Spec-019 §Scope (daemon scope exclusion)
  - **Verifies invariant:** I-018-1 (daemon-exclusion companion)
  - **Consumes:** `rateLimitProcedure` ← T18.3-2; the sign-in, token-refresh and device-linking procedures (Plan-015, Plan-025 Phase 5); the WebAuthn ceremony routes (Plan-015 Phase 6) and the `Create an account` arm (Plan-015 T5.4).

### Phase 4 — Verification

**Goal:** the AC-anchored verification suite.

**Precondition:** Phase 3 shipped.

#### Tasks

- **T18.4-1 — AC-anchored integration verification (`packages/control-plane/src/rate-limit/__tests__/` (CREATE)).** Named rows: (1) the 21st `auth.endpoint` request from one address in 60 s → 429 with `Retry-After` per formula, and the first request after the window frees → allowed; (2) in the Workers test project this task adds, 21 `auth.endpoint` requests from one address split across two simulated edge locations → the 21st refused; (3) a counter error fails that one request, and the next request is counted.
  - **Files:** `packages/control-plane/vitest.config.ts` (EXTEND — its one node project becomes two Vitest `projects`: the node project, and a Workers project, a `defineProject` carrying the `cloudflareTest()` plugin from `@cloudflare/vitest-plugin` with `wrangler: { configPath: "./wrangler.toml" }`, so row (2) runs in `workerd` with the `RATE_LIMIT_IDENTITY` Durable Object binding Phase 2 declares; the node project excludes the files the Workers project includes, so each row runs in one project only), `packages/control-plane/package.json` (EXTEND — `@cloudflare/vitest-plugin` as a devDependency). The plugin is Cloudflare's own Vitest integration for Workers and replaces `@cloudflare/vitest-pool-workers`; it requires Vitest 4.1 or later, which the workspace's testing catalog meets, and it runs the test inside the Workers runtime against the Worker's own bindings, which a node project cannot.
  - **Spec coverage:** Spec-019 §Acceptance Criteria, Spec-019 §Fallback Behavior, Spec-019 §Example Flows (the auth-endpoint example)
  - **Verifies invariant:** I-018-1
  - **Consumes:** all prior phases.

## Parallelization Notes

- Phase 1 lands first; T18.1-1 is the root contract; T18.1-2/-5 (doc parity verification) and T18.1-4 follow it in parallel.
- Phase 2: T18.2-1 first; then T18.2-2 (the DO) and T18.2-4 (the in-memory counter) in parallel; T18.2-3 after T18.2-2; T18.2-5 after the limiters; T18.2-6 last (drives everything).
- Phase 3: T18.3-1 → T18.3-2; T18.3-3 after both.
- Phase 4: T18.4-1.

## Test And Verification Plan

The per-task test obligations live in each `#### Tasks` row above. Summary by layer:

- **Unit (`packages/control-plane/src/rate-limit/__tests__/`, `src/middleware/__tests__/`):** factory rows; DO single-alarm re-arm, restart persistence, full-expiry eviction and the counter; the in-memory counter's window expiry; pipeline rows; middleware address and header rows.
- **Contracts (`packages/contracts/src/__tests__/`):** full envelope acceptance / rejection of an envelope missing a field or half-timed (T18.1-4). The registry-key union snapshot runs with the control plane's rate-limit tests (T18.1-4).
- **Contract parity suite (`limiter-contract-suite.ts`):** the I-018-2 proof, run against both implementations in CI and re-run by the self-host relay node (T18.2-6; CP-018-2).
- **Integration (`packages/control-plane/src/rate-limit/__tests__/`):** the AC-anchored rows of T18.4-1.
- **Structural:** the daemon's import boundary is an ESLint `no-restricted-imports` rule (T18.3-3), checked by `pnpm lint`; no test parses sources for it.

## Rollout Order

1. Land Phase 1 (contracts + doc parity).
2. Land Phase 2 implementations; contract suite green against both.
3. Land Phase 3 wiring (tRPC).
4. Land Phase 4 verification suite.

## Rollback Or Fallback

- **Counter outage:** a failing counter fails the sign-in requests it touches, like any backend error; no route a credential reaches is counted, so the person's signed-in devices keep working.
- **Rollback to pass-through:** the middleware can be uninstalled by removing the `.use(rateLimitProcedure(...))` on each procedure. This is a code change.

## Risks And Blockers

- **Durable Object round trip.** Every sign-in route request on the Workers relay waits on one DO round trip (10–50 ms). The routes see a handful of requests per device per day, so it is accepted (D-018-1).
- **Counts reset with the self-hosted relay's process.** The in-memory windows start empty when the relay process restarts.

## Done Checklist

- The `RateLimiter` interface, its check types and `RateLimitEndpointGroup` live in `packages/control-plane/src/rate-limit/limiter.ts`; `RateLimitResponse`/`RateLimitResponseSchema` live in `packages/contracts/src/rate-limiter.ts`; all with the shapes defined in §API And Transport Changes.
- `CloudflareWorkersRateLimiter` and the in-memory counter both pass the shared contract suite (`limiter-contract-suite.ts`).
- `RateLimiterFactory` selects the implementation from the deployment's configuration.
- `RateLimitIdentityDO` is exported from the Worker entry module, declared in wrangler `[[durable_objects.bindings]]` + `[[migrations]]`, holds the per-group windows with single-alarm scheduling and full-expiry `deleteAll` self-eviction (I-018-3), and counts each source address once worldwide (Spec-019 §Acceptance Criteria).
- Every enforced transport admits through one stage (I-018-1): tRPC procedures and raw routes through `checkAdmission`.
- `rateLimitProcedure` is wired on the sign-in, token-refresh and device-linking procedures, and on nothing else.
- A counter error fails only the request it occurred on.
- 429s include `Retry-After` computed as `max(0, ceil((resetAt - now) / 1000))`; allowed responses carry no rate-limit header.
- api-payload-contracts.md parity verified against the typed exports (`RateLimitResponse`, timing pair required; `RateLimitCheckRequest`; `RateLimitCheckResponse`; `ErrorNamespace` + `ratelimit`; T18.1-2 lands only drift fixes), and every code the implementation emits resolves to a registered error-contracts.md row (T18.1-3).
- Local daemon IPC path is NOT rate-limited — enforced by the daemon's `no-restricted-imports` lint rule, not by review.

## Dependencies

Strictly **downstream of the control-plane host** for the CP-018-1 tRPC mount, and **upstream of the self-host relay node** (which instantiates the in-memory counter + `createAdmissionCheck` inside its compose-deployed process, CP-018-2). Its tasks land in the `sign-in-rate-limiter` unit, and T18.3-3 also in `passkey-relying-party`, `devices-and-push` and `control-plane-account`, each for the routes it adds ([cross-plan-dependencies §Remote Control](../architecture/cross-plan-dependencies.md#remote-control)).

## References

- [Spec-019: Rate Limiting Policy](../specs/019-rate-limiting-policy.md)
- [ADR-013: tRPC Control-Plane API](../decisions/013-trpc-control-plane-api.md)
- [ADR-019: V1 Deployment Model And OSS License](../decisions/019-v1-deployment-model-and-oss-license.md)
- [ADR-010: Tokens, Passkeys And The Remote Channel](../decisions/010-tokens-passkeys-and-the-remote-channel.md)
- [Deployment Topology §Rate Limiting By Deployment](../architecture/deployment-topology.md#rate-limiting-by-deployment)
- [Cloudflare Durable Objects: Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [tRPC v11 middlewares](https://trpc.io/docs/server/middlewares)
