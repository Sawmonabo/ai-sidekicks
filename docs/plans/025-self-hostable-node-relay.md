# Plan-025: Self-Hostable Node Relay

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `025` |
| **Slug** | `self-hostable-node-relay` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude Opus 4.7` |
| **Spec** | [Spec-025: Self-Hostable Node Relay](../specs/025-self-hostable-node-relay.md) |
| **Required ADRs** | [ADR-020: V1 Deployment Model And OSS License](../decisions/020-v1-deployment-model-and-oss-license.md); [ADR-008: Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md); [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md); [ADR-004: SQLite Local State, Postgres Control Plane](../decisions/004-sqlite-local-state-and-postgres-control-plane.md) |
| **Dependencies** | Plan-008 (v2 relay wire protocol — this plan *deploys* the protocol; all handshake / session-join / message-framing logic is authored upstream in Plan-008 and imported here); Plan-018 (PASETO v4.public access-token issuance and key-publication surface — the relay is the verifier side of what Plan-018 issues; both sides share `packages/crypto-paseto/` created by this plan); Plan-021 (`RateLimiter` contract, `PostgresRateLimiter` implementation, `AdminBansStore` — this plan instantiates them inside the self-host process) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Ship the Node.js deployment package that hosts Spec-008's v2 relay protocol for operators running their own control-plane per ADR-020 Option 1 (free self-host) and Option 2 (self-host-your-own-relay). Execute the technology choices already locked in [Spec-025](../specs/025-self-hostable-node-relay.md) — Fastify v5 + `@fastify/websocket`, Node.js 22 LTS, Postgres 17, Caddy for TLS termination, in-house PASETO v4.public on `@noble/curves` / `@noble/ciphers`, `rate-limiter-flexible` Postgres backend behind Plan-021's abstraction — and deliver: a single runnable process, a shared PASETO primitive package, a reference `docker-compose.yml`, an operator runbook, and the supply-chain hardening baseline (npm provenance, `--ignore-scripts`, `npm audit signatures`).

The protocol-level invariant from Spec-025 §Required Behavior governs acceptance: a daemon must not be able to distinguish the Node self-host relay from the Cloudflare Workers hosted backend at the protocol level. This plan therefore consumes — not re-implements — the v2 protocol surfaces from Plan-008.

## Scope

- `packages/crypto-paseto/` — **new, owned by this plan.** Shared PASETO v4.public primitives (sign, verify, key management) built on `@noble/curves` (Ed25519) + `@noble/ciphers`. Consumed by both this plan (verifier) and Plan-018 (issuer). Ships with the PASETO RFC conformance vector test suite.
- `packages/relay-node/` — **new, owned by this plan.** The Node.js self-host relay process: Fastify v5 bootstrap, `@fastify/websocket` frame handling, PASETO verification middleware, Plan-021 rate-limiter wiring, graceful-shutdown lifecycle, structured-JSON logging, operator HTTP surface (`/healthz`, `/readyz`, `/metrics`).
- `deploy/self-host/` — **new, owned by this plan.** Reference deployment assets: `docker-compose.yml` (Compose Spec, no `version:` field, `depends_on: { condition: service_healthy, restart: true }`), `Caddyfile`, `.env.example`, operator README outline.
- `packages/relay-node/Dockerfile` — **new, owned by this plan.** Distroless or Debian-slim base, non-root UID/GID, read-only root FS where Node.js permits.
- `.github/workflows/relay-node-release.yml` — **new, owned by this plan.** Build + publish container image to GHCR with provenance attestations; publish npm package with provenance.
- `docs/operator-guide/self-host-relay.md` — **new, owned by this plan.** Operator-facing runbook: deployment flow, env var reference, the 500-req/s rate-limiter ceiling, PASETO key rotation procedure, Postgres 17 minimum, graceful-shutdown behavior.

## Non-Goals

- **v2 protocol definition.** Spec-008 is authoritative. Any change to handshake / session-join / message-framing lands in Plan-008, not here. This plan imports from Plan-008's produced TypeScript surface.
- **Cloudflare Workers backend.** Hosted deployment ships separately per [Deployment Topology](../architecture/deployment-topology.md). The runtime bundle this plan produces must contain zero Cloudflare-specific code paths (enforced in acceptance criteria).
- **Kubernetes Helm chart.** Out of scope per Spec-025 §Non-Goals and ADR-020 deployment-options commitment. Operators who want Kubernetes run Compose-in-Kube or author their own Helm chart; no V1 support.
- **Enterprise operator features.** OIDC/SAML SSO, HSM-backed signing keys, SOC 2 artifacts, offline-root signing — all V1.1+. BL-060 tracks V1 secure-by-default; this plan consumes BL-060's posture.
- **Redis backend for rate-limiter-flexible.** Spec-025 §Fallback Behavior notes Postgres backend saturates at ~500 req/s per namespace; operators exceeding that shard the namespace or adopt Redis post-V1. This plan does not ship Redis wiring.
- **New protocol features in self-host only.** ADR-020 feature-parity commitment: protocol changes ship to both deployments or to neither.
- **Grafana dashboard.** Spec-025 §Open Questions leans toward shipping a minimal reference dashboard; that is deferred to post-V1. This plan ships `/metrics` in Prometheus text format only.

## Preconditions

- [x] Spec-025 is approved and has settled the technology choices (Fastify v5, Caddy, Node 22, Postgres 17, in-house PASETO).
- [x] ADR-020 is accepted — establishes the one-codebase-two-deployments contract this plan satisfies.
- [x] ADR-008 is accepted — defines the transport family the relay hosts.
- [x] ADR-010 is accepted — establishes PASETO v4.public as the token primitive.
- [x] ADR-004 is accepted — establishes Postgres as the shared control-plane persistence.
- [ ] Plan-008 has published the v2 protocol surfaces as importable TypeScript (message schemas, frame codecs, handshake state machine). The protocol must be production-quality before this plan's relay can wire it. If Plan-008 ships the protocol as an internal package under `packages/relay-protocol/`, this plan imports from it; exact package name is Plan-008's choice.
- [ ] Plan-021 has landed: `RateLimiter` contract at `packages/contracts/src/rate-limiter.ts`, `PostgresRateLimiter` implementation at `packages/control-plane/src/rate-limit/postgres-rate-limiter.ts`, `AdminBansStore` + admin-bans routes. This plan instantiates them; no re-implementation.
- [ ] Plan-018 has defined the PASETO issuer's public-key publication surface (how `PASETO_PUBLIC_KEYS` env var is populated by operators rotating through keys). Plan-018 also depends on `packages/crypto-paseto/` this plan creates; the dependency is symmetric but this plan owns the shared primitive package.

## Target Areas

- `packages/crypto-paseto/` — **created by this plan.** Shared PASETO v4.public primitives.
  - `src/v4-public.ts` — `sign(key, payload, footer?)`, `verify(key, token, footer?)`, `generateKeyPair()` — all Ed25519 on `@noble/curves`.
  - `src/key-rotation.ts` — `KeyRing` class that accepts the current and prior public keys and rejects tokens signed outside a configurable rotation window (default 30 min per Spec-025 §Fallback Behavior).
  - `src/test/rfc-vectors.test.ts` — PASETO v4.public conformance vectors from the PASETO spec repo.
- `packages/relay-node/` — **created by this plan.** The relay process.
  - `src/server.ts` — Fastify v5 bootstrap; registers `@fastify/websocket`, auth middleware, rate-limit middleware, operator HTTP routes.
  - `src/auth/paseto-verifier.ts` — consumes `packages/crypto-paseto` `KeyRing`; extracts `sub` claim into `request.participantId`.
  - `src/rate-limit/wire-postgres-limiter.ts` — instantiates Plan-021's `PostgresRateLimiter` for each Spec-021 endpoint group; wires Plan-021's `rateLimitProcedure` middleware into the Fastify routes that mirror the tRPC surface (for control-plane endpoints served by the relay) and `wsRateLimit` into the `@fastify/websocket` message handler.
  - `src/ws/frame-handler.ts` — decodes frames using Plan-008's codec, dispatches via the v2 protocol state machine, runs per-frame rate check before dispatch.
  - `src/ops/health.ts` — `/healthz`, `/readyz` (with Postgres probe), `/metrics` (Prometheus text format).
  - `src/ops/graceful-shutdown.ts` — SIGTERM / SIGINT handler; stops accepting new connections; drains in-flight WS with `SHUTDOWN_DRAIN_TIMEOUT_MS` timeout (default 30s); force-closes with code `1001 Going Away` on timeout.
  - `src/ops/logger.ts` — pino-based structured JSON logger with token-masking redactor at the log-emit boundary (regex strips anything matching PASETO v4.public prefix `v4.public.`).
  - `src/config/env.ts` — env-var parsing with schema validation (`zod`); fails loudly at startup on missing or malformed values.
- `packages/relay-node/Dockerfile` — **created by this plan.** Multi-stage build: builder on `node:22-slim`, runtime on `gcr.io/distroless/nodejs22-debian12` (or `node:22-slim` with a non-root user if distroless causes operator friction).
- `deploy/self-host/docker-compose.yml` — **created by this plan.** Postgres 17 + relay-node + Caddy v2. Compose Spec, no top-level `version:` (deprecated per [Compose Spec 2025](https://docs.docker.com/reference/compose-file/)); `depends_on: { postgres: { condition: service_healthy, restart: true } }` so the relay waits on Postgres and restarts on its recovery.
- `deploy/self-host/Caddyfile` — **created by this plan.** TLS termination via automatic Let's Encrypt; reverse proxy to the relay with correct `X-Forwarded-For` / `X-Forwarded-Proto` handling; HTTP/2 + HTTP/3 defaults.
- `deploy/self-host/.env.example` — **created by this plan.** Template for operator env vars: `POSTGRES_PASSWORD`, `RELAY_PUBLIC_URL`, `PASETO_PUBLIC_KEYS`, `PASETO_ROTATION_WINDOW_MS` (default `1800000` / 30 min per Spec-025 §Fallback Behavior), `RELAY_BIND` (default `0.0.0.0:8787`), `DATABASE_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT` (optional), `LOG_LEVEL` (default `info`), `SHUTDOWN_DRAIN_TIMEOUT_MS` (default `30000`), `AIS_RATELIMIT_BACKEND=postgres`, `AIS_RATELIMIT_FAILOPEN_SECONDS` (default `60`).
- `docs/operator-guide/self-host-relay.md` — **created by this plan.** Operator-facing runbook.
- `.github/workflows/relay-node-release.yml` — **created by this plan.** Tags → `npm publish --provenance` + GHCR image push with `cosign` / Sigstore attestations attached.
- `docs/architecture/schemas/control-plane-postgres-schema.md` — **not edited by this plan.** The relay consumes Plan-008's `session_directory` / `relay_connections` tables, Plan-021's `admin_bans` / `rate_limit_escalations` tables, Plan-018's `participants` / `identity_mappings` tables, and rate-limiter-flexible's self-managed `ratelimit_*` namespace tables (which the library auto-creates on first use and are not part of the hand-authored migration sequence).

## Data And Storage Changes

- **No new owned tables.** The relay is stateless at the process level beyond in-flight WebSocket bookkeeping in memory. All persistent state is owned by upstream plans (Plan-008, Plan-018, Plan-021) or by rate-limiter-flexible itself.
- **Rate-limiter-flexible namespace tables (`ratelimit_*`).** The library auto-creates these on first use via its Postgres store. They do NOT ship in the Plan-008 / Plan-021 migration sequence. The operator runbook must note this so operators understand why extra tables appear. The one-time auto-creation happens on the relay's first cold start against a fresh Postgres; subsequent starts are no-ops.
- **PASETO key material is not stored by the relay.** Public keys arrive via `PASETO_PUBLIC_KEYS` env var (JSON array of keys with rotation metadata). The relay never holds signing keys; issuance and rotation are Plan-018's concerns. This plan's verifier treats keys as ephemeral config.

## API And Transport Changes

- **No v2 protocol changes.** This plan imports Plan-008's protocol surface. Any protocol evolution ships in Plan-008 and is picked up here via package dependency bump.
- **Operator HTTP surface (not client-facing).**
  - `GET /healthz` — returns `200` unconditionally once the Fastify server is listening.
  - `GET /readyz` — returns `200` when Postgres is reachable and `SELECT 1` succeeds within a 1s budget; `503` otherwise, with body `{ status: 'postgres_unreachable' }`.
  - `GET /metrics` — Prometheus text format. Default counters: `relay_ws_connections_active`, `relay_ws_frames_total{direction}`, `relay_http_requests_total{method,route,status}`, `relay_http_request_duration_seconds` (histogram), plus Plan-021's `ratelimit_*` counters exported from the middleware layer, plus Node.js runtime metrics (GC, heap, event-loop lag) via `prom-client`.
- **Config env vars.** All declared in Spec-025 §Interfaces And Contracts; this plan implements parsing in `src/config/env.ts` with Zod schemas that fail loudly on malformed input (e.g., invalid URL, non-numeric timeout).

## Implementation Steps

1. **Create `packages/crypto-paseto/` package skeleton.** Scaffold TypeScript package with `@noble/curves` and `@noble/ciphers` as dependencies (both pinned to exact versions in `package-lock.json`). Export types `PasetoPublicKey`, `PasetoSecretKey`, `PasetoToken`.
2. **Implement PASETO v4.public `sign` / `verify`.** In `src/v4-public.ts`, follow the PASETO v4 structure (header `v4.public.` + base64url(payload `||` 64-byte Ed25519 signature) + optional footer). Ed25519 ops go through `@noble/curves/ed25519`. Reference RFC: [PASETO v4 spec](https://github.com/paseto-standard/paseto-spec/blob/master/docs/02-Implementation-Guide/01-Payload-Processing.md).
3. **Author RFC conformance vector test suite.** In `src/test/rfc-vectors.test.ts`, load the official vectors from the PASETO spec repo and assert `sign` / `verify` matches every vector. **This test suite is a gating acceptance criterion** — the relay cannot ship without it green.
4. **Implement `KeyRing` with rotation window.** In `src/key-rotation.ts`, accept an array of `{ publicKey, validFrom, validUntil }` entries parsed from `PASETO_PUBLIC_KEYS`. On `verify(token)`, try each key whose window covers the token's `iat` claim; return the first match or reject. Default rotation window: 30 min (Spec-025 §Fallback Behavior); operator-configurable via `PASETO_ROTATION_WINDOW_MS` — implements Spec-025 §Open Questions leaning toward operator-configurable rotation window. Plan-025 treats that lean as the settled choice and declares the env var as a first-class operator knob.
5. **Scaffold `packages/relay-node/` with Fastify v5.** In `src/server.ts`, bootstrap Fastify with `@fastify/websocket` registered. Fastify plugin order: config load → logger init → PASETO verifier → rate-limit middleware → route registration → WS upgrade handler → graceful-shutdown wiring.
6. **Wire PASETO verification middleware.** In `src/auth/paseto-verifier.ts`, decorate Fastify request with `request.participantId` set from the verified `sub` claim. Reject unauthenticated non-public routes with `401 auth.required`. Public routes: `/healthz`, `/readyz`, `/metrics`, plus Spec-008's unauthenticated handshake steps (exact list is Plan-008's export).
7. **Wire Plan-021's `PostgresRateLimiter`.** In `src/rate-limit/wire-postgres-limiter.ts`, instantiate one `PostgresRateLimiter` per Spec-021 endpoint group using a shared `pg.Pool`. Inject the limiter into Plan-021's `rateLimitProcedure` for HTTP routes and into `wsRateLimit` for the per-frame WS check. Read `AIS_RATELIMIT_BACKEND=postgres` (self-host default) and `AIS_RATELIMIT_FAILOPEN_SECONDS` env vars; pass through to Plan-021's fail-open wrapper.
8. **Implement WS frame handler.** In `src/ws/frame-handler.ts`, decode frames via Plan-008's codec, run `wsRateLimit(limiter, extractor)(conn, frame)` before dispatch, then dispatch via Plan-008's protocol state machine. On rate-limit trip, send close frame with code `4029` (Plan-021 convention) and close the WS.
9. **Implement `/healthz`, `/readyz`, `/metrics`.** In `src/ops/health.ts`, register the three routes. `/readyz` uses a cached Postgres-probe result (refreshed every 5s by a background interval) so the endpoint itself is cheap. `/metrics` uses `prom-client` with process + default metrics registered at startup.
10. **Implement graceful shutdown.** In `src/ops/graceful-shutdown.ts`, install SIGTERM / SIGINT handlers that (a) stop accepting new HTTP / WS connections, (b) signal all active WS connections via a `drain()` hook in Plan-008's state machine, (c) wait up to `SHUTDOWN_DRAIN_TIMEOUT_MS` (default 30s), then (d) force-close remaining WS with code `1001 Going Away` and exit 0.
11. **Implement structured JSON logging.** In `src/ops/logger.ts`, configure `pino` at `LOG_LEVEL` (default `info`). Install a redactor that strips any string matching `/v4\.public\.[A-Za-z0-9_-]+/` from log output — PASETO tokens must never appear in logs regardless of caller intent.
12. **Implement config loader with Zod schemas.** In `src/config/env.ts`, define a Zod schema for every env var from Spec-025 §Interfaces And Contracts. Parse on startup; throw with a structured error (`{ field, expected, got }`) on invalid input and exit non-zero. No silent defaults for security-relevant config (`PASETO_PUBLIC_KEYS`, `DATABASE_URL`, `RELAY_PUBLIC_URL`).
13. **Author `Dockerfile`.** Multi-stage: `node:22-slim` for build (`npm ci --ignore-scripts`, build, prune dev deps); runtime stage on `gcr.io/distroless/nodejs22-debian12` with non-root UID `10001:10001` and `USER 10001:10001`. Declare `HEALTHCHECK` hitting `/healthz`. If distroless causes operator pain during early rollout, fall back to `node:22-slim` with `USER node`.
14. **Author reference `docker-compose.yml`.** Three services: `postgres:17-alpine` (with `healthcheck: pg_isready`), `relay-node` (built from the Dockerfile or pulled from GHCR), `caddy:2` for TLS termination. No top-level `version:` field. `relay-node.depends_on.postgres` = `{ condition: service_healthy, restart: true }`. Mount a named volume for Postgres data; relay has no data volume.
15. **Author `Caddyfile`.** Reverse-proxy `${RELAY_PUBLIC_URL}` → `relay-node:8787` with automatic Let's Encrypt cert. Propagate `X-Forwarded-For` and `X-Forwarded-Proto`; enable HTTP/2 + HTTP/3 (Caddy defaults).
16. **Author `.env.example`.** Include every env var with a comment explaining its purpose, safe default, and consequence of misconfiguration.
17. **Author CI workflow `.github/workflows/relay-node-release.yml`.** On tag `relay-node-vX.Y.Z`: run `npm ci --ignore-scripts`; run `npm audit signatures`; build; run RFC conformance tests; `npm publish --provenance --access public` for `packages/crypto-paseto`; `docker build` → push to GHCR with `cosign sign --yes` for Sigstore attestation.
18. **Author operator runbook.** `docs/operator-guide/self-host-relay.md`: prerequisites (Postgres 17, Docker Compose, public DNS for Caddy), step-by-step first deploy, env var reference, the 500-req/s rate-limiter ceiling and sharding workaround, PASETO key rotation procedure, Postgres schema migration entry point (inherits from Plan-008 + Plan-021), graceful-shutdown SLO, log-format reference, troubleshooting (Postgres unreachable, cert renewal failures, rate-limit backend saturation).

## Parallelization Notes

- Steps 1–4 (crypto-paseto package) must land first; everything else orbits them.
- Steps 5–6 (Fastify skeleton + PASETO middleware) are sequential; they unlock the rest of the relay.
- Steps 7, 9, 10, 11, 12 can run in parallel once step 6 lands.
- Step 8 (WS frame handler) depends on steps 6, 7; it is the hot-path integration point.
- Steps 13–16 (Docker + Compose + Caddy + env example) are independent of code steps 5–12 and can happen in parallel with them.
- Step 17 (CI workflow) depends on steps 3 (RFC vectors) and 13 (Dockerfile) being in place.
- Step 18 (runbook) can start anytime after step 5 but must land with the operator-visible surface stable.

## Test And Verification Plan

- **`packages/crypto-paseto/` RFC conformance (gating).** The PASETO v4.public RFC vectors must all pass. Failure blocks release. Vectors live in `src/test/rfc-vectors.test.ts` and are re-run in CI on every build.
- **`KeyRing` rotation.** Unit tests: token signed by key A (valid window [T-1h, T+1h]) verifies under `verify(token, at: T)`; same token at `T+2h` is rejected; rotation-window override via `PASETO_ROTATION_WINDOW_MS` respected.
- **PASETO token masking in logs.** Integration test: log a string containing a valid PASETO v4.public token; assert the emitted log line has the token stripped to `v4.public.<redacted>`.
- **Rate-limiter contract parity.** This deployment must pass Plan-021's shared contract test suite (the same suite the `CloudflareWorkersRateLimiter` passes). This is the primary guarantee of "both implementations enforce identical limits" — Spec-021 §Deployment-Aware Abstraction.
- **Graceful shutdown drain.** Integration test with Fastify testcontainer: open 100 WS connections, send SIGTERM, assert all 100 receive a `drain` signal, complete their in-flight messages, and close cleanly within `SHUTDOWN_DRAIN_TIMEOUT_MS`. Then repeat with a synthetic slow client that refuses to close; assert force-close with code `1001` after the timeout elapses.
- **Postgres probe on `/readyz`.** Integration test: start relay against a live Postgres testcontainer, assert `GET /readyz` returns `200`; kill the Postgres container, assert `/readyz` transitions to `503` within 10s (the 5s probe interval + jitter); restart Postgres, assert `/readyz` returns to `200`.
- **Config load failure modes.** Unit tests: missing `PASETO_PUBLIC_KEYS` → startup throws with `{ field: 'PASETO_PUBLIC_KEYS', expected: 'JSON array', got: undefined }`; malformed `DATABASE_URL` → startup throws; unknown `AIS_RATELIMIT_BACKEND` value → startup throws (Plan-021 factory re-throws).
- **Protocol-identity smoke.** Spin up the Node self-host relay + a real daemon client; run Plan-008's conformance test suite against this deployment. Every protocol-level assertion that passes against the Cloudflare hosted backend must also pass against this deployment. Any divergence is a protocol-identity regression and blocks release.
- **Supply-chain guardrails.** CI assertion: the release workflow runs `npm audit signatures` and `npm ci --ignore-scripts`; the image build invokes `cosign sign`. Missing any step fails the CI job.
- **Container image posture.** CI assertion: run `docker image inspect` on the built image; assert (a) `User` is non-root, (b) `ReadonlyRootfs` where the distroless base permits, (c) healthcheck is declared.
- **docker-compose.yml smoke.** CI runs `docker compose up -d --wait` against the reference compose file in a CI-only config; asserts `/healthz` returns `200` within 60s of boot.

## Rollout Order

1. Land `packages/crypto-paseto/` with passing RFC vectors (steps 1–4). Publish `@ai-sidekicks/crypto-paseto` to npm with provenance.
2. Land `packages/relay-node/` skeleton + PASETO middleware (steps 5–6). Internal-only; no release yet.
3. Land Plan-021 rate-limiter wiring + WS frame handler + operator HTTP surface (steps 7–9). Runs in CI against testcontainer Postgres.
4. Land graceful shutdown, logging, config loader (steps 10–12). These are runtime-quality gates; the relay is not release-ready without them.
5. Land Dockerfile + docker-compose.yml + Caddyfile + .env.example (steps 13–16). Operator surface is testable from a fresh clone via `docker compose up -d`.
6. Land CI release workflow (step 17). First tagged release publishes npm package + GHCR image with provenance.
7. Land operator runbook (step 18). Required before public release because operators cannot deploy without it.
8. Run Plan-008's conformance test suite against the deployed relay; run Plan-021's shared rate-limiter contract tests; fix any divergence.
9. Tag `relay-node-v1.0.0`. The self-host deployment is GA.
10. Monitor: first two weeks of production self-host deploys for false-positive reports on rate limits, PASETO verification errors, and graceful-shutdown timeouts.

## Rollback Or Fallback

- **PASETO RFC vector regression.** Non-negotiable: cannot ship. If a dependency bump introduces a vector regression, pin the dependency back and investigate before releasing.
- **Postgres backend saturation in operator deployments.** Spec-025 §Fallback Behavior documents the ~500 req/s ceiling. Operator runbook provides namespace-sharding workaround. If an operator exceeds even sharded capacity, they adopt Redis as a V1.1+ migration path (out of scope here).
- **Caddy cert renewal failure.** Caddy retains the prior valid certificate until expiry (Caddy native behavior). Operators monitor `caddy_acme_certificate_renewal_failure` metric; operator runbook documents the DNS/ACME diagnosis path.
- **Fail-open on rate-limiter backend outage.** Plan-021's fail-open wrapper handles this (60s default grace, then 503). This plan does not override Plan-021's behavior.
- **Container image pull failure from GHCR.** Operators can build locally from source (`docker compose build`); the runbook documents this fallback.
- **Version pin on `ws` transitive (via `@fastify/websocket`).** If a new `ws` CVE lands during operator deployment, pin `@fastify/websocket` to the version tree that resolves `ws` ≥ the fixed version and release a point update. Spec-025 §Implementation Notes already flags this.

## Risks And Blockers

- **In-house PASETO correctness risk.** Rolling our own PASETO is the chosen path (Spec-025 §Implementation Notes rejected `panva/paseto` as archived and `paseto-ts` for single-maintainer concentration). Mitigation: the RFC conformance vector suite is a gating acceptance criterion; the implementation is ~150 LOC of composable noble primitives. Deliberate mitigation via test rigor, not via falling back to an unmaintained library.
- **Plan-018 co-dependency on `packages/crypto-paseto/`.** Plan-018 (issuer) must consume the same package this plan creates. If Plan-018 lands before Plan-025's package is published, Plan-018 cannot compile. Mitigation: land `packages/crypto-paseto/` (steps 1–4) as the first deliverable of this plan, ahead of Plan-018's scheduled start. Plan-018's Dependencies list must name this plan; BL-054's Session 4 propagation pass adds that edge to `cross-plan-dependencies.md`.
- **Plan-008 protocol surface not yet stable.** This plan cannot wire the WS frame handler (step 8) until Plan-008 publishes its v2 protocol package. Mitigation: steps 1–4 (crypto-paseto) and steps 13–18 (deploy + docs) proceed independently of Plan-008; the relay-node process assembly (steps 5–12) waits on Plan-008's package export.
- **Node.js 22 LTS adoption friction for operators.** Some operators run Node 20 (Iron) pipelines today; Iron goes EOL 2026-04-30 (pre-V1-GA per project roadmap, but some ops teams move slowly). Mitigation: operator runbook documents Node 22 as baseline; containerized deployment hides the Node version from operator hosts (they only need Docker).
- **Postgres 17 adoption friction.** Spec-025 bases Postgres 17. Operators on Postgres 15/16 must upgrade. Mitigation: operator runbook explicitly states "Postgres 17 minimum" in the prerequisites section; the `/readyz` endpoint's Postgres probe includes a `server_version` check that refuses to start if below 17.
- **Caddy vs nginx operator preference.** Spec-025 chose Caddy as the default; some operators prefer nginx. Mitigation: operator runbook includes a brief "using nginx instead" appendix showing the 5-line reverse-proxy config; not a supported deploy target but unblocks preference.
- **Supply-chain posture not enforced at install time.** `npm ci --ignore-scripts` + `npm audit signatures` live in CI, but operators who run `npm install` locally may not get the same guarantees. Mitigation: operator runbook tells operators NOT to `npm install`; they deploy via container image. The in-repo `package-lock.json` pins exact versions so any rebuilds use audited trees.
- **Compose Spec `depends_on.restart: true` requires Docker Compose v2.20+.** Older Compose versions silently ignore the key and fail to restart the relay on Postgres recovery. Mitigation: operator runbook states "Docker Compose v2.20+" as a prerequisite; the `docker compose up` CI smoke test runs on a current Compose version.

## Done Checklist

- [ ] `packages/crypto-paseto/` ships with PASETO v4.public `sign` / `verify` / `KeyRing` implementations on `@noble/curves` + `@noble/ciphers`, and the PASETO RFC conformance vector test suite is green in CI.
- [ ] `packages/relay-node/` ships Fastify v5 + `@fastify/websocket` bootstrap with PASETO verification middleware, Plan-008 v2 protocol dispatch, and Plan-021 rate-limiter wiring (HTTP + WS per-frame).
- [ ] `/healthz`, `/readyz` (with Postgres reachability probe), and `/metrics` (Prometheus text format) endpoints are implemented per Spec-025 §Interfaces And Contracts.
- [ ] Graceful shutdown drains in-flight WS connections within `SHUTDOWN_DRAIN_TIMEOUT_MS` (default 30s), then force-closes with code `1001`.
- [ ] Structured JSON logging via `pino`; PASETO tokens are masked at the log-emit boundary.
- [ ] Config loader parses all env vars from Spec-025 §Interfaces And Contracts with Zod; startup fails loudly on malformed input.
- [ ] `Dockerfile` produces a non-root container; read-only root filesystem where distroless / slim base permits.
- [ ] `deploy/self-host/docker-compose.yml` uses Compose Spec (no `version:` field) and `depends_on: { condition: service_healthy, restart: true }`.
- [ ] `deploy/self-host/Caddyfile` reverse-proxies with automatic Let's Encrypt and correct forwarded headers.
- [ ] `deploy/self-host/.env.example` includes every operator-facing env var with comments.
- [ ] CI publishes `@ai-sidekicks/crypto-paseto` to npm with provenance; pushes GHCR image with Sigstore attestation; runs `npm audit signatures` and `npm ci --ignore-scripts` on every build.
- [ ] The runtime bundle contains zero Cloudflare-specific code paths (enforced by a grep-in-CI for `cloudflare:*` imports in `packages/relay-node/`).
- [ ] Plan-021's shared rate-limiter contract test suite passes against this deployment.
- [ ] Plan-008's v2 protocol conformance test suite passes against this deployment.
- [ ] `docs/operator-guide/self-host-relay.md` covers prerequisites, first-deploy flow, env var reference, the 500-req/s rate-limiter ceiling, PASETO key rotation, Postgres 17 minimum, graceful-shutdown behavior, and the "using nginx instead" appendix.
- [ ] The relay refuses to start when Postgres is unreachable or reports `server_version < 17`.
- [ ] `@fastify/websocket` is pinned to a version tree that resolves `ws` ≥ 8.18 per Spec-025 §Implementation Notes (CVE-2024-37890 DoS posture).

## Tier Placement

Tier 5-6, per `docs/architecture/cross-plan-dependencies.md` §5 Canonical Build Order. Strictly **downstream of Plan-008** (consumes v2 protocol surface) and **Plan-021** (consumes `PostgresRateLimiter` + `AdminBansStore`). Loosely **co-tier with Plan-026** (first-run onboarding references this deployment as the "self-host" option but does not directly depend on its runtime). **Upstream of Plan-001's post-V1 scale work** (self-host topology is the GA target for V1; Plan-001 in V1 ships against the shared protocol and is agnostic to which backend deployment hosts it). Tier placement update in `cross-plan-dependencies.md` §5 is BL-054's scope (Session 4); this plan's body states tier intent only.

## References

- [Spec-025: Self-Hostable Node Relay](../specs/025-self-hostable-node-relay.md) — authoritative technology choices
- [Spec-008: Control-Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md) — v2 wire protocol
- [Spec-021: Rate Limiting Policy](../specs/021-rate-limiting-policy.md) — deployment-aware rate-limiter contract
- [ADR-020: V1 Deployment Model And OSS License](../decisions/020-v1-deployment-model-and-oss-license.md)
- [ADR-008: Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
- [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md)
- [ADR-004: SQLite Local State, Postgres Control Plane](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)
- [Plan-021: Rate Limiting Policy](./021-rate-limiting-policy.md) — `PostgresRateLimiter` / `AdminBansStore` consumers
- [Deployment Topology](../architecture/deployment-topology.md)
- [Fastify v5](https://fastify.dev/)
- [`@fastify/websocket`](https://github.com/fastify/fastify-websocket)
- [`@noble/curves`](https://github.com/paulmillr/noble-curves)
- [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers)
- [PASETO v4 spec](https://github.com/paseto-standard/paseto-spec)
- [rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible)
- [Caddy v2](https://caddyserver.com/docs/)
- [Compose Specification](https://docs.docker.com/reference/compose-file/)
- [npm provenance + Sigstore](https://docs.npmjs.com/generating-provenance-statements)
