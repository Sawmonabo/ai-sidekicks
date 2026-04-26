# Spec-025: Self-Hostable Node Relay

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `025` |
| **Slug** | `self-hostable-node-relay` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude (AI-assisted)` |
| **Depends On** | [ADR-020: V1 Deployment Model (OSS Self-Host + Hosted SaaS) and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md), [ADR-008: Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md), [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md), [Spec-008: Control-Plane Relay And Session Join](./008-control-plane-relay-and-session-join.md), [Spec-021: Rate Limiting Policy](./021-rate-limiting-policy.md), [Deployment Topology](../architecture/deployment-topology.md) |
| **Implementation Plan** | [Plan-025: Self-Hostable Node Relay](../plans/025-self-hostable-node-relay.md) |

## Purpose

Define the Node.js self-hostable relay that implements the v2 relay protocol as an alternate deployment of [Spec-008](./008-control-plane-relay-and-session-join.md) for operators who run their own control-plane per ADR-020 Option 1 (free self-hosted) and ADR-020 Option 2 (self-host-your-own-relay).

**Spec-008 is authoritative for the v2 wire protocol, session-join handshake, authentication shape, and relay semantics.** This spec defines the Node.js *deployment package* that hosts the same protocol: the process model, Postgres-backed rate limiter, PASETO verification posture, `docker-compose.yml` reference, reverse-proxy topology, observability endpoints, and supply-chain hardening. Where this spec and Spec-008 appear to disagree, Spec-008 wins and this spec is adjusted.

## Scope

In scope:
- Node.js runtime, HTTP server, and WebSocket transport host for the v2 relay protocol.
- Postgres as the single persistence dependency for shared state (membership, invites, presence, relay sequencing).
- Rate-limiter backend: `rate-limiter-flexible` on Postgres, behind the deployment-aware abstraction from [Spec-021](./021-rate-limiting-policy.md).
- PASETO v4.public verification of access tokens at the relay boundary.
- `docker-compose.yml`-based single-command deployment for operators (the file itself ships in [BL-080](../archive/backlog-archive.md) Plan-025).
- Reverse-proxy baseline (Caddy) for TLS termination, HTTP/2, and automatic certificate acquisition.
- Observability endpoints (`/healthz`, `/readyz`, `/metrics`) and OTLP export posture.
- Supply-chain hardening baseline (npm provenance verification, `--ignore-scripts` in CI, signed release artifacts).
- Minimum supported runtime versions (Node.js, Postgres, Docker Compose spec).

Out of scope (see Non-Goals for full list):
- The v2 relay protocol itself (Spec-008 is authoritative).
- Enterprise operator features (OIDC/SAML, HSM-backed signing keys, SOC 2 artifacts, offline-root infrastructure) — [BL-060](../archive/backlog-archive.md) tracks secure-by-default V1 posture; enterprise compliance is V1.1+.
- Kubernetes Helm charts and multi-node scale-out topologies.
- End-user account management UX — that is the hosted SaaS concern.

## Non-Goals

- Redefining the v2 relay protocol. Any protocol change must land in Spec-008 first; this spec inherits.
- Shipping a Cloudflare Workers + Durable Objects backend. The hosted deployment uses Cloudflare per [Deployment Topology](../architecture/deployment-topology.md) §Relay Scaling Strategy; this spec is the **self-host** track that runs on commodity infrastructure.
- Operating or distributing the project-operated free public relay. ADR-020's free public relay runs on Cloudflare; this spec's output is the software operators deploy on their own infrastructure.
- Kubernetes Helm charts, Nomad jobs, Terraform modules, or any orchestrator other than the `docker-compose.yml` reference deployment.
- OIDC/SAML SSO, HSM-backed operator keys, SOC 2 compliance artifacts, offline-root signing infrastructure (see [BL-060](../archive/backlog-archive.md) for V1 secure-by-default; enterprise features are V1.1+).
- End-user or operator UI. Relay is headless; operators use CLI, config files, and log/metrics endpoints.

## Domain Dependencies

- [Session Model](../domain/session-model.md) — session, participant, relay-channel entities referenced in the v2 protocol.
- [Participant And Membership Model](../domain/participant-and-membership-model.md) — identity shape verified at relay ingress.
- [Runtime Node Model](../domain/runtime-node-model.md) — runtime-node presence and reconnection semantics that relay must preserve across transport swaps.

## Architectural Dependencies

- [ADR-020: V1 Deployment Model and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md) — establishes the one-codebase-two-deployments contract this spec's backend satisfies.
- [ADR-008: Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md) — defines the transport family this relay hosts.
- [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md) — authentication shape.
- [ADR-004: SQLite Local State, Postgres Control Plane](../decisions/004-sqlite-local-state-and-postgres-control-plane.md) — Postgres is the persistence layer.
- [Security Architecture](../architecture/security-architecture.md) — trust-boundary stance the relay must preserve.
- [Deployment Topology](../architecture/deployment-topology.md) §Rate Limiting By Deployment — deployment-aware rate-limiter abstraction.
- [Spec-008: Control-Plane Relay And Session Join](./008-control-plane-relay-and-session-join.md) — authoritative v2 relay protocol.
- [Spec-021: Rate Limiting Policy](./021-rate-limiting-policy.md) — deployment-aware rate-limiter contract.

## Required Behavior

- The relay must implement the v2 wire protocol defined in [Spec-008](./008-control-plane-relay-and-session-join.md) such that a daemon cannot distinguish the Node self-host relay from the Cloudflare Workers + Durable Objects backend at the protocol level.
- The relay must verify PASETO v4.public access tokens at ingress before accepting any session-join or message exchange.
- The relay must not grant itself arbitrary execution authority over participant nodes. It stores and forwards encrypted collaboration traffic; it does not decrypt or interpret it.
- The relay must enforce rate limits via the deployment-aware abstraction defined in [Spec-021](./021-rate-limiting-policy.md), using the `rate-limiter-flexible` Postgres backend in this deployment.
- The relay must expose `/healthz` (liveness), `/readyz` (readiness with Postgres reachability check), and `/metrics` (Prometheus text format) endpoints.
- The relay must emit structured logs at `info` and above to stdout in line-delimited JSON; log content must not include bearer tokens, PASETO raw bodies, or encrypted-payload plaintext.
- The relay must run as a non-root user inside its container image.
- The relay must refuse to start when Postgres is unreachable or its schema version is incompatible.
- The relay must support graceful shutdown: stop accepting new connections, allow in-flight messages to drain with a configurable timeout (default 30s), then terminate.
- The relay must behave identically across operator-provided TLS termination modes: Caddy reverse proxy (default), external load balancer, or direct-TLS (not recommended but supported for advanced operators).

## Default Behavior

- **Runtime:** Node.js LTS ≥ 22. Node.js 20 (Iron) is end-of-life 2026-03-24 and is not supported. The container base image must be Node.js 22 LTS or newer.
- **Database:** Postgres ≥ 17. Older versions are not supported in V1 (no PostgreSQL 15/16 back-compat shim ships).
- **HTTP + WebSocket server:** [Fastify v5](https://fastify.dev/) with [`@fastify/websocket`](https://github.com/fastify/fastify-websocket) (which wraps the `ws` package). The choice follows the 2026 Node.js server ecosystem; Fastify is the mainstream framework with continuous 2025–2026 development, and `@fastify/websocket` delegates to `ws` (also actively maintained 2025–2026).
- **Rate limiter:** [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible) with its Postgres backend. Limits follow the deployment-aware abstraction in [Spec-021](./021-rate-limiting-policy.md).
- **PASETO verification:** in-house implementation of v4.public built on [`@noble/curves`](https://github.com/paulmillr/noble-curves) (Ed25519) and [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers). See Implementation Notes for the rationale against `panva/paseto` (archived 2025-03-29) and `paseto-ts` (single-maintainer concentration risk).
- **Reverse proxy:** [Caddy v2](https://caddyserver.com/) in the reference `docker-compose.yml`, providing HTTP/2, automatic Let's Encrypt certificate acquisition, and forward-proxy headers (`X-Forwarded-For`, `X-Forwarded-Proto`).
- **Observability:** `/metrics` is Prometheus-format by default, scraped on the operator's private network. OTLP export is opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT` env var; no OpenTelemetry Collector ships in the reference deployment.
- **Supply chain:** npm provenance attestations published for every release; `npm ci --ignore-scripts` in CI; `npm audit signatures` on every CI build.
- **Container base image:** distroless or minimal Debian-slim; non-root UID/GID; read-only root filesystem where Node.js permits.

