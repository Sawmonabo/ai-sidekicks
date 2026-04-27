# Spec-003: Runtime Node Attach

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**              | `approved`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **NNN**                 | `003`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Slug**                | `runtime-node-attach`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Date**                | `2026-04-14`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Author(s)**           | `Codex`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Depends On**          | [Runtime Node Model](../domain/runtime-node-model.md), [Session Model](../domain/session-model.md), [Participant And Membership Model](../domain/participant-and-membership-model.md), [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md), [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md), [Shared Session Core](../specs/001-shared-session-core.md) |
| **Implementation Plan** | [Plan-003: Runtime Node Attach](../plans/003-runtime-node-attach.md)                                                                                                                                                                                                                                                                                                                                                                              |

## Purpose

Define how a participant attaches one of their local runtime nodes to a live session.

## Scope

This spec covers runtime-node registration, capability declaration, health, and detach or reconnect behavior.

## Non-Goals

- Driver-specific provider protocol details
- Detailed membership invite behavior
- Detailed queue and run semantics

## Domain Dependencies

- [Runtime Node Model](../domain/runtime-node-model.md)
- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Session Model](../domain/session-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)
- [ADR-001: Session Is The Primary Domain Object](../decisions/001-session-is-the-primary-domain-object.md)
- [ADR-002: Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [ADR-005: Provider Drivers Use A Normalized Interface](../decisions/005-provider-drivers-use-a-normalized-interface.md)
- [ADR-007: Collaboration Trust And Permission Model](../decisions/007-collaboration-trust-and-permission-model.md)
- [ADR-018: Cross-Version Compatibility](../decisions/018-cross-version-compatibility.md)

## Required Behavior

- A participant with active session membership must be able to attach a local runtime node to an existing live session.
- Runtime-node attach must be a separate step from membership acceptance.
- Attach must include node identity, declared capabilities, health, and trust context.
- The system must support multiple runtime nodes per session and multiple agents per runtime node.
- Runtime-node attach must not require session recreation.
- Runtime-node detach or offline state must not revoke session membership by default.
- The control plane must coordinate runtime-node discovery and presence, but execution must remain local to the attached node.
- At attach, the control plane MUST verify the daemon's reported version against the session's `min_client_version` floor (declared in [Spec-001 §State And Data Implications](./001-shared-session-core.md#state-and-data-implications)). A NULL floor permits all daemons. A daemon below the floor MUST be admitted in read-only state — the daemon remains joined and may read session state, but any subsequent write attempt MUST return typed `VERSION_FLOOR_EXCEEDED` per [ADR-018 §Decision #4](../decisions/018-cross-version-compatibility.md). Ejection MUST NOT be the response to a floor mismatch (graceful degradation, not ejection).

## Default Behavior

- Newly attached runtime nodes default to `online` only after capability declaration succeeds.
- Node capability exposure defaults to least privilege: only explicitly declared capabilities are schedulable.
- Runtime-node heartbeats default to `15s`, matching participant presence cadence unless overridden.

## Fallback Behavior

- If attach completes but capability validation fails, the node must remain attached in `degraded` or `offline` state rather than being treated as healthy.
- If the control plane cannot broker collaborative visibility, the local daemon may remain usable for `local-only` execution on that participant machine.
- If a previously attached node disconnects, active membership remains intact and the node may later reconnect under the same node identity.

## Interfaces And Contracts

- `RuntimeNodeAttach` must include session id, participant id, node id, capability declarations, and health metadata.
- `RuntimeNodeHeartbeat` must update presence and health.
- `RuntimeNodeCapabilityUpdate` must support capability additions, removals, and health changes.
- `RuntimeNodeDetach` must explicitly retire or disconnect a node from the session.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Runtime-node records must be durable enough to support reconnect and audit.
- Capability declarations and trust posture changes must be emitted as session events.
- Node health changes must not rewrite historical run provenance.

## Example Flows

- `Example: A participant joins a live session, attaches a local runtime node that exposes Codex and Claude drivers, and later creates a reviewer agent on that node.`
- `Example: A node loses provider access and becomes degraded while session membership remains active and readable by other participants.`

## Implementation Notes

- Attach should be fast enough to feel interactive, but node health must not flip to healthy before capability validation completes.
- Node identity must be stable across reconnect if the same local daemon is reattaching.
- Scheduling logic must read node capability and health, not just membership role.

## Pitfalls To Avoid

- Treating membership as automatic node trust
- Allowing implicit capability exposure on attach
- Destroying historical node provenance when a node reconnects

## Acceptance Criteria

- [ ] A participant can attach a local runtime node to an already active session.
- [ ] A degraded or offline node remains distinguishable from a healthy online node.
- [ ] Multiple runtime nodes can coexist in one session without changing session identity.
- [ ] A daemon attaching with a version below the session's `min_client_version` is admitted in read-only state, surfaces typed `VERSION_FLOOR_EXCEEDED` on any subsequent write attempt, and is never ejected for the floor mismatch (per [ADR-018 §Decision #4](../decisions/018-cross-version-compatibility.md)).

## ADR Triggers

- If attach requires a fundamentally different remote-execution model, create or update `../decisions/002-local-execution-shared-control-plane.md`.
- If transport and relay rules materially change, create or update `../decisions/008-default-transports-and-relay-boundaries.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: a runtime node may participate in one active session at a time in v1. Multi-session sharing is deferred.

## References

- [Runtime Node Model](../domain/runtime-node-model.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
