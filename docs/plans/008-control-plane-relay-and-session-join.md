# Plan-008: Control Plane Relay And Session Join

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `008` |
| **Slug** | `control-plane-relay-and-session-join` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-008: Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md) |
| **Required ADRs** | [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md), [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | [Plan-001](./001-shared-session-core.md) (session core), [Plan-002](./002-invite-membership-and-presence.md) (invite/presence) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |
| **References** | [Spec-008](../specs/008-control-plane-relay-and-session-join.md) (V1 relay encryption: pairwise X25519 + XChaCha20-Poly1305 per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md); MLS deferred to V1.1) |

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

- Session-join traffic requirements for admin or recovery flows remain unresolved
- Presence duplication is likely if reconnect association is not made authoritative early

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