## Fallback Behavior

- **Postgres unreachable at startup:** refuse to start. Emit a structured error log and exit non-zero. Do not retry in a tight loop; the container orchestrator's restart policy handles backoff.
- **Postgres becomes unreachable after startup:** drop readiness (`/readyz` returns 503); continue serving in-flight WebSocket connections as long as the protocol allows; refuse new session-join requests. When Postgres returns, re-assert readiness.
- **Rate-limiter Postgres pressure:** `rate-limiter-flexible` Postgres backend uses `INSERT...ON CONFLICT` atomicity. Under very high contention (>500 req/s across the rate-limiter namespace), the backend's throughput becomes the bottleneck before Postgres itself. If a deployment routinely exceeds that, the operator must shard the rate-limiter namespace or deploy Redis as an additional backend (out of scope for V1). Document this ceiling in operator guide.
- **TLS certificate renewal failure (Caddy):** Caddy retains the previous valid certificate until expiry; emit a high-severity log; do not fall back to plaintext.
- **PASETO verification key rotation in-flight:** the relay must accept both the previous and the current signing keys during a rotation window (default 30 minutes). A token signed by a key outside that window is rejected.
- **Graceful shutdown exceeds drain timeout:** force-close remaining WebSocket connections with close code `1001 (Going Away)`. Clients must reconnect per Spec-008 reconnection semantics.

