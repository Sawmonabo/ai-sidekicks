# Plan-008: Control Plane Relay And Session Join

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**          | `approved`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **NNN**             | `008`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Slug**            | `control-plane-relay-and-session-join`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Date**            | `2026-04-14`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Author(s)**       | `Codex`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Spec**            | [Spec-008: Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Required ADRs**   | [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md), [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md), [ADR-014](../decisions/014-trpc-control-plane-api.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Dependencies**    | **Tier 1 / Tier 5 split** per [cross-plan-dependencies.md §5 Plan-008 Bootstrap-vs-Remainder Carve-Out](../architecture/cross-plan-dependencies.md#plan-008-bootstrap-vs-remainder-carve-out-tier-1--tier-5) — Plan-008-bootstrap (tRPC v11 server skeleton + `sessionRouter` + SSE substrate) ships at Tier 1 with [Plan-001](./001-shared-session-core.md) Phase 4 as the sole upstream prerequisite (file-level dependency on `packages/control-plane/src/sessions/session-directory-service.ts`; Phase 4 must be merged before bootstrap can start — already shipped at Tier 1) to unblock Plan-001 Phase 5; Plan-008-remainder ships at Tier 5 with [Plan-001](./001-shared-session-core.md) (session core) + [Plan-002](./002-invite-membership-and-presence.md) (invite/presence) as plan-level dependencies. [Spec-024](../specs/024-cross-node-dispatch-and-approval.md) (implicit cross-node dispatch surface per [cross-plan-dependencies.md §Spec-024 Implementation Plan](../architecture/cross-plan-dependencies.md#spec-024-implementation-plan)) is consumed by Plan-008-remainder. See §Execution Windows (V1 Carve-Out) below. |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **References**      | [Spec-008](../specs/008-control-plane-relay-and-session-join.md) (V1 relay encryption: pairwise X25519 + XChaCha20-Poly1305 per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md); MLS deferred to V1.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Execution Windows (V1 Carve-Out)

Plan-008 ships in two windows — a **Tier 1 bootstrap-deliverable** (tRPC server skeleton + `sessionRouter` + SSE substrate) that unblocks [Plan-001](./001-shared-session-core.md) Phase 5, and a **Tier 5 remainder** that completes the relay/presence/invite surface. The split is documented authoritatively in [cross-plan-dependencies.md §5 Plan-008 Bootstrap-vs-Remainder Carve-Out](../architecture/cross-plan-dependencies.md#plan-008-bootstrap-vs-remainder-carve-out-tier-1--tier-5); this section is the plan-side restatement so engineers reading Plan-008 in isolation see the split.

The carve-out follows the **substrate-vs-namespace decomposition rule** documented authoritatively in [Plan-007 §Execution Windows](./007-local-ipc-and-daemon-control.md#execution-windows-v1-carve-out) — the _transport substrate_ (tRPC server + sessionRouter + SSE plumbing) is what Plan-001 Phase 5 consumes; the _relay/presence behavior_ is what Plan-008 owns canonically. Substrate ships first.

### Tier 1 — Plan-008-Bootstrap (tRPC server + `sessionRouter` + SSE substrate)

Lands alongside Plan-001 to unblock Plan-001 Phase 5 (`sessionClient` over the control-plane transport). Scope:

- **tRPC v11 server skeleton** — Fastify host + tRPC v11 router registration scaffolding per [ADR-014](../decisions/014-trpc-control-plane-api.md). Bootstrap ships only the skeleton; relay broker / presence register / invite handlers are Tier 5.
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

**Why load-bearing.** Spec-027 §Required Behavior governs the daemon-side bind-time secure-defaults surface (Plan-007's domain), but the SaaS Fastify host that Plan-008-bootstrap creates is **explicitly outside Spec-027 scope** per [ADR-020](../decisions/020-v1-deployment-model-and-oss-license.md) (the SaaS deployment model is operator-provisioned hosting; Spec-027 governs self-host operator-facing daemon defaults). Production auth, rate-limiting (Plan-021), PASETO v4 token validation (Plan-018), and relay encryption (Plan-008-remainder) are all **NOT YET PRESENT** at Tier 1 — exposing the bootstrap to production traffic would bypass those surfaces entirely.

**Verification.** Tier 1 PR must wire the bootstrap behind a feature flag (e.g., `CONTROL_PLANE_BOOTSTRAP_ENABLED=1`) that defaults off; production deployment configurations MUST NOT set the flag until Tier 5. Negative-path test: server refuses to start without the flag in `NODE_ENV=production`.

### I-008-2 — Tier 5 production invariants apply once their substrates land

The full set of production-grade invariants — PASETO v4 token validation on every endpoint (per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) + Plan-018), rate-limiting middleware (per Plan-021), relay-broker encryption (pairwise X25519 + XChaCha20-Poly1305 per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)), invite-acceptance handoff to Plan-002 — apply at Tier 5 once Plan-002 (invite/presence), Plan-018 (PASETO issuer), and Plan-021 (rate-limiter contract) substrates land. Plan-008-remainder MUST gate those surfaces on their dependencies being satisfied per [cross-plan-dependencies.md §5 Tier 5 Prereqs](../architecture/cross-plan-dependencies.md#5-canonical-build-order).

**Why load-bearing.** Shipping Tier 5 surfaces without their dependencies would either silently no-op (auth bypass) or hard-fail at runtime. The dependency tier graph is the only way to keep the substrate composition correct.

**Verification.** Tier 5 PRs must reference and wire the actual Plan-018 + Plan-021 + Plan-002 surfaces (not stubs). Integration tests must exercise the full auth + rate-limit + relay-encryption stack end-to-end before Tier 5 PRs merge.

### I-008-3 — Substrate wraps, never re-implements, the directory service

Plan-008-bootstrap's `sessionRouter` and `session-router.ts` MUST wrap the existing `packages/control-plane/src/sessions/session-directory-service.ts` shipped by Plan-001 Phase 4. Re-implementing directory logic in the router would fork the lock-ordering invariant (per [Plan-001 §Invariants I-001-1](./001-shared-session-core.md#invariants)) and break the `Querier`-driven test pattern Plan-001 Phase 5 strengthens.

**Why load-bearing.** Plan-001 owns the directory service. Plan-008 owns the HTTP transport. Conflating the two violates the Plan-001 ownership row in [cross-plan-dependencies.md §2 `packages/control-plane/src/sessions/`](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map).

**Verification.** Static-analysis / code-review check: `session-router.ts` and `session-subscribe-sse.ts` MUST import `session-directory-service.ts` and route to it; they MUST NOT add new SQL or duplicate directory-service responsibilities.

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/control-plane/src/server/` — Tier 1 bootstrap-deliverable: Fastify host + tRPC v11 router registration scaffolding (per [ADR-014](../decisions/014-trpc-control-plane-api.md))
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

1. **[Tier 1: tRPC server skeleton + sessionRouter + SSE substrate; Tier 5: relay-negotiation + presence + reconnect contracts]** Define authenticated join, presence, reconnect, and relay-negotiation contracts. Include the relay wire format for relay messages. Tier 1 bootstrap defines only the `sessionRouter` shape and SSE substrate plumbing per §Tier 1 Bootstrap PR Sequence below; relay-wire-format and reconnect-association contracts ship at Tier 5.
2. **[Tier 5]** Implement control-plane join and presence services with membership verification and invite-acceptance handoff. Requires Plan-002 (invite/presence) substrates per I-008-2.
3. **[Tier 5]** Implement relay broker flows and reconnect association logic without coupling them to execution authority. V1 relay encryption uses pairwise X25519 ECDH + XChaCha20-Poly1305 (via `@noble/curves` and `@noble/ciphers`) with Ed25519 signature verification over each participant's ephemeral X25519 key bundle per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md). Relay sharding targets 25 connections per data DO using WebSocket Hibernation for Durable Objects. Relay authentication uses PASETO v4 tokens (per ADR-010, requires Plan-018 issuer surface — I-008-2).
4. **[Tier 8 — blocked until Plan-023 ships for renderer; Tier 5 for CLI]** Add desktop and CLI shared-session join surfaces plus typed client SDK integration. CLI surface ships at Tier 5 alongside the join service; desktop renderer subtree at `apps/desktop/renderer/src/session-join/` ships at Tier 8 once Plan-023 creates the renderer tree (per [cross-plan-dependencies.md §2 row for `apps/desktop/renderer/`](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map)).

## Tier 1 Bootstrap PR Sequence

The Tier 1 bootstrap-deliverable (per §Execution Windows above) lands as **1 small PR**. The Tier 5 remainder PR breakdown is deferred to plan-execution time when Tier 5 begins.

### Phase 1: Bootstrap (tRPC v11 server + `sessionRouter` + SSE substrate)

**Goal:** Plan-008-bootstrap ships end-to-end behind passing tRPC + SSE integration tests. `sessionRouter` exposes Plan-001 Phase 4's `session-directory-service.ts` over HTTP; `SessionSubscribe` SSE substrate is functional. Plan-001 Phase 5 unblocks on this PR's merge (in conjunction with Plan-007 partial Phase 3).

**Precondition:** [Plan-001](./001-shared-session-core.md) Phase 4 merged (the bootstrap wraps that PR's `packages/control-plane/src/sessions/session-directory-service.ts` — already shipped 2026-04-27 per [GitHub PR-#10](https://github.com/Sawmonabo/ai-sidekicks/pull/10)).

- `packages/control-plane/src/server/` — Fastify host + tRPC v11 router registration scaffolding per [ADR-014](../decisions/014-trpc-control-plane-api.md). Skeleton only — relay broker / presence register / invite handlers ship in Plan-008-remainder at Tier 5. Per §Invariants I-008-1, the bootstrap MUST be gated behind a feature flag (e.g., `CONTROL_PLANE_BOOTSTRAP_ENABLED=1`) defaulting to off; production deployment configurations MUST NOT set the flag until Tier 5.
- `packages/control-plane/src/sessions/session-router.ts` — typed tRPC procedures for `SessionCreate`, `SessionRead`, `SessionJoin` wrapping the existing `session-directory-service.ts` (Plan-001 Phase 4). The router does not re-implement directory logic per §Invariants I-008-3.
- `packages/control-plane/src/sessions/session-subscribe-sse.ts` — SSE transport plumbing for `SessionSubscribe`. The contract is request-only on the wire; the response is an `AsyncIterable<EventEnvelope>` SSE stream per `packages/contracts/src/session.ts:388`. Bootstrap supplies only the transport — event sourcing into the stream remains Plan-006's domain.
- Tests: tRPC integration tests for `sessionRouter` create/read/join end-to-end against a `pg.Pool`-backed `Querier`; SSE substrate test verifying connection lifecycle (open, send, close on disconnect); negative-path test for I-008-1 — server refuses to start without `CONTROL_PLANE_BOOTSTRAP_ENABLED=1` in `NODE_ENV=production`; static-analysis assertion for I-008-3 (router imports session-directory-service and does not introduce new SQL).

After Phase 1 merges (and Plan-007 partial Phase 3 also merges), [Plan-001 Phase 5](./001-shared-session-core.md#phase-5--client-sdk-and-desktop-bootstrap) can begin.

## Parallelization Notes

- Join-service work and relay-broker work can proceed in parallel once shared identity and presence contracts are stable.
- Client join surfaces should wait for reconnect-association semantics to stabilize.

## Test And Verification Plan

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

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
