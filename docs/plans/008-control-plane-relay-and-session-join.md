# Plan-008: Control Plane Relay And Session Join

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `008` |
| **Slug** | `control-plane-relay-and-session-join` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-008: Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md) |
| **Required ADRs** | [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md), [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md), [ADR-014](../decisions/014-trpc-control-plane-api.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | **Tier 1 / Tier 5 split** per [cross-plan-dependencies.md §5 Plan-008 Bootstrap-vs-Remainder Carve-Out](../architecture/cross-plan-dependencies.md#plan-008-bootstrap-vs-remainder-carve-out-tier-1--tier-5) — Plan-008-bootstrap (tRPC v11 server skeleton + `sessionRouter` + SSE substrate) ships at Tier 1 with [Plan-001](./001-shared-session-core.md) Phase 4 (`packages/control-plane/src/sessions/session-directory-service.ts`) AND Plan-001 Phase 2 schemas (`packages/contracts/src/session.ts` + `packages/contracts/src/event.ts`) as upstream prerequisites; Plan-001 Phase 4 already shipped at Tier 1 per [GitHub PR-#10](https://github.com/Sawmonabo/ai-sidekicks/pull/10) (2026-04-27). Plan-008-remainder ships at Tier 5 with [Plan-001](./001-shared-session-core.md) (session core) + [Plan-002](./002-invite-membership-and-presence.md) (invite/presence) as plan-level dependencies. [Spec-024](../specs/024-cross-node-dispatch-and-approval.md) (implicit cross-node dispatch surface per [cross-plan-dependencies.md §Spec-024 Implementation Plan](../architecture/cross-plan-dependencies.md#spec-024-implementation-plan)) is consumed by Plan-008-remainder. **Tier 1 forward-declared contract dep:** the `EventEnvelope` type at `packages/contracts/src/event.ts` is forward-declared by Plan-001 Phase 2 with semantic ownership at [Plan-006](./006-session-event-taxonomy-and-audit-log.md) Tier 4 — same forward-declaration pattern as Plan-001 F-001-2-06; the SSE substrate consumes the placeholder shape and must rebind once Plan-006 lands. See §Execution Windows (V1 Carve-Out) below. |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |
| **References** | [Spec-008](../specs/008-control-plane-relay-and-session-join.md) (V1 relay encryption: pairwise X25519 + XChaCha20-Poly1305 per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md); MLS deferred to V1.1) |

## Execution Windows (V1 Carve-Out)

Plan-008 ships in two windows — a **Tier 1 bootstrap-deliverable** (tRPC server skeleton + `sessionRouter` + SSE substrate) that unblocks [Plan-001](./001-shared-session-core.md) Phase 5, and a **Tier 5 remainder** that completes the relay/presence/invite surface. The split is documented authoritatively in [cross-plan-dependencies.md §5 Plan-008 Bootstrap-vs-Remainder Carve-Out](../architecture/cross-plan-dependencies.md#plan-008-bootstrap-vs-remainder-carve-out-tier-1--tier-5); this section is the plan-side restatement so engineers reading Plan-008 in isolation see the split.

The carve-out follows the **substrate-vs-namespace decomposition rule** documented authoritatively in [Plan-007 §Execution Windows](./007-local-ipc-and-daemon-control.md#execution-windows-v1-carve-out) — the _transport substrate_ (tRPC server + sessionRouter + SSE plumbing) is what Plan-001 Phase 5 consumes; the _relay/presence behavior_ is what Plan-008 owns canonically. Substrate ships first.

### Tier 1 — Plan-008-Bootstrap (tRPC server + `sessionRouter` + SSE substrate)

Lands alongside Plan-001 to unblock Plan-001 Phase 5 (`sessionClient` over the control-plane transport). Scope:

- **tRPC v11 server skeleton** — Cloudflare Workers host (entry point: `fetchRequestHandler` from `@trpc/server/adapters/fetch`) + tRPC v11 router registration scaffolding per [ADR-014](../decisions/014-trpc-control-plane-api.md). Local development uses the workerd runtime via `wrangler dev` (Miniflare v3); Tier 5 production deploys to Cloudflare Workers without runtime change. Bootstrap ships only the skeleton; relay broker / presence register / invite handlers are Tier 5.
- **`sessionRouter` HTTP handlers** — typed tRPC procedures for `SessionCreate`, `SessionRead`, `SessionJoin` exposing the existing `packages/control-plane/src/sessions/session-directory-service.ts` (already shipped in Plan-001 Phase 4). The router wraps the service; it does not re-implement directory logic.
- **SSE substrate for `SessionSubscribe`** — `SessionSubscribe` is request-only on the wire — the response is an `AsyncIterable<EventEnvelope>` SSE stream per `packages/contracts/src/session.ts:388`. The Tier 1 bootstrap ships the SSE transport plumbing (tRPC `subscription` procedure + Server-Sent-Events HTTP framing) that `sessionClient.subscribe` consumes from the control-plane side. Event sourcing into the stream remains Plan-006's domain; Plan-008-bootstrap supplies only the transport.

### Tier 5 — Plan-008-Remainder (relay + presence + invite acceptance)

Lands at Plan-008's original Tier 5 slot once Plan-002 (invite/presence) is complete. Tier 5 placement is unchanged because relay coordination depends on Plan-002. Scope:

- **Relay broker** (`relay-broker-service.ts`) — pairwise X25519 + XChaCha20-Poly1305 negotiation, relay sharding, WebSocket Hibernation per the original [§Implementation Steps](#implementation-steps) below.
- **Presence register** (`presence-register-service.ts`) — adds the control-plane presence surface that extends Plan-002's `presence/` directory.
- **Invite-acceptance handoff** — wires Plan-002 invite resolution into the Tier 1 `sessionRouter`.
- **Reconnect association + relay negotiation** — `RelayNegotiation`, `SessionResumeAfterReconnect`, presence re-association.
- **Postgres tables** — `session_directory` and `relay_connections` per [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md).
- **Client surfaces** — `apps/desktop/renderer/src/session-join/`, `apps/cli/src/session-join/`, and `packages/client-sdk/src/sessionJoinClient.ts`.

## Goal

Implement authenticated shared-session join, presence registration, and relay negotiation without shifting execution authority into the control plane.

## Scope

This plan covers join APIs, invite acceptance handoff, presence registration, relay negotiation, reconnect association, and client surfaces for shared-session join.

## Non-Goals

- Local IPC implementation
- Runtime-node attach internals
- Provider transport protocols

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-008 PRs and downstream extensions. They split by execution window because Plan-008's scope expands materially between Tier 1 bootstrap and Tier 5 remainder.

### I-008-1 — Tier 1 bootstrap is operator-development-only behind a feature flag

Plan-008-bootstrap (Tier 1) ships the tRPC v11 server skeleton + `sessionRouter` + SSE substrate to unblock Plan-001 Phase 5. **It does not constitute a production-ready control-plane host.** The bootstrap MUST be gated behind a feature flag (or equivalent operator-only entry point) and MUST NOT be exposed on a non-loopback bind path or routed to from production deployments until Plan-008-remainder lands at Tier 5.

**Why load-bearing.** Spec-027 §Required Behavior governs the daemon-side bind-time secure-defaults surface (Plan-007's domain), but the SaaS Cloudflare Workers host that Plan-008-bootstrap creates is **explicitly outside Spec-027 scope** per [ADR-020](../decisions/020-v1-deployment-model-and-oss-license.md) (the SaaS deployment model is operator-provisioned hosting; Spec-027 governs self-host operator-facing daemon defaults). Production auth, rate-limiting (Plan-021), PASETO v4 token validation (Plan-018), and relay encryption (Plan-008-remainder) are all **NOT YET PRESENT** at Tier 1 — exposing the bootstrap to production traffic would bypass those surfaces entirely.

**Verification.** I-008-1 has TWO gates that BOTH must be enforced:

1. **Feature-flag gate.** Tier 1 PR must wire the bootstrap behind a feature flag (e.g., `CONTROL_PLANE_BOOTSTRAP_ENABLED=1`) that defaults off; production deployment configurations MUST NOT set the flag until Tier 5. Negative-path test: handler refuses to serve when the flag is unset in a production `wrangler` environment.
2. **Production-deployment gate (per F-008b-1-04 — Workers-runtime equivalent of the original loopback-bind gate).** The Worker handler MUST refuse to serve any request when the deployed environment is production (`env.ENVIRONMENT === 'production'` from `wrangler.toml`'s `[env.production]` block), even when the feature flag is set, returning HTTP 503 immediately before any router dispatch. This gate is independent of the feature flag — the flag enables the bootstrap; the production-deployment gate prevents accidental Cloudflare-edge exposure when an operator sets the flag in a production `wrangler` environment. Cloudflare Workers do not expose a host-bind surface (the runtime maps requests via Cloudflare's edge routing per [ADR-014](../decisions/014-trpc-control-plane-api.md)), so the original Fastify-era loopback-bind gate translates to environment-scoped deployment refusal. Positive-path test: `dev` environment serves with flag set under `wrangler dev` (workerd locally). Negative-path test: `production` environment refuses with 503 even with flag set. Coordinate language with Spec-027's bind-time secure-defaults pattern (Plan-007's domain) — Spec-027 governs the daemon-side bind surface; I-008-1 is the SaaS-host parallel for the control-plane bootstrap.

### I-008-2 — Tier 5 production invariants apply once their substrates land

The full set of production-grade invariants — PASETO v4 token validation on every endpoint (per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) + Plan-018), rate-limiting middleware (per Plan-021), relay-broker encryption (pairwise X25519 + XChaCha20-Poly1305 per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)), invite-acceptance handoff to Plan-002 — apply at Tier 5 once Plan-002 (invite/presence), Plan-018 (PASETO issuer), and Plan-021 (rate-limiter contract) substrates land. Plan-008-remainder MUST gate those surfaces on their dependencies being satisfied per [cross-plan-dependencies.md §5 Tier 5 Prereqs](../architecture/cross-plan-dependencies.md#5-canonical-build-order).

**Why load-bearing.** Shipping Tier 5 surfaces without their dependencies would either silently no-op (auth bypass) or hard-fail at runtime. The dependency tier graph is the only way to keep the substrate composition correct.

**Verification.** Tier 5 PRs must reference and wire the actual Plan-018 + Plan-021 + Plan-002 surfaces (not stubs). Integration tests must exercise the full auth + rate-limit + relay-encryption stack end-to-end before Tier 5 PRs merge.

### I-008-3 — Substrate wraps, never re-implements, the directory service

Plan-008-bootstrap's `sessionRouter` and `session-router.ts` MUST wrap the existing `packages/control-plane/src/sessions/session-directory-service.ts` shipped by Plan-001 Phase 4. Re-implementing directory logic in the router would fork the lock-ordering invariant (per [Plan-001 §Invariants I-001-1](./001-shared-session-core.md#invariants)) and break the `Querier`-driven test pattern Plan-001 Phase 5 strengthens.

**Why load-bearing.** Plan-001 owns the directory service. Plan-008 owns the HTTP transport. Conflating the two violates the Plan-001 ownership row in [cross-plan-dependencies.md §2 `packages/control-plane/src/sessions/`](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map).

**Verification (per F-008b-1-05 resolution).** Three concrete enforcement mechanisms — all three MUST land in the Phase 1 PR:

1. **Constructor injection.** `session-router.ts` exports a factory function that accepts a `SessionDirectoryService` instance: `createSessionRouter(directoryService: SessionDirectoryService): TRPCRouter`. The router's procedures call `directoryService.*` methods exclusively; the factory does NOT instantiate a `Querier` or `pg.Pool` directly. Same pattern for `session-subscribe-sse.ts`: `createSessionSubscribeSse(directoryService: SessionDirectoryService): SseHandler`.
2. **ESLint `no-restricted-imports` rule.** Forbid `pg`, `pg-pool`, and `@databases/pg` imports from `packages/control-plane/src/sessions/session-router.ts` and `packages/control-plane/src/sessions/session-subscribe-sse.ts`. Rule lives in the package-level ESLint config; CI enforces it.
3. **Unit-test introspection assertion.** Test asserts (via TypeScript symbol introspection or a small AST walker) that the two files' exported symbols call only `directoryService.*` methods at the top-level execution path. The integration-test layer reuses Plan-001 Phase 4's `Querier`-driven test pattern — the router inherits I-001-1 lock-ordering by routing through the directory service.

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred
- [x] **ADR-014 runtime authorization reconciled (BL-104 / C-4 resolved 2026-04-30).** [ADR-014](../decisions/014-trpc-control-plane-api.md) is honored verbatim: Tier 1 bootstrap and Tier 5 production both run on Cloudflare Workers via `@trpc/server/adapters/fetch`. Local development uses the workerd runtime via `wrangler dev` (Miniflare v3) per [ADR-014 Assumption #1](../decisions/014-trpc-control-plane-api.md#assumptions-audit). Resolution chosen: path (b) — Plan-008 amendment to use Cloudflare Workers + workerd local emulation. See §Decision Log entry `2026-04-30` for full reasoning (dev-prod parity, no future Tier 1→Tier 5 migration PR, primary-source verification that the tRPC fetch adapter handles SSE subscriptions natively via `resolveResponse.ts`).
- [ ] **SSE wire frame primitive declared (BLOCKED-ON-C6 governance pickup).** [`packages/contracts/src/session.ts:388`](../../packages/contracts/src/session.ts) declares `SessionSubscribe` response as `AsyncIterable<EventEnvelope>` (TypeScript type), NOT a wire spec. The Phase 1 substrate has no defined Content-Type, `data:` encoding rules, `id:` field semantics, `retry:` directive policy, `Last-Event-ID` resumption protocol, heartbeat cadence, or end-of-stream / error envelope framing. (SSE adapter selection is settled by BL-104: tRPC's shared `resolveResponse.ts` substrate via `@trpc/server/adapters/fetch` on Cloudflare Workers — see §Decision Log.) C-6 governance scope already covers the daemon-side `LocalSubscription` primitive (per Plan-007 §Cross-Plan Obligations CP-007-1 BLOCKED-ON-C6); the SSE wire frame is the control-plane analog and resolves jointly. Authoritative contract lands in [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) §Plan-008 or a new `sse-contracts.md`.
- [ ] **tRPC procedures typed surface declared (BLOCKED-ON-C6 governance pickup).** Per-procedure shape (query/mutation/subscription, schema imports, middleware ordering) is undeclared in the corpus — same C-6 governance scope as Plan-007's `MethodRegistry` typed surface. Authoritative tRPC procedure shape lands in api-payload-contracts.md §Plan-008.
- [ ] **`EventEnvelope` semantics owner ([Plan-006](./006-session-event-taxonomy-and-audit-log.md) Tier 4) shipped or placeholder declared.** The SSE substrate consumes `EventEnvelope` from `packages/contracts/src/event.ts` — same forward-declaration gap as Plan-001 F-001-2-06. Plan-008-bootstrap consumes the placeholder; Plan-006 completion at Tier 4 widens the schema and cascades into the SSE substrate's frame body without breaking the wire substrate.

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Cross-Plan Obligations

The Tier 1 bootstrap-deliverable Plan-008-bootstrap ships at Phase 1 carries reciprocal obligations to downstream consumers. This section makes those obligations visible to a Plan-008 reviewer without requiring them to read every consuming plan first. Mirrors the bidirectional-citation pattern established by [Plan-001 §Cross-Plan Obligations](./001-shared-session-core.md#cross-plan-obligations) (CP-001-1 / CP-001-2) and [Plan-007 §Cross-Plan Obligations](./007-local-ipc-and-daemon-control.md#cross-plan-obligations) (CP-007-1..5).

### CP-008-1 — `sessionRouter` HTTP transport + SSE substrate owed to [Plan-001](./001-shared-session-core.md) Phase 5

Plan-008-bootstrap Phase 1 ships the tRPC v11 `sessionRouter` HTTP handlers + SSE substrate that Plan-001 Phase 5's control-plane-side `sessionClient` consumes. The contract surface includes (a) the per-procedure tRPC shapes (`SessionCreate` / `SessionRead` / `SessionJoin` query-or-mutation classification + Zod schema imports per F-008b-1-03 / BLOCKED-ON-C6), (b) the SSE wire frame primitive (Content-Type, `data:` encoding, `id:`/`retry:`/`Last-Event-ID` semantics per F-008b-1-01 / BLOCKED-ON-C6), and (c) the production-deployment + feature-flag gate (per I-008-1) so Plan-001 Phase 5 integration tests against a `wrangler dev` bootstrap (workerd local environment with `env.ENVIRONMENT === 'development'`).

**Why bidirectional.** Plan-001 Phase 5 (line ~261-274) names "the Plan-008 bootstrap-deliverable substrate" as its precondition; without CP-008-1 on the Plan-008 side, the obligation is one-directional.

### CP-008-2 — `runtimeNodeAttach` registration surface owed to [Plan-003](./003-runtime-node-attach.md)

Plan-003 (line ~79) cites the Plan-008 bootstrap's tRPC v11 host as the registration surface for runtime-node-attach procedures. Tier 1 ships only the host + sessionRouter; the runtime-node-attach surface registers against the same host at its own tier. Plan-008-bootstrap MUST expose a stable router-mounting surface so Plan-003 can attach without forking the host topology.

**Why bidirectional.** Plan-003 derivatively cites Plan-008's host runtime declaration. Per BL-104 / C-4 resolution (2026-04-30), the runtime is Cloudflare Workers via `@trpc/server/adapters/fetch`; Plan-003's CP-003-2 reciprocal text was updated in lockstep with this amendment so both plans cite the same runtime authoritatively.

### CP-008-3 — `EventEnvelope` schema reciprocity with [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (Tier 4)

Plan-008-bootstrap's SSE substrate consumes `EventEnvelope` from `packages/contracts/src/event.ts`. Per the Plan-001 F-001-2-06 forward-declaration pattern, Plan-001 Phase 2 ships a placeholder shape that Plan-006 widens at Tier 4 with the canonical event-taxonomy registry. CP-008-3 declares Plan-008-bootstrap's obligation to rebind onto the Plan-006 EventEnvelope shape when Tier 4 lands — the SSE wire frame body changes without changing the wire framing itself.

**Why bidirectional.** Plan-006 reviewers must see that Plan-008-bootstrap is a forward-declared consumer; Plan-008 reviewers must see that the placeholder shape is provisional and the Plan-006 widening is required at Tier 4.

## Target Areas

- `packages/control-plane/src/server/` — Tier 1 bootstrap-deliverable: Cloudflare Workers host (entry point: `fetchRequestHandler` from `@trpc/server/adapters/fetch`) + tRPC v11 router registration scaffolding (per [ADR-014](../decisions/014-trpc-control-plane-api.md))
- `packages/control-plane/wrangler.toml` — Tier 1 bootstrap-deliverable: workerd local-dev + Cloudflare Workers deployment configuration. Top-level `[vars]` holds development defaults (consumed by `wrangler dev` without an `--env` flag); `[env.production.vars]` overrides them for `wrangler deploy --env production`. This layout enforces I-008-1 gate #2 — see T-008b-1-1 for the full key/value matrix
- `packages/control-plane/src/sessions/session-router.ts` — Tier 1 bootstrap-deliverable: typed tRPC procedures wrapping Plan-001's `session-directory-service.ts`
- `packages/control-plane/src/sessions/session-subscribe-sse.ts` — Tier 1 bootstrap-deliverable: SSE transport plumbing for `SessionSubscribe`
- `packages/contracts/src/session-join/` — Tier 5 remainder
- `packages/control-plane/src/sessions/session-join-service.ts` — Tier 5 remainder
- `packages/control-plane/src/relay/relay-broker-service.ts` — Tier 5 remainder
- `packages/control-plane/src/presence/presence-register-service.ts` — Tier 5 remainder
- `packages/client-sdk/src/sessionJoinClient.ts` — Tier 5 remainder
- `apps/desktop/renderer/src/session-join/` — Tier 8 follow-up (renderer subtree per [cross-plan-dependencies.md §2 `apps/desktop/renderer/` row](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map))
- `apps/cli/src/session-join/` — Tier 5 remainder

## Data And Storage Changes

- Add shared join, reconnect, and relay-negotiation records needed to correlate membership, presence, and relay attempts.
- Extend presence history with reconnect-association metadata where needed for duplicate suppression.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for column definitions.

## API And Transport Changes

- Add `SessionJoin`, `PresenceRegister`, `RelayNegotiation`, and `SessionResumeAfterReconnect` to shared contracts and client SDKs.
- Ensure relay negotiation only exposes the minimum transport data required to establish connectivity.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.
- Tier markers below correspond to §Execution Windows (V1 Carve-Out): `[Tier 1]` = ships in Plan-008-bootstrap; `[Tier 5]` = ships in Plan-008-remainder; `[Tier 8]` = renderer follow-up.
- Plan-008's invariants govern tier scoping — see §Invariants I-008-1 (bootstrap is operator-development-only behind a feature flag), I-008-2 (Tier 5 production invariants), I-008-3 (substrate wraps, never re-implements directory service).

1. **[Tier 1: tRPC server skeleton + sessionRouter + SSE substrate; Tier 5: relay-negotiation + presence + reconnect contracts]** Define authenticated join, presence, reconnect, and relay-negotiation contracts. Include the relay wire format for relay messages. Per F-008b-1-07 expansion, the Tier 1 portion breaks into 4 sub-actions:
   - **(a)** Register tRPC v11 router via `@trpc/server/adapters/fetch` (Cloudflare Workers per ADR-014 + BL-104 resolution). The Worker's default `fetch` export delegates to `fetchRequestHandler({ endpoint, req, router, createContext })`; no separate adapter package beyond `@trpc/server/adapters/fetch` is required.
   - **(b)** Wire the I-008-1 dual-gate enforcement at the request-entry site: feature-flag check (`CONTROL_PLANE_BOOTSTRAP_ENABLED=1` from `env`) AND production-deployment check (`env.ENVIRONMENT !== 'production'` per F-008b-1-04 Workers reformulation) — both refusal paths return HTTP 503 immediately before any router dispatch.
   - **(c)** SSE subscription handling for `SessionSubscribe` is provided natively by tRPC's shared HTTP resolver (`resolveResponse.ts` substrate) which all adapters — including the fetch adapter on Workers — delegate to for subscription procedures. The substrate detects `proc._def.type === 'subscription'`, sets SSE headers, and wraps async generators / observables into a `ReadableStream`. No separate SSE adapter required. (BLOCKED-ON-C6 still applies to the canonical wire-frame primitive — Content-Type / `data:` encoding / `id:`/`retry:` semantics — landing in api-payload-contracts.md §Plan-008.)
   - **(d)** Inject `SessionDirectoryService` per I-008-3 enforcement mechanism #1 (constructor injection): factory function takes the directory-service instance and returns the typed tRPC router.
2. **[Tier 5]** Implement control-plane join and presence services with membership verification and invite-acceptance handoff. Requires Plan-002 (invite/presence) substrates per I-008-2.
3. **[Tier 5]** Implement relay broker flows and reconnect association logic without coupling them to execution authority. V1 relay encryption uses pairwise X25519 ECDH + XChaCha20-Poly1305 (via `@noble/curves` and `@noble/ciphers`) with Ed25519 signature verification over each participant's ephemeral X25519 key bundle per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md). Relay sharding targets 25 connections per data DO using WebSocket Hibernation for Durable Objects. Relay authentication uses PASETO v4 tokens (per ADR-010, requires Plan-018 issuer surface — I-008-2).
4. **[Tier 8 — blocked until Plan-023 ships for renderer; Tier 5 for CLI]** Add desktop and CLI shared-session join surfaces plus typed client SDK integration. CLI surface ships at Tier 5 alongside the join service; desktop renderer subtree at `apps/desktop/renderer/src/session-join/` ships at Tier 8 once Plan-023 creates the renderer tree (per [cross-plan-dependencies.md §2 row for `apps/desktop/renderer/`](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map)).

## Tier 1 Bootstrap PR Sequence

The Tier 1 bootstrap-deliverable (per §Execution Windows above) lands as **1 small PR**. The Tier 5 remainder PR breakdown is deferred to plan-execution time when Tier 5 begins.

### Phase 1: Bootstrap (tRPC v11 server + `sessionRouter` + SSE substrate)

**Goal:** Plan-008-bootstrap ships end-to-end behind passing tRPC + SSE integration tests. `sessionRouter` exposes Plan-001 Phase 4's `session-directory-service.ts` over HTTP; `SessionSubscribe` SSE substrate is functional. Plan-001 Phase 5 unblocks on this PR's merge (in conjunction with Plan-007 partial Phase 3).

**Spec-008 AC coverage (per F-008b-1-06).** Phase 1 covers NO Spec-008 AC. The substrate-only deliverable is a Tier 1 unblock for Plan-001 Phase 5; [Spec-008](../specs/008-control-plane-relay-and-session-join.md) lines 241-243 (3 ACs: authenticated session join, direct↔relay switching, control-plane-not-execution-authority) all require Tier 5 surfaces (relay broker, presence register, invite handoff) and land in Plan-008-remainder. The §Done Checklist explicitly enforces this — the gate cannot be flipped to `completed` on the basis of skeleton-only delivery.

**Precondition:** [Plan-001](./001-shared-session-core.md) Phase 4 merged (the bootstrap wraps that PR's `packages/control-plane/src/sessions/session-directory-service.ts` — already shipped 2026-04-27 per [GitHub PR-#10](https://github.com/Sawmonabo/ai-sidekicks/pull/10)). Plan-001 Phase 2 schemas (`packages/contracts/src/session.ts` + `packages/contracts/src/event.ts`) merged. ADR-014 runtime authorization reconciled per §Preconditions (BL-104 resolved 2026-04-30 — Cloudflare Workers via `@trpc/server/adapters/fetch`).

- `packages/control-plane/src/server/` — host + tRPC v11 router registration scaffolding per [ADR-014](../decisions/014-trpc-control-plane-api.md). **Runtime: Cloudflare Workers via `@trpc/server/adapters/fetch`** (BL-104 resolved 2026-04-30 — see §Decision Log). Local development uses workerd (`wrangler dev`); production deploys to Cloudflare's edge. Skeleton only — relay broker / presence register / invite handlers ship in Plan-008-remainder at Tier 5. Per §Invariants I-008-1, the bootstrap MUST be gated behind a feature flag (e.g., `CONTROL_PLANE_BOOTSTRAP_ENABLED=1`) defaulting to off AND must enforce the production-deployment gate (per I-008-1 verification gate #2 + F-008b-1-04 Workers reformulation); production deployment configurations MUST NOT set the flag until Tier 5.
- `packages/control-plane/src/sessions/session-router.ts` — typed tRPC procedures wrapping Plan-001 Phase 4's `session-directory-service.ts`. The router does NOT re-implement directory logic per §Invariants I-008-3 (constructor-injection enforcement). Per F-008b-1-03 resolution, the procedures are:

  | tRPC procedure | Procedure type | Input schema (from `packages/contracts/src/session.ts`) | Output schema | Directory-service method called | Tier 1 middleware |
  | --- | --- | --- | --- | --- | --- |
  | `session.create` | `mutation` | `SessionCreateRequestSchema` | `SessionCreateResponseSchema` | `directoryService.createSession(...)` | request-id stamping; Querier-injection context (no PASETO/rate-limit at Tier 1 — those land at Tier 5 per I-008-2) |
  | `session.read` | `query` | `SessionReadRequestSchema` | `SessionReadResponseSchema` | `directoryService.readSession(...)` | request-id stamping; Querier-injection context |
  | `session.join` | `mutation` | `SessionJoinRequestSchema` | `SessionJoinResponseSchema` | `directoryService.joinSession(...)` | request-id stamping; Querier-injection context (Tier 1 stub: rejects non-self joins until invite/presence land at Tier 5 — see I-008-2) |

  The procedure type assignments follow the tRPC convention: read-only operations use `query` (HTTP GET-like, idempotent); writes/state-changes use `mutation` (HTTP POST-like, non-idempotent). BLOCKED-ON-C6 confirmation: api-payload-contracts.md §Plan-008 must ratify these procedure-type assignments and the canonical method-name strings (`session.create` vs `session/create` etc.) per the C-6 method-name convention scope shared with Plan-007.

- `packages/control-plane/src/sessions/session-subscribe-sse.ts` — SSE transport plumbing for `SessionSubscribe`. The contract is request-only on the wire; the response is an `AsyncIterable<EventEnvelope>` SSE stream per `packages/contracts/src/session.ts:388`. Bootstrap supplies only the transport — event sourcing into the stream remains Plan-006's domain. **Wire frame BLOCKED-ON-C6 governance pickup** — until api-payload-contracts.md §Plan-008 (or sse-contracts.md) declares Content-Type, `data:` encoding, `id:`/`retry:`/`Last-Event-ID` semantics, and heartbeat cadence, this file ships behind a conservative inline shape: `Content-Type: text/event-stream; charset=utf-8`; `Cache-Control: no-store`; `X-Accel-Buffering: no`; one `EventEnvelope` per SSE event encoded as `data: <single-line JSON>`; `id:` carries the `EventCursor` value from Plan-006 (or placeholder string at Tier 1 pending Plan-006 widening); `retry: 5000`; on reconnect with `Last-Event-ID`, server emits all events strictly after that cursor; `event: heartbeat\ndata: {}\n\n` every 15s. **SSE adapter selection is settled by BL-104 resolution:** tRPC v11's shared HTTP resolver (`packages/server/src/unstable-core-do-not-import/http/resolveResponse.ts` upstream) detects subscription procedures and produces the SSE-streaming `Response` natively when invoked through `@trpc/server/adapters/fetch`'s `fetchRequestHandler` on Cloudflare Workers. No separate SSE adapter is required.

#### Tasks

- **T-008b-1-1** (Files: `packages/control-plane/src/server/host.ts` (CREATE) + `packages/control-plane/src/server/feature-flag-gate.ts` (CREATE) + `packages/control-plane/src/server/production-deployment-gate.ts` (CREATE) + `packages/control-plane/wrangler.toml` (CREATE); Verifies invariant: I-008-1 dual-gate; Spec coverage: per F-008b-1-06, NO Spec-008 AC at Tier 1) — Implement the tRPC v11 host scaffolding (Cloudflare Workers via `@trpc/server/adapters/fetch`'s `fetchRequestHandler`, per BL-104 resolution) behind I-008-1 dual-gate enforcement. The feature-flag gate (`env.CONTROL_PLANE_BOOTSTRAP_ENABLED === '1'` checked at request-entry, refuse-with-503 before router dispatch when unset) AND the production-deployment gate (`env.ENVIRONMENT !== 'production'` per F-008b-1-04 Workers reformulation, refuse-with-503 even with flag set when running under the `[env.production]` wrangler config) BOTH ship in this task. The `wrangler.toml` uses top-level `[vars]` (read by `wrangler dev` workerd local without an `--env` flag, since named `[env.NAME]` blocks load only when `--env`/`-e` or `CLOUDFLARE_ENV` is set) for development defaults — `ENVIRONMENT = "development"`; `CONTROL_PLANE_BOOTSTRAP_ENABLED = "1"`. `[env.production]` overrides for production deploys: `[env.production.vars]` sets `ENVIRONMENT = "production"` and MUST NOT set the bootstrap flag until Tier 5; `wrangler deploy --env production` consumes this block. The earlier draft of this task incorrectly named `[env.dev]` as the `wrangler dev` default, which would have left `env.ENVIRONMENT` unset on default `wrangler dev` runs and broken T-008b-1-T3's `env.ENVIRONMENT === 'development'` assertion. Tests: T-008b-1-T1 handler refuses to serve without flag (I-008-1 gate #1); T-008b-1-T2 handler refuses with 503 in production environment even with flag set (I-008-1 gate #2); T-008b-1-T3 handler serves successfully with flag set in dev environment under `wrangler dev`.
- **T-008b-1-2** (Files: `packages/control-plane/src/sessions/session-router.ts` (CREATE) + `packages/control-plane/src/sessions/session-router.factory.ts` (CREATE); Verifies invariant: I-008-3 enforcement #1 (constructor injection); Spec coverage: §Cross-Plan Obligations CP-008-1) — Implement the typed tRPC router via `createSessionRouter(directoryService: SessionDirectoryService): TRPCRouter` factory. The 3 procedures (per the table above) bind to `directoryService.createSession` / `readSession` / `joinSession` exclusively; the factory does NOT instantiate `Querier` or `pg.Pool` directly. **BLOCKED-ON-C6** — once api-payload-contracts.md §Plan-008 ratifies the procedure-type assignments + canonical method-name strings, this task pins the values; until C-6 resolves, the conservative inline values `session.create` / `session.read` / `session.join` (dotted-lowercase) ship per the C-6 leaning shared with Plan-007. Tests: T-008b-1-T4 round-trip `session.create` end-to-end against `pg.Pool`-backed `Querier` (I-001-1 lock-ordering inherited via directory service); T-008b-1-T5 round-trip `session.read`; T-008b-1-T6 round-trip `session.join` (Tier 1 stub: self-joins succeed; non-self joins reject with `auth.not_authorized` until Tier 5 invite/presence lands).
- **T-008b-1-3** (Files: `packages/control-plane/src/sessions/session-subscribe-sse.ts` (CREATE) + `packages/control-plane/src/sessions/session-subscribe-sse.factory.ts` (CREATE); Verifies invariant: I-008-3 enforcement #1 (constructor injection); Spec coverage: §Cross-Plan Obligations CP-008-1 + CP-008-3) — Implement SSE substrate via `createSessionSubscribeSse(directoryService: SessionDirectoryService): SseHandler` factory. The SSE-streaming `Response` is produced natively by tRPC's shared HTTP resolver when the subscription procedure is invoked through `fetchRequestHandler`; the factory wires the directory-service into the subscription procedure's async-generator body. Conservative inline wire frame per the bullet above (frame-shaping logic centralized in the factory). **BLOCKED-ON-C6** — wire frame primitive may shift when api-payload-contracts.md §Plan-008 lands; the factory updates one file when C-6 resolves. Tests: T-008b-1-T7 SSE connection lifecycle (open + send synthetic EventEnvelope + close on disconnect); T-008b-1-T8 `Last-Event-ID` resumption (reconnect with header → server emits events strictly after cursor); T-008b-1-T9 heartbeat cadence (15s `event: heartbeat` frames in absence of data).
- **T-008b-1-4** (Files: `packages/control-plane/.eslintrc.js` (EXTEND with `no-restricted-imports`) + `packages/control-plane/test/sessions/router-no-sql.test.ts` (CREATE); Verifies invariant: I-008-3 enforcement #2 (ESLint rule) + #3 (unit-test introspection)) — Land the I-008-3 enforcement mechanism: ESLint `no-restricted-imports` rule forbidding `pg`, `pg-pool`, `@databases/pg` imports from `session-router.ts` and `session-subscribe-sse.ts`; CI fails on rule violation. Unit-test introspection asserts the two files' exported symbols call only `directoryService.*` methods (TypeScript symbol introspection or AST walker pinned in the test runner). Tests: T-008b-1-T10 ESLint rule trips on direct `pg` import in router; T-008b-1-T11 introspection assertion catches new SQL via direct `Querier` instantiation in router.
- **T-008b-1-5** (Files: `packages/client-sdk/test/transport/sse-roundtrip.test.ts` (CREATE) — stub-side test) — Per F-008b-1-09, Phase 1's _raison d'être_ is to unblock Plan-001 Phase 5; the integration handoff must be tested in this PR. T-008b-1-T12 round-trip integration test: a stub `sessionClient.subscribe` (using the contracts-side schema from Plan-001 Phase 2) connects to the Phase 1 SSE substrate, receives a synthetic `EventEnvelope` (sourced via test fixture, since Plan-006 event sourcing is out of Phase 1 scope), and verifies cursor-based resumption via `Last-Event-ID`. **BLOCKED-ON-C6** — frame shape may shift; test asserts on the conservative inline shape from T-008b-1-3 and updates when C-6 resolves. **Spec coverage:** Spec-008 §Required Behavior — control-plane transport SSE substrate integration with Plan-001 Phase 5 (cursor-based resumption via `Last-Event-ID`).

After Phase 1 merges (and Plan-007 partial Phase 3 also merges), [Plan-001 Phase 5](./001-shared-session-core.md#phase-5--client-sdk-and-desktop-bootstrap) can begin.

## Parallelization Notes

- Join-service work and relay-broker work can proceed in parallel once shared identity and presence contracts are stable.
- Client join surfaces should wait for reconnect-association semantics to stabilize.

## Test And Verification Plan

Tests are scoped per execution window. Tier 1 tests gate Tier 1 Phase 1 PR; Tier 5 tests gate the Plan-008-remainder PRs.

### [Tier 1] Plan-008-Bootstrap Tests (T-008b-1-T1..T12)

Substrate-only scope; no Spec-008 AC coverage at this tier (per F-008b-1-06 disclaimer in Phase 1 §Goal).

- **T-008b-1-T1** (Verifies I-008-1 gate #1) `packages/control-plane/test/server/feature-flag-gate.test.ts`: handler refuses to serve (HTTP 503) without `env.CONTROL_PLANE_BOOTSTRAP_ENABLED === '1'` in production environment; refusal logged + 503 returned before router dispatch.
- **T-008b-1-T2** (Verifies I-008-1 gate #2 + F-008b-1-04) `packages/control-plane/test/server/production-deployment-gate.test.ts`: handler refuses to serve (HTTP 503) when `env.ENVIRONMENT === 'production'` even with the bootstrap flag set; refusal logged before router dispatch.
- **T-008b-1-T3** Handler serves successfully with flag set in dev environment under `wrangler dev` (workerd local; `env.ENVIRONMENT === 'development'`).
- **T-008b-1-T4..T6** (Verifies I-008-3 + CP-008-1) `packages/control-plane/test/sessions/session-router.test.ts`: end-to-end tRPC integration tests for `session.create` / `session.read` / `session.join` against a `pg.Pool`-backed `Querier`. Lock-ordering (I-001-1) inherited via directory-service routing.
- **T-008b-1-T7** (Verifies CP-008-1 SSE substrate) SSE connection lifecycle: open + send synthetic `EventEnvelope` + close on disconnect. **BLOCKED-ON-C6** — frame shape may shift.
- **T-008b-1-T8** `Last-Event-ID` resumption: reconnect with header → server emits events strictly after the cursor.
- **T-008b-1-T9** Heartbeat cadence: `event: heartbeat\ndata: {}\n\n` every 15s in absence of data.
- **T-008b-1-T10** (Verifies I-008-3 enforcement #2) ESLint `no-restricted-imports` trips on direct `pg` import in `session-router.ts` or `session-subscribe-sse.ts`.
- **T-008b-1-T11** (Verifies I-008-3 enforcement #3) Unit-test introspection catches new SQL via direct `Querier` instantiation in router file.
- **T-008b-1-T12** (Verifies CP-008-1 + F-008b-1-09 round-trip) `packages/client-sdk/test/transport/sse-roundtrip.test.ts`: stub `sessionClient.subscribe` connects to the Phase 1 SSE substrate, receives synthetic `EventEnvelope`, verifies cursor-based resumption via `Last-Event-ID`. This is the highest-value Phase 1 test — proves the unblock for Plan-001 Phase 5 is real.

### [Tier 5] Plan-008-Remainder Tests

- Membership-verified join integration tests
- Presence re-association tests across reconnect and transport-path changes
- Relay negotiation tests proving join remains valid even when relay setup degrades
- Pairwise X25519 + XChaCha20-Poly1305 encryption round-trip tests covering ephemeral-key zeroization on session end, HKDF-SHA256 session-key derivation, and Ed25519 signature verification over the ephemeral X25519 key bundle

## Rollout Order

1. Ship authenticated join and presence registration
2. Enable reconnect association and replay-oriented join responses
3. Enable relay negotiation as a secondary connectivity path

## Rollback Or Fallback

- Disable relay negotiation and keep direct control-plane join only if relay rollout regresses while preserving session-join correctness.

## Risks And Blockers

- Session-join traffic requirements for admin or recovery flows remain unresolved (operational sizing deferred; see parent [Spec-008](../specs/008-control-plane-relay-and-session-join.md))
- Presence duplication is likely if reconnect association is not made authoritative early

## Done Checklist

### Tier 1 (Plan-008-Bootstrap)

- [ ] All Tier 1 T-008b-1-T1..T12 tests pass
- [ ] Invariants I-008-1 (BOTH gates: feature flag AND production-deployment), I-008-3 (constructor injection + ESLint rule + unit-test introspection — all 3 enforcement mechanisms) verified at Tier 1 scope
- [ ] §Cross-Plan Obligations CP-008-1 + CP-008-2 + CP-008-3 surfaces ship verified
- [ ] BLOCKED-ON-C6 governance pickup tracked: api-payload-contracts.md §Plan-008 ratifies tRPC procedure-type assignments + canonical method-name strings; conservative inline values replaced with imported types
- [ ] BLOCKED-ON-C6 governance pickup tracked: SSE wire frame primitive declared in api-payload-contracts.md §Plan-008 (or sse-contracts.md); Content-Type, `data:` encoding, `id:`/`retry:`/`Last-Event-ID` semantics, heartbeat cadence, tRPC adapter selection authoritative
- [x] BL-104 / C-4 governance pickup completed (2026-04-30): ADR-014 honored verbatim — Cloudflare Workers via `@trpc/server/adapters/fetch` for Tier 1 bootstrap and Tier 5 production. See §Decision Log.
- [ ] Spec-008 AC coverage disclaimer enforced: Phase 1 explicitly does NOT cover any Spec-008 AC (per F-008b-1-06); the Tier 5 Done Checklist tracks Spec-008 AC coverage at the relay/presence/invite surface
- [ ] Plan-001 Phase 5's `sessionClient` consumes the SSE substrate from CP-008-1 + the round-trip test from T-008b-1-T12 without modification

### Tier 5 (Plan-008-Remainder)

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
- [ ] Spec-008 ACs (lines 241-243) all verified at Tier 5: authenticated session join, direct↔relay switching, control-plane-not-execution-authority

## Decision Log

| Date | Event | Notes |
| --- | --- | --- |
| 2026-04-14 | Plan drafted | Initial Plan-008 authored by Codex |
| 2026-04-30 | Runtime amended (BL-104 / C-4 resolved) | Tier 1 bootstrap and Tier 5 production runtime confirmed as Cloudflare Workers via `@trpc/server/adapters/fetch` per [ADR-014](../decisions/014-trpc-control-plane-api.md). Resolution path (b) chosen: Plan-008 amended; ADR-014 honored verbatim — no ADR amendment. Local development uses workerd via `wrangler dev` (Miniflare v3) per [ADR-014 Assumption #1](../decisions/014-trpc-control-plane-api.md#assumptions-audit). I-008-1 gate #2 reformulated from "loopback-bind gate" to "production-deployment gate" since Cloudflare Workers do not expose a host-bind surface; the gate now refuses HTTP 503 when `env.ENVIRONMENT === 'production'` even with the bootstrap flag set, preserving the original gate's intent (prevent accidental production exposure). SSE substrate selection settled: tRPC v11's shared HTTP resolver (`resolveResponse.ts` upstream) detects subscription procedures and produces SSE-streaming `Response` natively when invoked via `fetchRequestHandler`; no separate adapter required. Primary-source verification: [resolveResponse.ts on tRPC main branch](https://github.com/trpc/trpc/blob/main/packages/server/src/unstable-core-do-not-import/http/resolveResponse.ts). Free-tier capacity verified for V1: Workers Free supplies 100k requests/day with no effective limit on SSE response duration per [Cloudflare Agents HTTP and SSE docs](https://developers.cloudflare.com/agents/api-reference/http-sse/), comfortably covering a 50-developer team's projected 3-12k req/day control-plane workload. Reasoning: dev-prod parity (12-factor §10), single adapter / single deployment topology / no future Tier 1→Tier 5 migration PR (regression-surface elimination), Workers V8-isolate sandbox provides defense-in-depth versus Node syscall surface, training-data density tradeoff accepted because `wrangler dev` is canonical and well-documented. See conversation transcript 2026-04-30 for full SWE/architect + AI-engineer two-perspective analysis. |
