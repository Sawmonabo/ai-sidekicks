# Plan-018: Identity And Participant State

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `018` |
| **Slug** | `identity-and-participant-state` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-018: Identity And Participant State](../specs/018-identity-and-participant-state.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | [Plan-002](./002-invite-membership-and-presence.md) (presence infrastructure); [Plan-025](./025-self-hostable-node-relay.md) steps 1–4 at Tier 5 (provides `packages/crypto-paseto/` PASETO v4.public primitives that Plan-018 imports as the issuer side — symmetric co-dep with Plan-025; see [cross-plan-dependencies.md §5 carve-out](../architecture/cross-plan-dependencies.md)) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement session-scoped participant identity, stable historical authorship, and multi-device presence aggregation for shared collaboration.

## Scope

This plan covers authenticated-identity mapping, participant projection state, device presence fan-out, and stable participant authorship references.

## Non-Goals

- Organization directory sync
- Billing or subscription identity state
- Runtime-node attach internals

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/participants/`
- `packages/control-plane/src/participants/participant-mapping-service.ts`
- `packages/control-plane/src/participants/participant-projection-service.ts`
- `packages/control-plane/src/presence/presence-aggregation-service.ts`
- `packages/client-sdk/src/participantClient.ts`
- `apps/desktop/renderer/src/participants/`
- `apps/cli/src/participants/`

## Data And Storage Changes

- Add shared `participants`, participant-profile projection records, and device-presence or presence-lease storage needed for aggregation.
- Ensure canonical event authorship references stable participant ids rather than mutable display metadata.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for column definitions.

## API And Transport Changes

- Add `ParticipantProjectionRead`, `ParticipantStateUpdate`, and `PresenceDetailRead` to shared contracts and the typed client SDK.
- Expose one session-scoped participant identity with aggregated presence plus optional authorized device detail.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define participant-id, authorship, projection, and device-presence contracts in shared packages.
2. Implement control-plane participant mapping from authenticated identity into one canonical participant record per session.
3. Implement presence aggregation, display-state updates, and stable historical authorship projection.
4. Add desktop and CLI participant surfaces for aggregated presence and session-scoped participant state.

## Parallelization Notes

- Participant mapping and presence aggregation can proceed in parallel once id and authorship contracts are fixed.
- Client surfaces should wait for aggregated-status precedence rules and device-detail authorization to stabilize.

## Test And Verification Plan

- Multi-device presence tests proving one authenticated identity still yields one participant per session
- Historical authorship tests proving display-name changes do not rewrite prior events
- Fallback-profile tests proving stable placeholder identity works when profile metadata is incomplete

## Rollout Order

1. Land participant and authorship contracts plus shared persistence
2. Enable presence aggregation and participant projection reads
3. Enable participant display-state editing and device-detail reads where authorized

## Rollback Or Fallback

- Hide device-level detail and keep only aggregated participant presence if device fan-out semantics regress.

## Risks And Blockers

- Guest or anonymous identity support remains unresolved for the first implementation
- Presence aggregation can become misleading if conflicting device activity is not handled conservatively

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