## Interfaces And Contracts

- **Wire protocol:** v2 relay protocol defined in [Spec-008](./008-control-plane-relay-and-session-join.md). This spec adds no new protocol surfaces.
- **HTTP endpoints (operator surface, not client surface):**
  - `GET /healthz` — returns 200 when the process is alive.
  - `GET /readyz` — returns 200 when Postgres is reachable and the schema version matches; 503 otherwise.
  - `GET /metrics` — Prometheus text format; default metrics include HTTP request count/latency, WebSocket connection count, rate-limiter hits/denials, Postgres connection pool stats.
- **Configuration surface (environment variables, precedence: env > config file > defaults):**
  - `RELAY_BIND` (default `0.0.0.0:8787`) — HTTP + WebSocket listen address.
  - `RELAY_PUBLIC_URL` — external-facing URL advertised to clients; must match the URL the reverse proxy fronts.
  - `DATABASE_URL` — Postgres connection string.
  - `PASETO_PUBLIC_KEYS` — JSON array of current and prior-rotation public keys (Ed25519).
  - `OTEL_EXPORTER_OTLP_ENDPOINT` — optional OTLP endpoint for opt-in distributed tracing.
  - `LOG_LEVEL` — `info` by default; `debug` available but must not leak token material.
  - `SHUTDOWN_DRAIN_TIMEOUT_MS` — default `30000`.
