# Plan-008: Control Plane Relay And Session Join

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**          | `approved`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **NNN**             | `008`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Slug**            | `control-plane-relay-and-session-join`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Date**            | `2026-04-14`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Author(s)**       | `Codex`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Spec**            | [Spec-008: Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Required ADRs**   | [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md), [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md), [ADR-014](../decisions/014-trpc-control-plane-api.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Dependencies**    | **Tier 1 / Tier 5 split** per [cross-plan-dependencies.md §5 Plan-008 Bootstrap-vs-Remainder Carve-Out](../architecture/cross-plan-dependencies.md#plan-008-bootstrap-vs-remainder-carve-out-tier-1--tier-5) — Plan-008-bootstrap (tRPC v11 server skeleton + `sessionRouter` + SSE substrate) ships at Tier 1 with [Plan-001](./001-shared-session-core.md) PR #4 as the sole upstream prerequisite (file-level dependency on `packages/control-plane/src/sessions/session-directory-service.ts`; PR #4 must be merged before bootstrap can start — already shipped at Tier 1) to unblock Plan-001 PR #5; Plan-008-remainder ships at Tier 5 with [Plan-001](./001-shared-session-core.md) (session core) + [Plan-002](./002-invite-membership-and-presence.md) (invite/presence) as plan-level dependencies. [Spec-024](../specs/024-cross-node-dispatch-and-approval.md) (implicit cross-node dispatch surface per [cross-plan-dependencies.md §Spec-024 Implementation Plan](../architecture/cross-plan-dependencies.md#spec-024-implementation-plan)) is consumed by Plan-008-remainder. See §Execution Windows (V1 Carve-Out) below. |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **References**      | [Spec-008](../specs/008-control-plane-relay-and-session-join.md) (V1 relay encryption: pairwise X25519 + XChaCha20-Poly1305 per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md); MLS deferred to V1.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Execution Windows (V1 Carve-Out)

Plan-008 ships in two windows — a **Tier 1 bootstrap-deliverable** (tRPC server skeleton + `sessionRouter` + SSE substrate) that unblocks [Plan-001](./001-shared-session-core.md) PR #5, and a **Tier 5 remainder** that completes the relay/presence/invite surface. The split is documented authoritatively in [cross-plan-dependencies.md §5 Plan-008 Bootstrap-vs-Remainder Carve-Out](../architecture/cross-plan-dependencies.md#plan-008-bootstrap-vs-remainder-carve-out-tier-1--tier-5); this section is the plan-side restatement so engineers reading Plan-008 in isolation see the split.

The carve-out follows the **substrate-vs-namespace decomposition rule** documented authoritatively in [Plan-007 §Execution Windows](./007-local-ipc-and-daemon-control.md#execution-windows-v1-carve-out) — the _transport substrate_ (tRPC server + sessionRouter + SSE plumbing) is what Plan-001 PR #5 consumes; the _relay/presence behavior_ is what Plan-008 owns canonically. Substrate ships first.

### Tier 1 — Plan-008-Bootstrap (tRPC server + `sessionRouter` + SSE substrate)

Lands alongside Plan-001 to unblock Plan-001 PR #5 (`sessionClient` over the control-plane transport). Scope:

- **tRPC v11 server skeleton** — Fastify host + tRPC v11 router registration scaffolding per [ADR-014](../decisions/014-trpc-control-plane-api.md). Bootstrap ships only the skeleton; relay broker / presence register / invite handlers are Tier 5.
- **`sessionRouter` HTTP handlers** — typed tRPC procedures for `SessionCreate`, `SessionRead`, `SessionJoin` exposing the existing `packages/control-plane/src/sessions/session-directory-service.ts` (already shipped in Plan-001 PR #4). The router wraps the service; it does not re-implement directory logic.
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

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/session-join/`
- `packages/control-plane/src/sessions/session-join-service.ts`
- `packages/control-plane/src/relay/relay-broker-service.ts`
- `packages/control-plane/src/presence/presence-register-service.ts`
- `packages/client-sdk/src/sessionJoinClient.ts`
- `apps/desktop/renderer/src/session-join/`
- `apps/cli/src/session-join/`

## Data And Storage Changes

- Add shared join, reconnect, and relay-negotiation records needed to correlate membership, presence, and relay attempts.
- Extend presence history with reconnect-association metadata where needed for duplicate suppression.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for column definitions.

## API And Transport Changes

- Add `SessionJoin`, `PresenceRegister`, `RelayNegotiation`, and `SessionResumeAfterReconnect` to shared contracts and client SDKs.
- Ensure relay negotiation only exposes the minimum transport data required to establish connectivity.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define authenticated join, presence, reconnect, and relay-negotiation contracts. Include the relay wire format for relay messages.
2. Implement control-plane join and presence services with membership verification and invite-acceptance handoff.
3. Implement relay broker flows and reconnect association logic without coupling them to execution authority. V1 relay encryption uses pairwise X25519 ECDH + XChaCha20-Poly1305 (via `@noble/curves` and `@noble/ciphers`) with Ed25519 signature verification over each participant's ephemeral X25519 key bundle per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md). Relay sharding targets 25 connections per data DO using WebSocket Hibernation for Durable Objects. Relay authentication uses PASETO v4 tokens (per ADR-010).
4. Add desktop and CLI shared-session join surfaces plus typed client SDK integration.

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
