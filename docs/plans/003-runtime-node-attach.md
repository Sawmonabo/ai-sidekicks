# Plan-003: Runtime Node Attach

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `003` |
| **Slug** | `runtime-node-attach` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-003: Runtime Node Attach](../specs/003-runtime-node-attach.md) |
| **Required ADRs** | [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md) |

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
- [ ] Blocking open questions are resolved or explicitly deferred

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

## API And Transport Changes

- Add `RuntimeNodeAttach`, `RuntimeNodeHeartbeat`, `RuntimeNodeCapabilityUpdate`, and `RuntimeNodeDetach` to the client SDK and control-plane contracts.

## Implementation Steps

1. Define node contracts and migration shape.
2. Implement Local Runtime Daemon node registry and capability declaration service.
3. Implement Collaboration Control Plane RuntimeNode attach and presence services.
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

- Disable shared node attach and preserve local-only node usage if attach regressions appear.

## Risks And Blockers

- Stable node identity across reconnect needs careful design
- Capability declarations may drift from actual node health without refresh rules

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