- **Reference `docker-compose.yml`** — ships in [BL-080](../archive/backlog-archive.md) Plan-025. Must use Compose Specification (no top-level `version:` field — [Compose Spec 2025](https://docs.docker.com/reference/compose-file/legacy-versions/) deprecated it) and must use `depends_on` with `condition: service_healthy` and `restart: true` so the relay waits for Postgres and restarts on its recovery.

## State And Data Implications

- All persistent state lives in Postgres. The relay container has no durable on-disk state beyond ephemeral logs.
- Postgres schema is shared with the hosted backend; migrations are authored once and apply to both deployments. [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md) names Postgres as the shared control-plane persistence.
- Rate-limiter state uses its own tables (namespaced `ratelimit_*`) managed by `rate-limiter-flexible`. These tables do not participate in the main schema migration sequence.
- Audit log, session events, and participant state persist in the shared schema (see Spec-006 for event taxonomy).
- The relay is stateless at the process level beyond in-flight WebSocket connection bookkeeping held in memory — a restart drops connections; clients reconnect per Spec-008.

## Example Flows

- `Example: First-time operator deploys the self-host relay.`
  1. Operator clones the repo, copies `docker-compose.example.yml` to `docker-compose.yml`, and sets `POSTGRES_PASSWORD`, `RELAY_PUBLIC_URL`, and `PASETO_PUBLIC_KEYS` in a local `.env`.
  2. Operator runs `docker compose up -d`. Postgres starts first, the relay waits on `condition: service_healthy`, and Caddy fronts the relay with an auto-issued Let's Encrypt certificate.
  3. Operator verifies deployment by curling `https://relay.operator.example/healthz` (expects 200) and `https://relay.operator.example/readyz` (expects 200).
  4. Operator points the first AI Sidekicks daemon at `RELAY_URL=https://relay.operator.example` via first-run (see [Spec-026](./026-first-run-onboarding.md)) or `sidekicks config set`.

- `Example: Certificate renewal failure surfaces in metrics.`
  1. Caddy's ACME renewal attempt fails on day 88 of a 90-day certificate.
  2. Caddy retries per its retry schedule; the prior valid certificate continues to serve.
  3. The operator's Prometheus scrape catches Caddy's `caddy_acme_certificate_renewal_failure` counter; alert fires via the operator's Alertmanager wiring.
  4. Operator diagnoses DNS / ACME authority issue; once resolved, Caddy's next retry succeeds automatically.

- `Example: Rate-limiter Postgres backend saturation.`
  1. A sudden burst of invite traffic pushes the rate limiter to ~800 req/s in its namespace.
  2. `INSERT...ON CONFLICT` contention drives Postgres CPU; the backend throughput ceiling (~500 req/s) backpressures the relay.
  3. Legitimate rate-limited requests see increased response latency rather than hard failure.
  4. Operator consults the rate-limiter-flexible documentation and the deployment runbook to shard the namespace or introduce Redis as an additional backend (V1.1+ work, pre-documented in operator guide).

## Implementation Notes

- **PASETO library choice.** The three options evaluated for PASETO v4.public verification are: (1) [`panva/paseto`](https://github.com/panva/paseto) — archived by the maintainer on 2025-03-29; no longer accepting PRs or CVE fixes; unacceptable for a V1 security dependency; (2) [`paseto-ts`](https://github.com/auth70/paseto-ts) — actively maintained but single-maintainer with ~1.5k weekly downloads; concentration risk in a security-critical path; (3) **in-house implementation on `@noble/curves` (Ed25519) and `@noble/ciphers`** — the noble libraries are Paul Miller's audited crypto primitives with multiple production deployments. PASETO v4.public is structurally simple (Ed25519 signature over a canonical payload with a fixed header); the V1 implementation is approximately 150 LOC of composable noble primitives plus a conformance test vector suite from the PASETO RFC. This is the chosen path. A PASETO conformance test suite must be part of Plan-025's acceptance criteria.
- **Rate limiter Postgres ceiling.** [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible) Postgres backend uses `INSERT...ON CONFLICT` for atomicity, which has a practical ceiling of ~500 req/s per namespace under contention before Postgres CPU becomes the limit. This ceiling is adequate for V1 self-host scale (small-team collaboration). Operators running higher-throughput deployments can either namespace-shard or add a Redis backend; both are V1.1+ concerns. Document the ceiling in the operator guide.
- **WebSocket library transitive dependency on `ws`.** `@fastify/websocket` wraps the `ws` package. `ws` had a HeadersTimeout-related DoS CVE addressed in 8.17.1 (June 2024); no new CVEs affect 2025–2026 releases. Pin `@fastify/websocket` to a version tree that resolves `ws` ≥ 8.18 to inherit the fix.
- **Cloudflare DO sharding envelope.** The hosted deployment uses Cloudflare Durable Objects with the Hibernation API (DOs hibernate between WebSocket messages for cost efficiency; SQLite-backed DO storage reached GA 2025-04-07). Cloudflare publishes **no specific concurrent-WebSocket cap per DO** — only the statement that DOs "can act as WebSocket servers that connect thousands of clients per instance" ([DO WebSockets best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)) — together with a **1,000 requests/sec per-DO soft cap** ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). The 25-WebSocket-connections-per-data-DO target is a *design choice* defined in [Deployment Topology](../architecture/deployment-topology.md) §Relay Scaling Strategy to stay inside the 200–500 rps "complex op" guidance with ~2.5× headroom vs the soft cap (envelope: `25 conns × 100 events/sec ÷ ~6:1 batching ratio ≈ 400 rps/DO`). None of this sizing is relevant to this spec; the self-host Node.js relay uses a different scaling model — *"single-writer can be achieved either by sticky load balancing (session → process) or by an external lock (Postgres advisory lock, Redis RedLock)... Redis pub/sub typically adds ~1–3 ms to fan-out. This is the industry-standard replacement pattern for DO-style WebSocket coordination when a team leaves the Cloudflare Workers platform"* ([Ably — Scaling Pub/Sub with WebSockets and Redis](https://ably.com/blog/scaling-pub-sub-with-websockets-and-redis), fetched 2026-04-25). The V1 self-host deployment baselines the simpler sticky-routing single-process variant (no Redis) — adequate for the small-team self-host throughput envelope; operators with multi-process scale-out needs adopt the Redis fan-out pattern from the same reference.
- **Docker Compose specification.** The reference `docker-compose.yml` must use Compose Spec (post-v3) with no top-level `version:` field (deprecated by Compose Spec 2025) and use `depends_on: { condition: service_healthy, restart: true }` so the relay waits on Postgres health and restarts if Postgres is restarted.
- **Caddy as default reverse proxy.** Caddy is chosen over nginx for V1 because (1) automatic Let's Encrypt certificate issuance with zero config; (2) HTTP/2 + HTTP/3 default-on; (3) the `Caddyfile` for this deployment is ~10 lines. Nginx is acceptable for operators who already run it, but is not the default.
- **Supply-chain hardening.** The Shai-Hulud 1/2 npm worms (September–November 2025) and the Axios compromise (March 2026) establish npm provenance + Sigstore as the 2026 operational baseline. V1 posture: publish with provenance attestations; `npm ci --ignore-scripts` in CI; `npm audit signatures` on every CI run; pin all dependencies with exact versions in `package-lock.json`; no transitive postinstall scripts in the production bundle.
- **Observability default is pull, not push.** `/metrics` scrape is the default because it requires no operator-side Collector. OTLP push is opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT`. This matches the operator persona: someone running a single `docker compose up -d` should not also have to deploy an OpenTelemetry Collector before they can see metrics.

## Pitfalls To Avoid

- **Duplicating protocol logic.** The v2 relay protocol is defined in Spec-008. This spec must not restate the handshake, session-join flow, or message-framing format. Where Spec-008 changes, this spec inherits — no cross-check required because the protocol contract is the single source of truth.
- **Adding protocol features as "self-host only."** The two deployments must remain protocol-identical to preserve the feature-parity commitment in ADR-020. Any new feature ships to both backends or to neither.
- **Silently using `panva/paseto`.** It is archived; using it in V1 is a live CVE-uncovered dependency for a security-critical path. The in-house implementation is a deliberate choice, not an accident.
- **Running the relay as root.** The container image must run as a non-root UID/GID; Node.js does not need root privileges.
- **Skipping PASETO conformance tests.** An in-house PASETO implementation without the RFC conformance test vectors is a correctness landmine. Plan-025 acceptance criteria must include passing the conformance suite.
- **Assuming Postgres 15/16 compatibility.** V1 baselines Postgres 17. Operators running older Postgres must upgrade before deploying the relay.
- **Binding the relay directly to `0.0.0.0:443` without a reverse proxy.** Caddy is the default for TLS termination; operators who bypass it must handle certificate renewal, HTTP/2 negotiation, and forward-proxy headers themselves. Direct-TLS mode exists for advanced operators and is not the documented default.
- **Logging PASETO token bodies or encrypted payload plaintext.** Logs are operator-visible; tokens and plaintext must never appear. Mask at the log-emit boundary, not at the viewer.
- **Assuming Node.js 20 (Iron) is supported.** Iron goes EOL 2026-03-24; V1 baselines Node.js 22 LTS from day one.

## Acceptance Criteria

- [ ] Node.js 22 LTS and Postgres 17 are the declared minimums; the container base image and `docker-compose.yml` use those versions.
- [ ] The relay implements the v2 protocol from Spec-008 such that a client cannot detect whether it is connected to the Node self-host or the Cloudflare hosted backend via protocol-visible behavior.
- [ ] PASETO v4.public verification uses the in-house implementation built on `@noble/curves` + `@noble/ciphers`; the implementation passes the PASETO RFC conformance test vectors in CI.
- [ ] `rate-limiter-flexible` with the Postgres backend is wired behind the Spec-021 deployment-aware abstraction; the abstraction's contract tests pass against this backend.
- [ ] `/healthz`, `/readyz`, and `/metrics` endpoints are implemented with the semantics defined under Required Behavior.
- [ ] The reference `docker-compose.yml` (ships in Plan-025 / BL-080) uses Compose Spec without a `version:` field and uses `depends_on: { condition: service_healthy, restart: true }`.
- [ ] Graceful shutdown drains in-flight WebSocket connections within `SHUTDOWN_DRAIN_TIMEOUT_MS` (default 30s) before forcing close code 1001.
- [ ] CI publishes npm provenance attestations for every release; CI runs `npm audit signatures` on every build.
- [ ] Container image runs as a non-root UID/GID; read-only root filesystem where Node.js permits.
- [ ] Operator documentation includes the rate-limiter Postgres 500-req/s ceiling, the Postgres 17 minimum, and the PASETO key rotation window default.
- [ ] No Cloudflare-specific code paths exist in this deployment's runtime bundle (the hosted backend is a separate build target).

## ADR Triggers

- A proposal to replace `rate-limiter-flexible` with a custom implementation requires an ADR — the library choice is load-bearing for the self-host deployment.
- A proposal to adopt `paseto-ts` or a revived `panva/paseto` fork in place of the in-house implementation requires an ADR documenting the supply-chain risk reassessment.
- A proposal to ship a Kubernetes Helm chart as an additional V1 deployment target requires an ADR extending ADR-020's deployment-options commitment.
- A proposal to add protocol features in the self-host deployment that do not exist in the hosted deployment requires an ADR reversing ADR-020's feature-parity commitment.

## Open Questions

- Whether to ship a worked example Grafana dashboard alongside the `/metrics` endpoint, or to leave observability tooling to the operator. Lean: ship a minimal reference dashboard JSON in the repo, document it as "example, not required."
- Whether the PASETO key rotation window (30 minutes default) should be configurable per-operator. Lean: yes, via env var; V1 ships with the default and a documented override.
- Whether to publish the relay container image to a public registry (GHCR) or leave operators to build locally. Lean: publish to GHCR for convenience, with provenance attestations attached; operators can build locally if they prefer.

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
|---|---|---|---|
| Node.js release schedule | Documentation | Node 20 (Iron) EOL 2026-03-24; Node 22 LTS is the 2026 baseline | https://nodejs.org/en/about/previous-releases |
| Fastify v5 | Documentation | Mainstream 2026 Node.js HTTP framework; active 2025–2026 release cadence | https://fastify.dev/ |
| `@fastify/websocket` | Documentation | Fastify-official WebSocket plugin wrapping `ws` | https://github.com/fastify/fastify-websocket |
| `ws` package CVE history | Documentation | HeadersTimeout DoS fixed in 8.17.1 (June 2024); no new 2025–2026 CVEs at time of writing | https://github.com/websockets/ws/security/advisories |
| `rate-limiter-flexible` | Documentation | Postgres backend; `INSERT...ON CONFLICT` atomicity; ~500 req/s ceiling per namespace | https://github.com/animir/node-rate-limiter-flexible |
| `panva/paseto` | Primary source | Archived 2025-03-29 by maintainer; no further security fixes | https://github.com/panva/paseto |
| `paseto-ts` | Primary source | Actively maintained but single-maintainer (`miunau`); ~4.5k weekly downloads per npm on 2026-04-19; unaudited. Rejected as V1 dependency — see [ADR-010 §PASETO v4 Implementation Library](../decisions/010-paseto-webauthn-mls-auth.md) | https://github.com/auth70/paseto-ts |
| `@noble/curves` | Primary source | Paul Miller's audited Ed25519/secp256k1/X25519 primitives; multiple production deployments | https://github.com/paulmillr/noble-curves |
| `@noble/ciphers` | Primary source | Paul Miller's audited AEAD primitives (XChaCha20-Poly1305, AES-GCM) | https://github.com/paulmillr/noble-ciphers |
| PASETO v4 RFC | Primary source | v4.public structure and conformance test vectors | https://github.com/paseto-standard/paseto-spec |
| Postgres 17 release notes | Documentation | V1 Postgres minimum; GA 2024-09-26; active support | https://www.postgresql.org/docs/17/release-17.html |
| Caddy v2 | Documentation | Default reverse proxy; automatic Let's Encrypt; HTTP/2 + HTTP/3 defaults | https://caddyserver.com/docs/ |
| Compose Specification | Documentation | Post-v3 Compose spec; `version:` field deprecated | https://docs.docker.com/reference/compose-file/ |
| Docker Compose `depends_on` with `service_healthy` + `restart: true` | Documentation | Cascading restart behavior for health-dependent services | https://docs.docker.com/reference/compose-file/services/#depends_on |
| npm provenance + Sigstore | Documentation | 2026 operational baseline for npm supply-chain integrity | https://docs.npmjs.com/generating-provenance-statements |
| Shai-Hulud 1/2 npm worms | Incident report | September–November 2025 supply-chain incidents establishing provenance as baseline | https://blog.npmjs.org/post/shai-hulud-incident-postmortem (placeholder — see operator guide for canonical link) |
| Cloudflare Durable Objects Hibernation API | Documentation | Hibernation API (`state.acceptWebSocket()`) lets DOs hibernate between WS messages for cost efficiency; SQLite-backed DO storage GA 2025-04-07. CF publishes no specific concurrent-WS cap per DO (stated as "thousands of clients per instance"); per-DO capacity is bounded by the 1,000 rps soft cap — see [deployment-topology.md §Relay Scaling Strategy](../architecture/deployment-topology.md) for the 25-connection design envelope. | https://developers.cloudflare.com/durable-objects/api/websockets/#websocket-hibernation-api |
| Prometheus exposition format | Documentation | `/metrics` text format used by default | https://prometheus.io/docs/instrumenting/exposition_formats/ |
| OpenTelemetry OTLP | Documentation | Opt-in push export via `OTEL_EXPORTER_OTLP_ENDPOINT` | https://opentelemetry.io/docs/specs/otlp/ |

### Related Docs

- [ADR-020: V1 Deployment Model and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md)
- [ADR-008: Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
- [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md)
- [Spec-008: Control-Plane Relay And Session Join](./008-control-plane-relay-and-session-join.md) — authoritative v2 protocol
- [Spec-021: Rate Limiting Policy](./021-rate-limiting-policy.md) — deployment-aware rate-limiter contract
- [Spec-026: First-Run Onboarding](./026-first-run-onboarding.md) — daemon selects this relay via the three-way-choice flow
- [Deployment Topology](../architecture/deployment-topology.md)
- [BL-080](../archive/backlog-archive.md) — Plan-025 (implementation plan, including `docker-compose.yml`)
- [BL-060](../archive/backlog-archive.md) — secure-by-default self-host behaviors (V1 posture; enterprise features V1.1+)
