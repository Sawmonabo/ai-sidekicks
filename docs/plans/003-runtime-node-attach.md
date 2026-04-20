# Plan-003: Runtime Node Attach

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `003` |
| **Slug** | `runtime-node-attach` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-003: Runtime Node Attach](../specs/003-runtime-node-attach.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-018](../decisions/018-cross-version-compatibility.md) |
| **Dependencies** | [Plan-001](./001-shared-session-core.md) (session model); [Spec-024](../specs/024-cross-node-dispatch-and-approval.md) (implicit cross-node dispatch surface per [cross-plan-dependencies.md §Spec-024 V1 Gap](../architecture/cross-plan-dependencies.md#spec-024-v1-gap--implementation-plan-pending)) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement participant-owned RuntimeNode registration and attach into live sessions.

## Scope

This plan covers node identity, capability declaration, presence heartbeat, and attach or detach behavior between the Local Runtime Daemon and the Collaboration Control Plane.

## Non-Goals

- Provider driver internals
- Queue or workflow scheduling
- Cross-session node sharing policy

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/runtimeNode.ts`
- `packages/runtime-daemon/src/node/node-registry.ts`
- `packages/runtime-daemon/src/node/node-capability-service.ts`
- `packages/control-plane/src/runtime-nodes/`
- `packages/client-sdk/src/runtimeNodeClient.ts`
- `apps/desktop/renderer/src/runtime-node-attach/`

## Data And Storage Changes

- Add shared `runtime_node_attachments` and `runtime_node_presence` tables.
- Add local `node_capabilities` and `node_trust_state` persistence.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for column definitions.

## API And Transport Changes

- Add `RuntimeNodeAttach`, `RuntimeNodeHeartbeat`, `RuntimeNodeCapabilityUpdate`, and `RuntimeNodeDetach` to the client SDK and control-plane contracts.
- `RuntimeNodeAttach` payload carries the daemon's `client_version` string; the control plane validates it against `sessions.min_client_version` and rejects below-floor attaches with typed `VERSION_FLOOR_EXCEEDED` per [ADR-018](../decisions/018-cross-version-compatibility.md) §Decision #4. Rejected daemons remain joined in read-only state (graceful degradation), not ejected.

## Event Emission

Plan-003 is the canonical emitter of the 7 `runtime_node.*` events in the `runtime_node_lifecycle` category defined in [Spec-006 §Runtime Node Lifecycle](../specs/006-session-event-taxonomy-and-audit-log.md):

- `runtime_node.registered` — RuntimeNode registered to the daemon registry.
- `runtime_node.online` — RuntimeNode passed presence heartbeat and is attached to a session.
- `runtime_node.degraded` — RuntimeNode is attached but capability health is reduced (missed heartbeats under threshold, partial provider driver failure, etc.).
- `runtime_node.offline` — RuntimeNode missed presence heartbeat beyond threshold; no longer receives dispatch.
- `runtime_node.revoked` — RuntimeNode trust state flipped to `revoked` per [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md); attach is refused.
- `runtime_node.capability_declared` — Initial capability declaration on attach (provider drivers, resource class, version info).
- `runtime_node.capability_updated` — Capability declaration change mid-session (driver added/removed, health change).

The remaining 2 events in the `runtime_node_lifecycle` category — `session.clock_unsynced` and `session.clock_corrected` — describe daemon-host clock state observed at the NTP sync probe and are emitted by [Plan-015 (Persistence, Recovery, Replay)](./015-persistence-recovery-and-replay.md), which owns that probe. These 2 events preserve their `session.*` wire names (category reclassification only, not rename) per [ADR-018](../decisions/018-cross-version-compatibility.md) §Decision #8 (MINOR envelope bumps are additive-only; renaming event types is explicitly forbidden) — a rename would break readers on prior MINOR versions within the same MAJOR. Category moves are safe because the `category` field is a classification facet, not a wire-identity key — readers dispatch on event name.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define node contracts and migration shape.
2. Implement Local Runtime Daemon node registry and capability declaration service; emit the 7 `runtime_node.*` events above through the canonical session-event append path.
3. Implement Collaboration Control Plane RuntimeNode attach and presence services. Attach flow reads `sessions.min_client_version` and rejects below-floor daemons with `VERSION_FLOOR_EXCEEDED`.
4. Add desktop attach flow and session node roster UI.

## Parallelization Notes

- Local node registry and shared control-plane attach services can proceed in parallel.
- Desktop attach UI should wait for stable capability payloads.

## Test And Verification Plan

- Attach and detach integration tests
- Capability update and degraded-node state tests
- Manual verification of joining a live session and attaching a second node

## Rollout Order

1. Ship local node registry and shared attach endpoint
2. Enable heartbeats and node roster
3. Enable desktop attach flow

## Rollback Or Fallback

- Disable shared node attach and preserve `local-only` node usage if attach regressions appear.

## Risks And Blockers

- Stable node identity across reconnect needs careful design
- Capability declarations may drift from actual node health without refresh rules

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
